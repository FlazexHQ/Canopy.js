import { CanopyClient, type DocumentSchema, type WebSocketLike } from "canopy.js"
import { createRoot, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"

import {
  CanopyContext,
  CanopyProvider,
  createCanopyStatus,
  createQuery,
  useCanopy,
} from "../../src/solid/index.ts"
import { loadVectors, runVector } from "../support/vectors.ts"

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

const newClient = (): CanopyClient =>
  new CanopyClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: Socket,
    lifecycle: false,
  })

describe("protocol vectors through createQuery", () => {
  it.each(loadVectors().map((vector) => [vector.name, vector] as const))(
    "%s",
    async (_name, vector) => {
      await runVector(vector, (client, subscription) =>
        createRoot((dispose) => {
          const query = createQuery(
            client.live(
              subscription.c,
              subscription.filter,
              subscription.sort === undefined ? {} : { sort: subscription.sort },
            ),
          )
          return { read: query.state, stop: dispose }
        }),
      )
    },
  )
})

describe("Solid", () => {
  it("follows an accessor's query and releases it with the root", async () => {
    const client = newClient()
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
    const [owner, setOwner] = createSignal("alice")
    const { query, dispose, status } = createRoot((dispose) => ({
      query: createQuery(() => client.live("todos", { ownerId: owner() })),
      status: createCanopyStatus(client),
      dispose,
    }))
    await flush()
    expect(status()).toBe("live")
    const subs = () => socket.sent.filter((m) => m["t"] === "sub")
    const first = subs()[0]?.["id"]
    socket.push({
      t: "added",
      seq: 1,
      c: "todos",
      id: 1,
      d: { _id: 1, ownerId: "alice" },
      ct: "2",
      s: [first],
    })
    socket.push({ t: "ready", seq: 2, s: first, ct: "2" })
    await flush()
    expect(query.status()).toBe("ready")
    expect(query.data()).toEqual([{ _id: 1, ownerId: "alice" }])
    setOwner("bob")
    await flush()
    expect(socket.sent.filter((m) => m["t"] === "unsub").map((m) => m["id"])).toEqual([first])
    expect(subs().at(-1)?.["q"]).toEqual({ filter: { ownerId: "bob" } })
    expect(query.status()).toBe("loading")
    dispose()
    await flush()
    expect(socket.sent.filter((m) => m["t"] === "unsub")).toHaveLength(2)
    client.close()
  })

  it("shows a refused subscription through the error accessor", async () => {
    const client = newClient()
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
    const { query, dispose } = createRoot((dispose) => ({
      query: createQuery(client.live("secrets", {})),
      dispose,
    }))
    await flush()
    expect(query.error()).toBeUndefined()
    const sub = socket.sent.find((m) => m["t"] === "sub")?.["id"]
    socket.push({
      t: "nosub",
      seq: 1,
      s: sub,
      err: { code: "CANOPY_FORBIDDEN", msg: "Not allowed to read secrets" },
    })
    await flush()
    expect(query.status()).toBe("error")
    expect(query.error()?.message).toBe("Not allowed to read secrets")
    expect(query.state().error).toBe(query.error())
    dispose()
    client.close()
  })

  it("reads the client from context", () => {
    const client = newClient()
    let found: unknown
    createRoot((dispose) => {
      CanopyContext.Provider({
        value: client,
        get children() {
          found = useCanopy()
          return null
        },
      })
      dispose()
    })
    expect(found).toBe(client)
    expect(() => createRoot(() => useCanopy())).toThrow(/CanopyProvider/)
    client.close()
  })

  it("provides a typed client through CanopyProvider", () => {
    type Typed = DocumentSchema<{ todos: { readonly _id: string; title: string } }>
    const client = new CanopyClient<Typed>({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Socket,
      lifecycle: false,
    })
    let found: CanopyClient<Typed> | undefined
    let status: string | undefined
    createRoot((dispose) => {
      CanopyProvider({
        client,
        get children() {
          found = useCanopy<Typed>()
          status = createCanopyStatus<Typed>()()
          return null
        },
      })
      dispose()
    })
    expect(found).toBe(client)
    expect(status).toBe(client.connectionStatus)
    client.close()
  })
})
