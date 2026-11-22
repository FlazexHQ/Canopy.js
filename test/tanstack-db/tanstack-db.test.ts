import { createCollection } from "@tanstack/db"
import { CanopyClient, ObjectId, type WebSocketLike } from "canopy.js"
import { describe, expect, it, vi } from "vitest"

import { canopyCollectionOptions, documentKey } from "../../src/tanstack-db/index.ts"

class Socket implements WebSocketLike {
  static last: Socket | undefined
  readyState = 0
  protocol = "canopy.v1+json"
  readonly sent: Record<string, unknown>[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private seq = 0
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
  emit(frame: Record<string, unknown>): void {
    this.seq += 1
    this.onmessage?.({ data: JSON.stringify({ ...frame, seq: this.seq }) })
  }
  of(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message["t"] === type)
  }
}

const flush = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) await Promise.resolve()
}

async function connected(): Promise<{ client: CanopyClient; socket: Socket }> {
  const client = new CanopyClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: Socket,
    lifecycle: false,
  })
  await flush()
  const socket = Socket.last as Socket
  socket.onmessage?.({
    data: JSON.stringify({
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
    }),
  })
  await flush()
  return { client, socket }
}

describe("TanStack DB adapter", () => {
  it("keys documents by _id", () => {
    expect(documentKey(new ObjectId("64a1b2c3d4e5f6a7b8c9d0e1"))).toBe('"64a1b2c3d4e5f6a7b8c9d0e1"')
    expect(documentKey(7)).toBe("7")
    expect(documentKey("a")).toBe("a")
  })

  it("syncs a live query and follows the server's changes", async () => {
    const { client, socket } = await connected()
    const todos = createCollection(
      canopyCollectionOptions({ client, collection: "todos", filter: { done: false }, limit: 50 }),
    )
    const ready = todos.preload()
    await vi.waitFor(() => expect(socket.of("sub")).toHaveLength(1))
    const sub = socket.of("sub")[0]
    expect(sub).toMatchObject({ c: "todos", q: { filter: { done: false }, limit: 50 } })
    socket.emit({
      t: "added",
      c: "todos",
      id: 1,
      d: { _id: 1, title: "a", done: false },
      ct: "2",
      s: [sub?.["id"]],
    })
    socket.emit({
      t: "added",
      c: "todos",
      id: 2,
      d: { _id: 2, title: "b", done: false },
      ct: "2",
      s: [sub?.["id"]],
    })
    socket.emit({ t: "ready", s: sub?.["id"], ct: "2" })
    await ready
    expect(todos.status).toBe("ready")
    expect(todos.toArray.map((doc) => doc["title"]).sort()).toEqual(["a", "b"])
    socket.emit({ t: "changed", c: "todos", id: 2, ct: "3", set: { title: "B" } })
    socket.emit({ t: "removed", c: "todos", id: 1, ct: "3", s: [sub?.["id"]] })
    await vi.waitFor(() => expect(todos.toArray.map((doc) => doc["_id"])).toEqual([2]))
    expect(todos.get("2")).toMatchObject({ _id: 2, title: "B", done: false })
    client.close()
  })

  it("writes through Canopy mutations and rolls back what the server refuses", async () => {
    const { client, socket } = await connected()
    const todos = createCollection(canopyCollectionOptions({ client, collection: "todos" }))
    const ready = todos.preload()
    await vi.waitFor(() => expect(socket.of("sub")).toHaveLength(1))
    const sub = socket.of("sub")[0]?.["id"]
    socket.emit({
      t: "added",
      c: "todos",
      id: 5,
      d: { _id: 5, title: "x", done: false },
      ct: "2",
      s: [sub],
    })
    socket.emit({ t: "ready", s: sub, ct: "2" })
    await ready

    const insert = todos.insert({ _id: 9, title: "new", done: false })
    await vi.waitFor(() => expect(socket.of("mut")).toHaveLength(1))
    const mut = socket.of("mut")[0]
    expect(mut).toMatchObject({
      c: "todos",
      op: "insert",
      args: { doc: { _id: 9, title: "new", done: false } },
    })
    socket.emit({
      t: "added",
      c: "todos",
      id: 9,
      d: { _id: 9, title: "new", done: false },
      ct: "3",
      s: [sub],
    })
    socket.emit({ t: "ack", m: mut?.["id"], ok: true, ct: "3", echo: true })
    await insert.when("settled")
    expect(todos.get("9")).toMatchObject({ _id: 9, title: "new", done: false })

    const update = todos.update("5", (draft) => {
      draft["done"] = true
      delete draft["title"]
    })
    await vi.waitFor(() => expect(socket.of("mut")).toHaveLength(2))
    const second = socket.of("mut")[1]
    expect(second).toMatchObject({
      op: "update",
      args: { id: 5, update: { $set: { done: true }, $unset: { title: "" } } },
    })
    expect(todos.get("5")).toMatchObject({ _id: 5, done: true })
    expect(todos.get("5")?.["title"]).toBeUndefined()
    socket.emit({
      t: "ack",
      m: second?.["id"],
      ok: false,
      err: { code: "CANOPY_POLICY_VIOLATION", msg: "denied" },
    })
    await expect(update.when("settled")).rejects.toMatchObject({ code: "CANOPY_POLICY_VIOLATION" })
    await vi.waitFor(() =>
      expect(todos.get("5")).toMatchObject({ _id: 5, title: "x", done: false }),
    )

    const removal = todos.delete("9")
    await vi.waitFor(() => expect(socket.of("mut")).toHaveLength(3))
    const third = socket.of("mut")[2]
    expect(third).toMatchObject({ op: "delete", args: { id: 9 } })
    socket.emit({ t: "removed", c: "todos", id: 9, ct: "4", s: [sub] })
    socket.emit({ t: "ack", m: third?.["id"], ok: true, ct: "4", echo: true })
    await removal.when("settled")
    expect(todos.has("9")).toBe(false)
    client.close()
  })
})
