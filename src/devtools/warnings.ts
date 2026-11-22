import type { CanopyClient, Schema } from "../client/index.ts"
import { isMatcherSafe } from "../core/matcher/lite.ts"

/** Options of {@link watchMistakes}. */
export interface WarningOptions {
  /** Where warnings go. Defaults to `console.warn`. */
  readonly warn?: (message: string) => void
  /** A query without `limit` that returns at least this many documents is reported. Defaults to 500. */
  readonly largeResult?: number
}

/** The fields of a protocol message the devtools read. */
export interface Frame {
  readonly t?: unknown
  readonly id?: unknown
  readonly c?: unknown
  readonly q?: { readonly filter?: unknown; readonly limit?: unknown }
  readonly s?: unknown
  readonly seq?: unknown
  readonly ct?: unknown
  readonly m?: unknown
  readonly ok?: unknown
  readonly op?: unknown
  readonly err?: { readonly code?: unknown; readonly msg?: unknown }
}

const DENIED = new Set(["CANOPY_POLICY_VIOLATION", "CANOPY_FORBIDDEN"])

/**
 * Reports common mistakes while developing: a subscription without `limit` whose result is large, a
 * query the client cannot evaluate locally (so optimistic writes cannot move documents in or out of it
 * until the server answers), and mutations the server's policies rejected. Each mistake is reported once.
 * Returns a function that stops watching.
 */
export function watchMistakes<DB extends Schema<DB>>(
  typed: CanopyClient<DB>,
  options: WarningOptions = {},
): () => void {
  const client = typed as unknown as CanopyClient
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message)
    })
  const largeResult = options.largeResult ?? 500
  const reported = new Set<string>()
  const once = (key: string, message: string): void => {
    if (reported.has(key)) return
    reported.add(key)
    warn(`[canopy] ${message}`)
  }
  const unlimited = new Map<string, string>()
  const mutations = new Map<string, string>()
  return client.devtools().tap((direction, text) => {
    for (const frame of framesOf(text)) inspect(direction, frame)
  })

  function inspect(direction: "in" | "out", frame: Frame): void {
    if (direction === "out" && frame.t === "sub") {
      const collection = String(frame.c)
      const filter = frame.q?.filter ?? {}
      const shape = `${collection} ${JSON.stringify(filter)}`
      if (frame.q?.limit === undefined) unlimited.set(String(frame.id), shape)
      if (!isMatcherSafe(filter))
        once(
          `unsafe ${shape}`,
          `The query on ${collection} ${JSON.stringify(filter)} uses operators the client cannot evaluate, so optimistic writes do not move documents in or out of it until the server answers.`,
        )
      return
    }
    if (direction === "out" && frame.t === "mut") {
      mutations.set(String(frame.id), `${String(frame.op)} on ${String(frame.c)}`)
      return
    }
    if (direction !== "in") return
    if (frame.t === "ready") {
      const id = String(frame.s)
      const shape = unlimited.get(id)
      if (shape === undefined) return
      unlimited.delete(id)
      const size = client.store.members(id).length
      if (size >= largeResult)
        once(
          `large ${shape}`,
          `The subscription ${shape} has no limit and returned ${size} documents. Add a limit, and a sort, so the result stays small as the collection grows.`,
        )
      return
    }
    if (frame.t === "ack") {
      const id = String(frame.m)
      const what = mutations.get(id)
      mutations.delete(id)
      if (frame.ok === false && DENIED.has(String(frame.err?.code)))
        once(
          `denied ${id}`,
          `The ${what ?? "mutation"} was rolled back: ${String(frame.err?.code)} (${String(frame.err?.msg)}). Check the collection's policies, or simulate the write in Studio.`,
        )
    }
  }
}

/** The messages of one frame: a batch holds several. */
export function framesOf(text: string): Frame[] {
  try {
    const frame = JSON.parse(text) as Frame & { readonly m?: unknown }
    if (frame.t === "batch" && Array.isArray(frame.m)) return frame.m as Frame[]
    return [frame]
  } catch {
    return []
  }
}
