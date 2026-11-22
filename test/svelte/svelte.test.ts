import { CanopyClient, type LiveQuery, type WebSocketLike } from "canopy.js"
import { flushSync, mount, unmount } from "svelte"
import { describe, expect, it } from "vitest"

import { canopyStatus, createQuery } from "../../src/svelte/index.ts"
import { loadVectors, runVector } from "../support/vectors.ts"
import Consumer from "./Consumer.svelte"
import Probe from "./Probe.svelte"
import Provider from "./Provider.svelte"

class Socket implements WebSocketLike {
  static last: Socket | undefined
  readyState = 0
  protocol = "canopy.v1+json"
  readonly sent: Record<string, unknown>[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor() {
    Socket.last = this
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.readyState = 3
  }
  push(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const flush = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await Promise.resolve()
}

describe("protocol vectors through the store contract", () => {
  it.each(loadVectors().map((vector) => [vector.name, vector] as const))(
    "%s",
    async (_name, vector) => {
      await runVector(vector, (client, subscription) => {
        const query = createQuery(
          client.live(
            subscription.c,
            subscription.filter,
            subscription.sort === undefined ? {} : { sort: subscription.sort },
          ),
        )
        let latest = query.current
        const stop = query.subscribe((state) => {
          latest = state
        })
        return { read: () => latest, stop }
      })
    },
  )
})

describe("Svelte 5", () => {
  it("re-renders from the getters and drops the subscription when unmounted", async () => {
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Socket,
      lifecycle: false,
    })
    await flush()
    const socket = Socket.last as Socket
    socket.push({
      t: "welcome",
      seq: 0,
      sid: "s",
      v: 1,
      resumed: false,
      hb: 25000,
      pv: "p",
      ct: "1",
      caps: [],
      limits: {},
    })
    await flush()
    const query = createQuery(client.live("todos", {}) as LiveQuery<{ _id: number }>)
    expect(query.status).toBe("loading")
    expect(socket.sent.filter((m) => m["t"] === "sub")).toHaveLength(0)
    const target = document.createElement("div")
    const component = mount(Probe, { target, props: { query } })
    flushSync()
    expect(target.textContent).toBe("loading:0")
    await flush()
    const sub = socket.sent.find((m) => m["t"] === "sub")?.["id"]
    expect(sub).toBeDefined()
    socket.push({ t: "added", seq: 1, c: "todos", id: 1, d: { _id: 1 }, ct: "2", s: [sub] })
    socket.push({ t: "added", seq: 2, c: "todos", id: 2, d: { _id: 2 }, ct: "2", s: [sub] })
    socket.push({ t: "ready", seq: 3, s: sub, ct: "2" })
    await flush()
    flushSync()
    expect(target.textContent).toBe("ready:2")
    await unmount(component)
    await flush()
    expect(socket.sent.filter((m) => m["t"] === "unsub").map((m) => m["id"])).toEqual([sub])
    const status = canopyStatus(client)
    const seen: string[] = []
    const stop = status.subscribe((value) => seen.push(value))
    client.close()
    stop()
    expect(seen).toEqual(["live", "closed"])
  })

  it("shows a refused subscription as an error and keeps reading after it", async () => {
    const client = await connected()
    const socket = Socket.last as Socket
    const query = createQuery(client.live("secrets", {}) as LiveQuery<{ _id: number }>)
    const target = document.createElement("div")
    const component = mount(Probe, { target, props: { query } })
    flushSync()
    await flush()
    const sub = socket.sent.find((m) => m["t"] === "sub")?.["id"]
    socket.push({
      t: "nosub",
      seq: 1,
      s: sub,
      err: { code: "CANOPY_FORBIDDEN", msg: "Not allowed to read secrets" },
    })
    await flush()
    flushSync()
    expect(query.status).toBe("error")
    expect(query.error?.message).toBe("Not allowed to read secrets")
    expect(target.textContent).toBe("error:0:Not allowed to read secrets")
    await unmount(component)
    client.close()
  })

  it("passes the client down through setCanopy and renders its status", async () => {
    const client = await connected()
    const target = document.createElement("div")
    const component = mount(Provider, { target, props: { client } })
    flushSync()
    expect(target.textContent).toBe("live")
    client.close()
    flushSync()
    expect(target.textContent).toBe("closed")
    await unmount(component)
  })

  it("refuses getCanopy without a client from a parent", () => {
    const target = document.createElement("div")
    expect(() => mount(Consumer, { target })).toThrow(
      "getCanopy needs setCanopy(client) in a parent component",
    )
  })
})

async function connected(): Promise<CanopyClient> {
  const client = new CanopyClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: Socket,
    lifecycle: false,
  })
  await flush()
  ;(Socket.last as Socket).push({
    t: "welcome",
    seq: 0,
    sid: "s",
    v: 1,
    resumed: false,
    hb: 25000,
    pv: "p",
    ct: "1",
    caps: [],
    limits: {},
  })
  await flush()
  return client
}
