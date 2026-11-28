import { decode, encodeMessage, isErrorCode, stringify } from "canopy.js/protocol"
import { describe, expect, it } from "vitest"

import { CanopyClient, type QueryState, type WebSocketLike } from "../../src/client/index.ts"
import { loadVectors, type Vector } from "../support/vectors.ts"

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | undefined
  readyState = 0
  protocol = "canopy.v1+json"
  readonly sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor() {
    FakeSocket.last = this
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

const vectors: Vector[] = loadVectors()

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe("protocol vectors", () => {
  it("finds the vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(7)
  })

  it.each(vectors.map((vector) => [vector.name, vector] as const))("%s", async (_name, vector) => {
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: FakeSocket,
    })
    await flush()
    const socket = FakeSocket.last
    if (socket === undefined) throw new Error("no socket")
    const states = new Map<string, QueryState>()
    const stops = vector.subscriptions.map((sub, index) =>
      client
        .live(sub.c, sub.filter, sub.sort === undefined ? {} : { sort: sub.sort })
        .subscribe((state) => states.set(`s${index + 1}`, state)),
    )
    for (const step of vector.steps) {
      for (const frame of step.server) socket.onmessage?.({ data: JSON.stringify(frame) })
      await flush()
      for (const [id, expected] of Object.entries(step.expect)) {
        const state = states.get(id)
        expect(state?.status, `${vector.name} ${id} status`).toBe(expected.status)
        expect(stringify(state?.data), `${vector.name} ${id} data`).toBe(
          JSON.stringify(expected.data),
        )
        if (expected.error !== undefined) {
          const code = (state?.error as { code?: unknown } | undefined)?.code
          expect(isErrorCode(code) ? code : undefined).toBe(expected.error)
        }
      }
      if (step.sent !== undefined) {
        expect(
          socket.sent
            .map((text) => (JSON.parse(text) as { t: string }).t)
            .filter((t) => t !== "ping"),
        ).toEqual(step.sent)
      }
    }
    for (const stop of stops) stop()
    client.close()
  })

  it("returns one stable loading snapshot until data arrives", async () => {
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: FakeSocket,
    })
    await flush()
    const query = client.live("t", { done: false })
    const before = query.getState()
    expect(before.status).toBe("loading")
    expect(query.getState()).toBe(before)
    const other = client.live("u", {})
    expect(other.getState()).toBe(before)
    const stop = query.subscribe(() => {})
    const subscribed = query.getState()
    expect(subscribed.status).toBe("loading")
    expect(query.getState()).toBe(subscribed)
    stop()
    client.close()
  })

  it("keeps reconnecting when the server drains, even after its own close event arrives", async () => {
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: FakeSocket,
    })
    await flush()
    const socket = FakeSocket.last as FakeSocket
    const statuses: string[] = []
    client.onStatus((status) => statuses.push(status))
    let state: QueryState | undefined
    client.live("t", {}).subscribe((next) => {
      state = next
    })
    const send = (frame: Record<string, unknown>): void =>
      socket.onmessage?.({ data: encodeMessage(decode(frame) as never) })
    send({
      t: "welcome",
      seq: 0,
      sid: "n",
      v: 1,
      resumed: false,
      hb: 25000,
      pv: "",
      ct: "1",
      caps: [],
      limits: { subs: 1 },
    })
    send({ t: "ready", seq: 1, s: "s1", ct: "1" })
    await flush()
    expect(client.connectionStatus).toBe("live")
    send({ t: "reconnect", seq: 2, retryAfterMs: 0, reason: "shutdown" })
    expect(socket.readyState).toBe(3)
    socket.onclose?.({ code: 1000, reason: "server asked to reconnect" })
    expect(client.connectionStatus).toBe("reconnecting")
    await flush()
    expect(state?.status).toBe("stale")
    const started = Date.now()
    while (FakeSocket.last === socket && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(FakeSocket.last).not.toBe(socket)
    expect(statuses).not.toContain("closed")
    client.close()
  })

  it("keeps document identity for unchanged rows (structural sharing)", async () => {
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: FakeSocket,
    })
    await flush()
    const socket = FakeSocket.last as FakeSocket
    let state: QueryState | undefined
    client.live("t", {}).subscribe((next) => {
      state = next
    })
    const send = (frame: Record<string, unknown>): void =>
      socket.onmessage?.({ data: encodeMessage(decode(frame) as never) })
    send({
      t: "welcome",
      seq: 0,
      sid: "n",
      v: 1,
      resumed: false,
      hb: 25000,
      pv: "",
      ct: "1",
      caps: [],
      limits: { subs: 1 },
    })
    send({ t: "added", seq: 1, c: "t", id: 1, d: { _id: 1 }, ct: "1", s: ["s1"] })
    send({ t: "added", seq: 2, c: "t", id: 2, d: { _id: 2 }, ct: "1", s: ["s1"] })
    send({ t: "ready", seq: 3, s: "s1", ct: "1" })
    await flush()
    const first = state?.data[0]
    send({ t: "changed", seq: 4, c: "t", id: 2, ct: "2", set: { x: 1 } })
    await flush()
    expect(state?.data[0]).toBe(first)
    expect(state?.data[1]).toEqual({ _id: 2, x: 1 })
    client.close()
  })
})
