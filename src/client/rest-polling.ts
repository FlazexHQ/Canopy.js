import type { FallbackTransport } from "./client-types.ts"
import { type Frame, HttpSocket } from "./http-socket.ts"

interface PolledQuery {
  readonly c: string
  readonly q: Record<string, unknown>
  tag: string | null
  ids: Map<string, unknown>
}

const MUTATION_OPS = new Set(["insert", "insertMany", "update", "replace", "delete"])

/**
 * Fallback syncing over the REST API: each live query is refetched on an interval with `If-None-Match`,
 * so an unchanged result costs a `304`; mutations go through `_batch` with their mutation IDs, so they
 * stay idempotent.
 */
class RestSocket extends HttpSocket {
  private seq = 0
  private readonly queries = new Map<string, PolledQuery>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly intervalMs: number

  constructor(base: string, fetchImpl: typeof fetch, intervalMs: number) {
    super(base, fetchImpl)
    this.intervalMs = intervalMs
  }

  private emit(frame: Frame): void {
    this.seq += 1
    this.deliver({ ...frame, seq: this.seq })
  }

  protected handle(message: Frame): void {
    switch (message.t) {
      case "hello":
        this.deliver({
          t: "welcome",
          seq: 0,
          sid: "rest",
          v: 1,
          resumed: false,
          hb: 25_000,
          pv: "",
          ct: "0",
          caps: [],
          limits: {},
        })
        this.timer = setInterval(() => {
          for (const id of this.queries.keys()) void this.refresh(id)
        }, this.intervalMs)
        return
      case "sub":
        this.queries.set(String(message["id"]), {
          c: String(message["c"]),
          q: (message["q"] ?? {}) as Record<string, unknown>,
          tag: null,
          ids: new Map(),
        })
        void this.refresh(String(message["id"]))
        return
      case "unsub":
        this.queries.delete(String(message["id"]))
        this.emit({ t: "nosub", s: message["id"] })
        return
      case "ping":
        this.deliver({ t: "pong", ts: message["ts"] })
        return
      case "mut":
        void this.mutate(message)
        return
      case "bye":
        this.end(1000)
        return
      default:
        return
    }
  }

  protected override end(code: number, reason = ""): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    super.end(code, reason)
  }

  private async get(url: string, tag: string | null): Promise<Response> {
    return this.fetch(url, {
      headers: {
        ...this.headers(),
        ...(tag === null ? {} : { "if-none-match": tag }),
      },
      signal: this.abort.signal,
    })
  }

  private async refresh(id: string): Promise<void> {
    const query = this.queries.get(id)
    if (query === undefined) return
    const { filter, sort, limit, fields } = query.q as {
      filter?: unknown
      sort?: Record<string, number>
      limit?: number
      fields?: Record<string, number>
    }
    const params = new URLSearchParams({ filter: JSON.stringify(filter ?? {}) })
    const list = (spec: Record<string, number>, minus: number) =>
      Object.entries(spec)
        .map(([path, value]) => (value === minus ? `-${path}` : path))
        .join(",")
    if (sort !== undefined && Object.keys(sort).length > 0) params.set("sort", list(sort, -1))
    if (fields !== undefined && Object.keys(fields).length > 0)
      params.set("fields", list(fields, 0))
    params.set("limit", String(Math.min(limit ?? 1000, 1000)))
    const url = `${this.base}/rest/v1/${encodeURIComponent(query.c)}?${params}`
    try {
      const response = await this.get(url, query.tag)
      if (response.status === 304 || this.queries.get(id) !== query) return
      if (response.status === 401) return this.fail(response)
      if (!response.ok) {
        const problem = (await response.json()) as { code?: string; detail?: string }
        this.queries.delete(id)
        this.emit({
          t: "nosub",
          s: id,
          err: { code: problem.code ?? "CANOPY_INTERNAL", msg: problem.detail ?? "" },
        })
        return
      }
      const body = (await response.json()) as { data: Frame[]; ct: string }
      query.tag = response.headers.get("etag")
      const ids = new Map<string, unknown>()
      for (const doc of body.data) {
        ids.set(JSON.stringify(doc["_id"]), doc["_id"])
        this.emit({ t: "added", c: query.c, id: doc["_id"], d: doc, ct: body.ct, s: [id] })
      }
      for (const [key, value] of query.ids)
        if (!ids.has(key)) this.emit({ t: "removed", c: query.c, id: value, ct: body.ct, s: [id] })
      query.ids = ids
      this.emit({ t: "ready", s: id, ct: body.ct })
    } catch {
      // A failed poll (network, an aborted fetch) keeps the last state; the next poll retries.
    }
  }

  private async mutate(message: Frame): Promise<void> {
    const op = String(message["op"])
    const { bulk: _bulk, ...args } = (message["args"] ?? {}) as Record<string, unknown>
    const ack = (fields: Frame): void => this.emit({ t: "ack", m: message["id"], ...fields })
    try {
      const response = await this.fetch(`${this.base}/rest/v1/_batch`, {
        method: "POST",
        headers: {
          ...this.headers(true),
          ...(MUTATION_OPS.has(op) ? {} : { prefer: "bulk=true" }),
        },
        body: JSON.stringify({ ops: [{ op, c: message["c"], ...args, mid: message["id"] }] }),
        signal: this.abort.signal,
      })
      if (!response.ok) return this.fail(response)
      const result = ((await response.json()) as { data: Frame[] }).data[0] ?? {}
      const error = result["error"] as { code?: string; detail?: string } | undefined
      if (error !== undefined) {
        ack({ ok: false, err: { code: error.code ?? "CANOPY_INTERNAL", msg: error.detail ?? "" } })
        return
      }
      const data = result["data"]
      const docs = (Array.isArray(data) ? data : data === null ? [] : [data]).filter(
        (doc): doc is Frame => typeof doc === "object" && doc !== null && "_id" in doc,
      )
      const counts = (MUTATION_OPS.has(op) ? result : (data ?? {})) as Frame
      const matched = Number(counts["matched"] ?? counts["deleted"] ?? docs.length)
      if (
        matched === 0 &&
        (op === "update" || op === "delete" || (op === "replace" && docs.length === 0))
      ) {
        ack({ ok: false, err: { code: "CANOPY_NOT_FOUND", msg: "Document not found" } })
        return
      }
      ack({
        ok: true,
        ct: result["ct"],
        echo: false,
        replayed: result["replayed"] === true,
        res: {
          matched,
          modified: Number(counts["modified"] ?? matched),
          ...(result["ids"] !== undefined
            ? { insertedIds: result["ids"] }
            : op === "insert"
              ? { insertedIds: docs.map((doc) => doc["_id"]) }
              : {}),
          docs,
        },
      })
      for (const [id, query] of this.queries) if (query.c === message["c"]) void this.refresh(id)
    } catch {
      this.end(1006)
    }
  }
}

/**
 * Fallback syncing when realtime is unavailable altogether: live queries refetch over REST every
 * `intervalMs` (10 s by default) and stay `stale`.
 */
export function restPolling(options: { readonly intervalMs?: number } = {}): FallbackTransport {
  return {
    polling: true,
    connect: (url, fetchImpl) => new RestSocket(url, fetchImpl, options.intervalMs ?? 10_000),
  }
}

/** The full ladder below WebSocket: SSE, long-polling, then REST polling. */
export function withRestPolling(
  ladder: { readonly transports: readonly FallbackTransport[] },
  options: { readonly intervalMs?: number } = {},
): { readonly transports: readonly FallbackTransport[] } {
  return { transports: [...ladder.transports, restPolling(options)] }
}
