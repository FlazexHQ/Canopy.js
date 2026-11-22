import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createClient,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../../src/client/index.ts"

/** A socket the test drives: it opens on demand and records what the client sends. */
class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  readonly protocol = "canopy.v1+json"
  readonly sent: Record<string, unknown>[] = []
  closedWith: number | undefined
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor() {
    FakeSocket.all.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.closedWith = code
    this.readyState = 3
    this.onclose?.({ code, reason: "" })
  }

  /** Opens and answers the hello with a welcome. */
  async accept(sid = "n1.s"): Promise<void> {
    this.readyState = 1
    this.onopen?.({})
    await vi.waitFor(() => expect(this.sent.some((m) => m["t"] === "hello")).toBe(true))
    this.onmessage?.({
      data: JSON.stringify({
        t: "welcome",
        seq: 0,
        sid,
        v: 1,
        resumed: false,
        hb: 25_000,
        pv: "p",
        ct: "1",
        caps: [],
        limits: { subs: 100 },
      }),
    })
  }

  /** The server side closing the connection. */
  drop(code: number): void {
    this.readyState = 3
    this.onclose?.({ code, reason: "" })
  }
}

const Fake = FakeSocket as unknown as WebSocketConstructor

describe("connection lifecycle", () => {
  const events = new EventTarget()
  let online = true
  const globals = globalThis as Record<string, unknown>

  beforeEach(() => {
    FakeSocket.all = []
    online = true
    globals["addEventListener"] = events.addEventListener.bind(events)
    globals["removeEventListener"] = events.removeEventListener.bind(events)
    Object.defineProperty(globalThis.navigator, "onLine", {
      configurable: true,
      get: () => online,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete globals["addEventListener"]
    delete globals["removeEventListener"]
    Reflect.deleteProperty(globalThis.navigator, "onLine")
  })

  const fire = (type: string): void => {
    events.dispatchEvent(new Event(type))
  }

  it("goes offline at once, queues mutations, and reconnects and sends them when back online", async () => {
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Fake,
    })
    await FakeSocket.all[0]?.accept()
    expect(client.connectionStatus).toBe("live")
    online = false
    fire("offline")
    expect(client.connectionStatus).toBe("offline")
    expect(FakeSocket.all[0]?.closedWith).toBe(4000)
    const handle = client.insert("todos", { _id: 1 })
    expect(client.pendingMutations).toBe(1)
    expect(FakeSocket.all).toHaveLength(1)
    online = true
    fire("online")
    expect(FakeSocket.all).toHaveLength(2)
    const next = FakeSocket.all[1]
    await next?.accept()
    expect(next?.sent.filter((m) => m["t"] === "mut").map((m) => m["id"])).toEqual([
      handle.mutationId,
    ])
    client.close()
  })

  it("does not try to connect while the browser is offline", () => {
    online = false
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Fake,
    })
    expect(client.connectionStatus).toBe("offline")
    expect(FakeSocket.all).toHaveLength(0)
    online = true
    fire("online")
    expect(FakeSocket.all).toHaveLength(1)
    expect(client.connectionStatus).toBe("connecting")
    client.close()
  })

  it("stays offline instead of scheduling retries when a socket drops while offline", async () => {
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Fake,
    })
    await FakeSocket.all[0]?.accept()
    online = false
    FakeSocket.all[0]?.drop(1006)
    expect(client.connectionStatus).toBe("offline")
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(FakeSocket.all).toHaveLength(1)
    client.close()
  })

  it("retries on focus or visibility only when the last attempt is more than 5 s old", async () => {
    vi.useFakeTimers()
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Fake,
    })
    const first = FakeSocket.all[0]
    first?.drop(4029)
    expect(client.connectionStatus).toBe("reconnecting")
    vi.advanceTimersByTime(1000)
    fire("focus")
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(5000)
    fire("visibilitychange")
    expect(FakeSocket.all).toHaveLength(2)
    client.close()
  })

  it("refreshes a long lived token at 80 % of its lifetime, not in a tight loop", async () => {
    vi.useFakeTimers()
    const day = 86_400_000
    const token = (lifetimeMs: number) =>
      `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(
        JSON.stringify({ sub: "u1", exp: Math.floor((Date.now() + lifetimeMs) / 1000) }),
      )}.`
    let current = token(60 * day)
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Fake,
      auth: { getToken: () => current },
    })
    const socket = FakeSocket.all[0]
    if (socket === undefined) throw new Error("no socket")
    const record = socket.send.bind(socket)
    socket.send = (data: string) => {
      record(data)
      const message = JSON.parse(data) as Record<string, unknown>
      if (message["t"] === "ping")
        socket.onmessage?.({ data: JSON.stringify({ t: "pong", ts: message["ts"] }) })
    }
    await socket.accept()
    const auths = () => socket.sent.filter((m) => m["t"] === "auth")
    await vi.advanceTimersByTimeAsync(day)
    expect(auths()).toEqual([])
    await vi.advanceTimersByTimeAsync(46 * day)
    expect(auths()).toEqual([])
    current = token(60 * day)
    await vi.advanceTimersByTimeAsync(2 * day)
    expect(auths()).toEqual([{ t: "auth", token: current }])
    expect(FakeSocket.all).toHaveLength(1)
    client.close()
  })

  it("removes its listeners when closed", () => {
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Fake,
    })
    client.close()
    fire("online")
    fire("offline")
    expect(FakeSocket.all).toHaveLength(1)
    expect(client.connectionStatus).toBe("closed")
  })

  it("can be told to ignore lifecycle events", () => {
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Fake,
      lifecycle: false,
    })
    fire("offline")
    expect(client.connectionStatus).toBe("connecting")
    client.close()
  })
})
