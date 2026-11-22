import {
  CanopyError,
  type CanopyErrorOptions,
  canonicalString,
  decode,
  ErrorCode,
  errorFromWire,
  isDocument,
  isErrorCode,
} from "../../core/protocol/index.ts"

/** Where a request gets the user's access token: a token, `null` for anon, or a function asked per request. */
export type RestToken = string | null | undefined | (() => RestTokenValue | Promise<RestTokenValue>)

type RestTokenValue = string | null | undefined

/** How requests reach the Data API. */
export interface RestTransport {
  /** The Canopy base URL, without a trailing slash. */
  readonly base: string
  readonly publishableKey: string
  readonly fetch: typeof fetch
  /** The access token of the next request, or `undefined` to read as `anon`. */
  token(): Promise<string | undefined>
  /** Rejects a request that takes longer, with `CANOPY_TIMEOUT`. */
  readonly timeoutMs: number | undefined
}

/** One request to the Data API. */
export interface RestCall {
  readonly method: "GET" | "POST" | "PATCH"
  /** The path below the base URL, already encoded. */
  readonly path: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal | undefined
}

/** Builds the token getter of a transport from the `token` option or a token source. */
export function tokenGetter(
  token: RestToken,
  source: { readonly getToken: () => RestTokenValue | Promise<RestTokenValue> } | undefined,
): () => Promise<string | undefined> {
  return async () => {
    const value =
      typeof token === "function"
        ? await token()
        : token !== undefined
          ? token
          : await source?.getToken()
    return typeof value === "string" && value !== "" ? value : undefined
  }
}

/** The path segment of an `_id`: canonical Extended JSON, so every BSON type reads back exactly. */
export function idSegment(id: unknown): string {
  return encodeURIComponent(canonicalString(id))
}

function requestIdOf(
  response: Response,
  body: Record<string, unknown> | undefined,
): string | undefined {
  const fromBody = body?.["requestId"]
  if (typeof fromBody === "string") return fromBody
  return response.headers.get("x-request-id") ?? undefined
}

/**
 * The error of a failed response. Problem Details keep their Canopy code (as the matching subclass), their
 * detail message, hint, safe details and the request ID (`details.requestId`); anything else becomes
 * `CANOPY_UNAVAILABLE` with the HTTP status.
 */
export async function responseError(response: Response): Promise<CanopyError> {
  let body: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (isDocument(parsed)) body = parsed
  } catch {
    // Not JSON: fall through to the generic error for the status.
  }
  return problemError(body, response.status, requestIdOf(response, body))
}

/**
 * The error of a Problem Details body, such as one operation's error in a batch: its Canopy code (as the
 * matching subclass), detail message, hint, safe details and request ID, or `CANOPY_UNAVAILABLE` with the
 * HTTP status when the body is not a Canopy problem.
 */
export function problemError(
  problem: unknown,
  status: number,
  fallbackRequestId?: string,
): CanopyError {
  const body = isDocument(problem) ? problem : undefined
  const fromBody = body?.["requestId"]
  const requestId = typeof fromBody === "string" ? fromBody : fallbackRequestId
  const code = body?.["code"]
  if (body !== undefined && typeof code === "string" && isErrorCode(code)) {
    const detail = body["detail"]
    const details = body["details"]
    const hint = body["hint"]
    const options: CanopyErrorOptions = {
      details: {
        ...(isDocument(details) ? details : {}),
        status,
        ...(requestId === undefined ? {} : { requestId }),
      },
      ...(typeof hint === "string" ? { hint } : {}),
    }
    const title = body?.["title"]
    return errorFromWire(
      {
        code,
        msg: typeof detail === "string" ? detail : typeof title === "string" ? title : `${status}`,
      },
      options,
    )
  }
  return new CanopyError(ErrorCode.Unavailable, `Canopy answered ${status}`, {
    details: { status, ...(requestId === undefined ? {} : { requestId }) },
  })
}

function timeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { readonly signal: AbortSignal | undefined; readonly timedOut: () => boolean; stop(): void } {
  if (timeoutMs === undefined) return { signal, timedOut: () => false, stop: () => {} }
  const controller = new AbortController()
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    controller.abort(
      new CanopyError(ErrorCode.Timeout, `The request took more than ${timeoutMs} ms`),
    )
  }, timeoutMs)
  const forward = (): void => controller.abort(signal?.reason)
  if (signal?.aborted === true) forward()
  else signal?.addEventListener("abort", forward, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => fired,
    stop: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", forward)
    },
  }
}

/**
 * Sends one request and returns its decoded Extended JSON body. Rejects with the caller's abort reason when
 * `signal` aborts, `CANOPY_TIMEOUT` past `timeoutMs`, `CANOPY_UNAVAILABLE` when the server cannot be
 * reached, and the server's typed error for a Problem Details response.
 */
export async function send(transport: RestTransport, call: RestCall): Promise<unknown> {
  call.signal?.throwIfAborted()
  const access = await transport.token()
  call.signal?.throwIfAborted()
  const timer = timeoutSignal(call.signal, transport.timeoutMs)
  try {
    let response: Response
    try {
      response = await transport.fetch(`${transport.base}${call.path}`, {
        method: call.method,
        headers: {
          apikey: transport.publishableKey,
          accept: "application/ejson",
          ...(call.body === undefined ? {} : { "content-type": "application/json" }),
          ...(access === undefined ? {} : { authorization: `Bearer ${access}` }),
          ...call.headers,
        },
        ...(call.body === undefined ? {} : { body: canonicalString(call.body) }),
        ...(timer.signal === undefined ? {} : { signal: timer.signal }),
      })
    } catch (error: unknown) {
      if (timer.timedOut())
        throw new CanopyError(
          ErrorCode.Timeout,
          `The request took more than ${transport.timeoutMs} ms`,
        )
      if (call.signal?.aborted === true) throw call.signal.reason
      throw new CanopyError(ErrorCode.Unavailable, "Canopy could not be reached", { cause: error })
    }
    if (!response.ok) throw await responseError(response)
    let text: string
    try {
      text = await response.text()
    } catch (error: unknown) {
      if (timer.timedOut())
        throw new CanopyError(
          ErrorCode.Timeout,
          `The request took more than ${transport.timeoutMs} ms`,
        )
      if (call.signal?.aborted === true) throw call.signal.reason
      throw new CanopyError(ErrorCode.Unavailable, "The response was cut off", { cause: error })
    }
    try {
      return decode(JSON.parse(text))
    } catch (error: unknown) {
      throw new CanopyError(ErrorCode.ProtocolError, "The response is not Extended JSON", {
        cause: error,
      })
    }
  } finally {
    timer.stop()
  }
}
