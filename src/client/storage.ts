import { CanopyError, ErrorCode, errorFromWire, isErrorCode } from "../core/protocol/index.ts"
import type { TokenSource } from "./client-types.ts"

/** What the server stores about a file. */
export interface StorageObject {
  readonly bucket: string
  readonly path: string
  readonly size: number
  readonly contentType: string
  readonly etag: string
  readonly owner: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly updatedAt: string
}

/** Options of an upload. */
export interface UploadFileOptions {
  /** Defaults to the type of a `Blob`, else `application/octet-stream`. */
  readonly contentType?: string
  /** Replace a file that exists at the path. @default false */
  readonly upsert?: boolean
  /** Stored with the file; storage policies can read it. */
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

/** Options of a resumable upload. */
export interface ResumableUploadOptions extends UploadFileOptions {
  /** Called after every stored part with the bytes stored so far and the total. */
  readonly onProgress?: (sent: number, total: number) => void
  /** Called once the server created the upload, with the id that resumes it after a failure. */
  readonly onStart?: (id: string) => void
  /** Continue this upload instead of starting a new one: parts the server already has are skipped. */
  readonly resume?: string
  /** Attempts per part before the upload fails (it can still be resumed). @default 3 */
  readonly retries?: number
}

/**
 * An image transformation applied on the server: resize to `width` and `height` (one keeps the aspect
 * ratio), fit with `resize`, and encode as `format` with `quality`. Works for JPEG, PNG, WebP, AVIF, GIF and
 * BMP files.
 */
export interface ImageTransformOptions {
  readonly width?: number
  readonly height?: number
  /** `cover` crops to fill the box, `contain` fits inside it, `fill` stretches. @default "cover" */
  readonly resize?: "cover" | "contain" | "fill"
  /** From 20 to 100. @default 80 */
  readonly quality?: number
  /** @default "origin", the format of the file */
  readonly format?: "origin" | "webp" | "avif" | "jpeg" | "png"
}

/** The query string of a transformation, in a fixed order so equal transformations share a URL. */
function transformQuery(transform: ImageTransformOptions): URLSearchParams {
  const query = new URLSearchParams()
  for (const name of ["width", "height", "resize", "quality", "format"] as const) {
    const value = transform[name]
    if (value !== undefined) query.set(name, String(value))
  }
  return query
}

/** A page of {@link BucketApi.list}. */
export interface StorageList {
  readonly data: readonly StorageObject[]
  /** Pass as `after` for the next page; absent on the last one. */
  readonly next?: string
}

/** The files of one bucket. */
export interface BucketApi {
  /** Stores a file in one request (up to the bucket's size limit). */
  upload(
    path: string,
    body: Blob | Uint8Array | string,
    options?: UploadFileOptions,
  ): Promise<StorageObject>
  /**
   * Stores a large file in parts, any of which can be retried; an interrupted upload continues with
   * `resume` and the id `onStart` reported.
   */
  uploadResumable(
    path: string,
    body: Blob | Uint8Array,
    options?: ResumableUploadOptions,
  ): Promise<StorageObject>
  /** Reads a file, a byte range of it, or a transformed image. */
  download(
    path: string,
    options?: {
      readonly range?: readonly [number, number]
      readonly transform?: ImageTransformOptions
      readonly signal?: AbortSignal
    },
  ): Promise<Blob>
  remove(path: string): Promise<void>
  list(options?: {
    readonly prefix?: string
    readonly limit?: number
    readonly after?: string
  }): Promise<StorageList>
  /** A URL anyone can read the file (or a transformed image of it) with, for `expiresIn` seconds. */
  createSignedUrl(
    path: string,
    expiresIn: number,
    options?: { readonly transform?: ImageTransformOptions },
  ): Promise<string>
  /** The URL of a file in a public bucket, or of a transformed image of it. */
  publicUrl(
    path: string,
    options?: { readonly download?: boolean | string; readonly transform?: ImageTransformOptions },
  ): string
}

/** Options of {@link createStorage}. */
export interface StorageClientOptions {
  /** The Canopy base URL, for example `https://api.example.com`. */
  readonly url: string
  readonly publishableKey: string
  readonly auth?: TokenSource
  readonly fetch?: typeof fetch
}

/** File storage at `/storage/v1`. */
export interface StorageApi {
  from(bucket: string): BucketApi
}

interface UploadState {
  readonly id: string
  readonly size: number
  readonly partSize: number
  readonly partCount: number
  readonly parts: readonly number[]
}

/**
 * The body of a response as a `Blob` typed by its `content-type`. Bun leaves the type of a streamed body
 * empty, where the Fetch standard takes it from the header.
 */
async function blobOf(response: Response): Promise<Blob> {
  const blob = await response.blob()
  const type = response.headers.get("content-type")
  return blob.type === "" && type !== null ? new Blob([blob], { type }) : blob
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

async function failure(response: Response): Promise<CanopyError> {
  try {
    const problem = (await response.json()) as { code?: unknown; detail?: unknown }
    if (typeof problem.code === "string" && isErrorCode(problem.code))
      return errorFromWire({
        code: problem.code,
        msg: typeof problem.detail === "string" ? problem.detail : response.statusText,
      })
  } catch {
    // Not Problem Details: fall through to the generic error for the status.
  }
  return new CanopyError(
    response.status === 404 ? ErrorCode.NotFound : ErrorCode.Unavailable,
    `Storage answered ${response.status}`,
  )
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/**
 * A storage client: uploads (in one request, or resumable in parts), downloads, lists, deletes and signs
 * URLs for the files of a bucket, as the caller the `auth` token names, so storage policies apply.
 */
export function createStorage(options: StorageClientOptions): StorageApi {
  const base = `${options.url.replace(/\/$/, "")}/storage/v1`
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)

  const request = async (
    method: string,
    path: string,
    init: {
      readonly body?: Blob | Uint8Array | string
      readonly headers?: Readonly<Record<string, string>>
      readonly signal?: AbortSignal | undefined
    } = {},
  ): Promise<Response> => {
    const token = await options.auth?.getToken()
    const response = await send(`${base}/${path}`, {
      method,
      headers: {
        apikey: options.publishableKey,
        ...(token === null || token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
    if (!response.ok) throw await failure(response)
    return response
  }
  const json = (body: unknown): Record<string, string> & { body: string } => ({
    body: JSON.stringify(body),
    "content-type": "application/json",
  })

  return {
    from(bucket: string): BucketApi {
      const at = (area: string, path: string): string =>
        `${area}/${encodeURIComponent(bucket)}/${encodePath(path)}`
      return {
        async upload(path, body, upload = {}) {
          const contentType =
            upload.contentType ??
            (typeof Blob !== "undefined" && body instanceof Blob && body.type !== ""
              ? body.type
              : "application/octet-stream")
          const response = await request(
            upload.upsert === true ? "PUT" : "POST",
            at("object", path),
            {
              body,
              headers: {
                "content-type": contentType,
                ...(upload.metadata === undefined
                  ? {}
                  : { "x-metadata": JSON.stringify(upload.metadata) }),
              },
              signal: upload.signal,
            },
          )
          return (await response.json()) as StorageObject
        },
        async uploadResumable(path, body, upload = {}) {
          const blob = body instanceof Uint8Array ? new Blob([body as BlobPart]) : body
          const contentType =
            upload.contentType ?? (blob.type === "" ? "application/octet-stream" : blob.type)
          let state: UploadState
          if (upload.resume === undefined) {
            const { body: text, ...headers } = json({
              size: blob.size,
              contentType,
              upsert: upload.upsert === true,
              ...(upload.metadata === undefined ? {} : { metadata: upload.metadata }),
            })
            state = (await (
              await request("POST", at("upload", path), {
                body: text,
                headers,
                signal: upload.signal,
              })
            ).json()) as UploadState
          } else {
            state = (await (
              await request("GET", `uploads/${encodeURIComponent(upload.resume)}`, {
                signal: upload.signal,
              })
            ).json()) as UploadState
            if (state.size !== blob.size)
              throw new CanopyError(
                ErrorCode.InvalidQuery,
                "The file to resume with is not the size the upload was started with",
              )
          }
          upload.onStart?.(state.id)
          const stored = new Set(state.parts)
          const partBytes = (part: number): number =>
            Math.min(part * state.partSize, state.size) - (part - 1) * state.partSize
          let sent = [...stored].reduce((sum, part) => sum + partBytes(part), 0)
          upload.onProgress?.(sent, state.size)
          for (let part = 1; part <= state.partCount; part += 1) {
            if (stored.has(part)) continue
            const slice = blob.slice((part - 1) * state.partSize, part * state.partSize)
            for (let attempt = 1; ; attempt += 1) {
              try {
                await request("PUT", `uploads/${encodeURIComponent(state.id)}/${part}`, {
                  body: slice,
                  signal: upload.signal,
                })
                break
              } catch (error: unknown) {
                const retryable =
                  !(error instanceof CanopyError) || error.code === ErrorCode.Unavailable
                if (
                  !retryable ||
                  attempt >= (upload.retries ?? 3) ||
                  upload.signal?.aborted === true
                )
                  throw error
                await sleep(500 * 2 ** (attempt - 1), upload.signal)
              }
            }
            sent += partBytes(part)
            upload.onProgress?.(sent, state.size)
          }
          const done = await request("POST", `uploads/${encodeURIComponent(state.id)}/complete`, {
            signal: upload.signal,
          })
          return (await done.json()) as StorageObject
        },
        async download(path, download = {}) {
          if (download.transform !== undefined) {
            const query = transformQuery(download.transform).toString()
            const response = await request(
              "GET",
              `${at("render/image/object", path)}${query === "" ? "" : `?${query}`}`,
              { signal: download.signal },
            )
            return blobOf(response)
          }
          const response = await request("GET", at("object", path), {
            ...(download.range === undefined
              ? {}
              : { headers: { range: `bytes=${download.range[0]}-${download.range[1]}` } }),
            signal: download.signal,
          })
          return blobOf(response)
        },
        async remove(path) {
          await request("DELETE", at("object", path))
        },
        async list(list = {}) {
          const query = new URLSearchParams()
          if (list.prefix !== undefined) query.set("prefix", list.prefix)
          if (list.limit !== undefined) query.set("limit", String(list.limit))
          if (list.after !== undefined) query.set("after", list.after)
          const search = query.toString()
          const response = await request(
            "GET",
            `list/${encodeURIComponent(bucket)}${search === "" ? "" : `?${search}`}`,
          )
          return (await response.json()) as StorageList
        },
        async createSignedUrl(path, expiresIn, signOptions = {}) {
          const { body, ...headers } = json({ expiresIn })
          const response = await request("POST", at("sign", path), { body, headers })
          const { url } = (await response.json()) as { url: string }
          const signed = new URL(url, options.url)
          if (signOptions.transform === undefined) return signed.toString()
          const token = signed.searchParams.get("token") ?? ""
          const query = transformQuery(signOptions.transform)
          query.set("token", token)
          return `${base}/${at("render/image/signed", path)}?${query.toString()}`
        },
        publicUrl(path, publicOptions = {}) {
          const { transform, download } = publicOptions
          const parts = transform === undefined ? [] : [transformQuery(transform).toString()]
          if (download === true) parts.push("download")
          else if (typeof download === "string")
            parts.push(`download=${encodeURIComponent(download)}`)
          const search = parts.filter((part) => part !== "").join("&")
          const area = transform === undefined ? "public" : "render/image/public"
          return `${base}/${at(area, path)}${search === "" ? "" : `?${search}`}`
        },
      }
    },
  }
}
