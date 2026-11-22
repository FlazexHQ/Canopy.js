import { CanopyClient, type WebSocketLike } from "canopy.js"
import { describe, expect, it } from "vitest"
import { createApp, defineComponent, effectScope, h, nextTick, shallowRef } from "vue"

import {
  canopyPlugin,
  provideCanopy,
  useCanopy,
  useCanopyStatus,
  useMutation,
  useQuery,
} from "../../src/vue/index.ts"
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

const WELCOME = {
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
}

const newClient = (): CanopyClient =>
  new CanopyClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: Socket,
    lifecycle: false,
  })

const welcomed = async (): Promise<{ client: CanopyClient; socket: Socket }> => {
  const client = newClient()
  await flush()
  const socket = Socket.last as Socket
  socket.push(WELCOME)
  await flush()
  return { client, socket }
}

const frames = (socket: Socket, type: string) => socket.sent.filter((m) => m["t"] === type)

describe("protocol vectors through useQuery", () => {
  it.each(loadVectors().map((vector) => [vector.name, vector] as const))(
    "%s",
    async (_name, vector) => {
      await runVector(vector, (client, subscription) => {
        const scope = effectScope()
        const refs = scope.run(() =>
          useQuery(
            client.live(
              subscription.c,
              subscription.filter,
              subscription.sort === undefined ? {} : { sort: subscription.sort },
            ),
          ),
        )
        if (refs === undefined) throw new Error("no scope")
        return { read: () => refs.state.value, stop: () => scope.stop() }
      })
    },
  )
})

describe("Vue composables", () => {
  it("moves the subscription when a reactive query changes, and stops with the scope", async () => {
    const { client, socket } = await welcomed()
    const done = shallowRef(false)
    const scope = effectScope()
    const refs = scope.run(() => useQuery(() => client.live("todos", { done: done.value })))
    await flush()
    expect(frames(socket, "sub").map((m) => m["q"])).toEqual([{ filter: { done: false } }])
    const first = frames(socket, "sub")[0]?.["id"]
    socket.push({
      t: "added",
      seq: 1,
      c: "todos",
      id: 1,
      d: { _id: 1, done: false },
      ct: "2",
      s: [first],
    })
    socket.push({ t: "ready", seq: 2, s: first, ct: "2" })
    await flush()
    expect(refs?.status.value).toBe("ready")
    expect(refs?.data.value).toEqual([{ _id: 1, done: false }])
    done.value = true
    await nextTick()
    await flush()
    expect(frames(socket, "unsub").map((m) => m["id"])).toEqual([first])
    expect(frames(socket, "sub").at(-1)?.["q"]).toEqual({ filter: { done: true } })
    expect(refs?.status.value).toBe("loading")
    scope.stop()
    await flush()
    expect(frames(socket, "unsub")).toHaveLength(2)
    client.close()
  })

  it("tracks a mutation's progress and keeps its error", async () => {
    const { client, socket } = await welcomed()
    const scope = effectScope()
    const insert = scope.run(() =>
      useMutation((title: string) => client.insert("todos", { _id: 9, title })),
    )
    const handle = insert?.mutate("x")
    expect(insert?.pending.value).toBe(true)
    await flush()
    const mut = frames(socket, "mut")[0]
    socket.push({
      t: "ack",
      seq: 1,
      m: mut?.["id"],
      ok: false,
      err: { code: "CANOPY_POLICY_VIOLATION", msg: "denied" },
    })
    await expect(handle).rejects.toMatchObject({ code: "CANOPY_POLICY_VIOLATION" })
    await flush()
    expect(insert?.pending.value).toBe(false)
    expect(insert?.error.value?.message).toBe("denied")
    scope.stop()
    client.close()
  })

  it("keeps only the latest call's outcome and its result", async () => {
    const { client, socket } = await welcomed()
    const scope = effectScope()
    const insert = scope.run(() => useMutation((id: number) => client.insert("todos", { _id: id })))
    const first = insert?.mutate(1)
    const second = insert?.mutate(2)
    await flush()
    const [firstMut, secondMut] = frames(socket, "mut")
    socket.push({
      t: "ack",
      seq: 1,
      m: firstMut?.["id"],
      ok: false,
      err: { code: "CANOPY_POLICY_VIOLATION", msg: "stale failure" },
    })
    await expect(first).rejects.toMatchObject({ code: "CANOPY_POLICY_VIOLATION" })
    await flush()
    expect(insert?.pending.value).toBe(true)
    expect(insert?.error.value).toBeUndefined()
    socket.push({
      t: "ack",
      seq: 2,
      m: secondMut?.["id"],
      ok: true,
      ct: "3",
      echo: false,
      res: { matched: 0, modified: 0, docs: [{ _id: 2 }] },
    })
    await expect(second).resolves.toMatchObject({ echo: false })
    await flush()
    expect(insert?.pending.value).toBe(false)
    expect(insert?.error.value).toBeUndefined()
    expect(insert?.result.value).toMatchObject({ echo: false })
    scope.stop()
    client.close()
  })

  it("provides a client to child components and follows its status", async () => {
    const client = newClient()
    let status: { readonly value: string } | undefined
    const Child = defineComponent({
      setup() {
        status = useCanopyStatus()
        return () => h("span")
      },
    })
    const app = createApp({
      setup() {
        provideCanopy(client)
        return () => h(Child)
      },
    })
    app.mount(document.createElement("div"))
    expect(status?.value).toBe("connecting")
    await flush()
    ;(Socket.last as Socket).push(WELCOME)
    await flush()
    expect(status?.value).toBe("live")
    client.close()
    expect(status?.value).toBe("closed")
    app.unmount()
  })

  it("provides a hydrated client to the app", () => {
    const client = newClient()
    let seen: unknown
    let status: unknown
    const app = createApp({
      setup() {
        const canopy = useCanopy()
        const { data } = useQuery(canopy.live("todos", {}))
        seen = data.value
        status = useCanopyStatus().value
        return () => h("p")
      },
    })
    app.use(
      canopyPlugin(client, {
        canopy: 1,
        queries: [{ c: "todos", q: { filter: {} }, docs: [{ _id: 1 }], ct: "3" }],
      }),
    )
    app.mount(document.createElement("div"))
    expect(seen).toEqual([{ _id: 1 }])
    expect(status).toBe("connecting")
    app.unmount()
    client.close()
  })

  it("explains a missing plugin", () => {
    const app = createApp({
      setup() {
        useCanopy()
        return () => h("p")
      },
    })
    app.config.warnHandler = () => {}
    expect(() => app.mount(document.createElement("div"))).toThrow(/canopyPlugin/)
  })
})
