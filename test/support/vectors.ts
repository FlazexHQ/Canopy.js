import { CanopyClient, type QueryState, type WebSocketLike } from "canopy.js"
import { isErrorCode, stringify } from "canopy.js/protocol"
import { expect } from "vitest"

/** One subscription of a protocol vector. */
export interface VectorSubscription {
  readonly c: string
  readonly filter: Record<string, unknown>
  readonly sort?: Record<string, 1 | -1>
}

/** A protocol conformance vector vendored from Canopy into `test/vectors`. */
export interface Vector {
  readonly name: string
  readonly description: string
  readonly subscriptions: readonly VectorSubscription[]
  readonly steps: readonly {
    readonly server: readonly unknown[]
    readonly expect: Readonly<Record<string, { status: string; data: unknown[]; error?: string }>>
    readonly sent?: readonly string[]
  }[]
}

const vectorFiles = import.meta.glob<Vector>("../vectors/*.json", {
  eager: true,
  import: "default",
})

/**
 * Every protocol vector, in file name order. They load through Vite's module graph, so the same code runs on
 * Bun, Node.js, Deno and in browsers.
 */
export function loadVectors(): Vector[] {
  return Object.entries(vectorFiles)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, vector]) => vector)
}

class VectorSocket implements WebSocketLike {
  static last: VectorSocket | undefined
  readyState = 0
  protocol = "canopy.v1+json"
  readonly sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor() {
    VectorSocket.last = this
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }
}

/**
 * How a framework binding follows one subscription of a vector: it starts the binding's query for
 * `subscription` and returns a function that reads the binding's current state, and one that stops it.
 */
export type BindingAdapter = (
  client: CanopyClient,
  subscription: VectorSubscription,
) => { read(): QueryState; stop(): void }

/**
 * Plays a vector through a binding: feeds the server frames to a client and checks, after each step, the
 * state the binding exposes (not the client's), so a binding that drops or reorders updates fails.
 */
export async function runVector(
  vector: Vector,
  adapter: BindingAdapter,
  flush: () => Promise<void> = async () => {
    for (let round = 0; round < 5; round += 1) await Promise.resolve()
  },
): Promise<void> {
  const client = new CanopyClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: VectorSocket,
    lifecycle: false,
  })
  await flush()
  const socket = VectorSocket.last
  if (socket === undefined) throw new Error("no socket")
  const followed = vector.subscriptions.map((subscription) => adapter(client, subscription))
  for (const step of vector.steps) {
    for (const frame of step.server) socket.onmessage?.({ data: JSON.stringify(frame) })
    await flush()
    for (const [id, expected] of Object.entries(step.expect)) {
      const state = followed[Number(id.slice(1)) - 1]?.read()
      expect(state?.status, `${vector.name} ${id} status`).toBe(expected.status)
      expect(stringify(state?.data), `${vector.name} ${id} data`).toBe(
        JSON.stringify(expected.data),
      )
      if (expected.error !== undefined) {
        const code = (state?.error as { code?: unknown } | undefined)?.code
        expect(isErrorCode(code) ? code : undefined).toBe(expected.error)
      }
    }
  }
  for (const entry of followed) entry.stop()
  client.close()
}
