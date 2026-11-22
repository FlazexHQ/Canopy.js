import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CollectionBuilder,
  createClient,
  type Document,
  QueryBuilder,
} from "../../src/client/index.ts"
import { Server, ServerSocket } from "./support.ts"

afterEach(() => {
  for (const socket of ServerSocket.all) socket.close()
  ServerSocket.all.length = 0
  vi.restoreAllMocks()
})

async function connected() {
  const client = createClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: Server,
  })
  const socket = ServerSocket.all.at(-1)
  if (socket === undefined) throw new Error("the client opened no socket")
  await socket.accept()
  return { client, socket }
}

describe("collections and read queries", () => {
  it("names the collection and writes to it without a warning", async () => {
    const { client, socket } = await connected()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const todos = client.from("todos")
    expect(todos.name).toBe("todos")
    void todos.updateMany({ done: false }, { $set: { done: true } })
    expect(socket.of("mut").map((message) => message["args"])).toEqual([
      { filter: { done: false }, update: { $set: { done: true } }, bulk: true },
    ])
    expect(warn).not.toHaveBeenCalled()
    client.close()
  })

  it("replaces the filter on a second find instead of combining them", async () => {
    const { client, socket } = await connected()
    const query = client.from("todos").find({ done: false }).find({ owner: "a" })
    query.subscribe(() => {})
    await vi.waitFor(() => expect(socket.of("sub")).toHaveLength(1))
    const [sub] = socket.of("sub")
    expect((sub?.["q"] as { filter?: Document } | undefined)?.filter).toEqual({ owner: "a" })
    client.close()
  })

  it("gives a derived query no write methods, so plain JavaScript cannot write through it", async () => {
    const { client, socket } = await connected()
    const todos = client.from("todos")
    expect(todos).toBeInstanceOf(CollectionBuilder)
    const methods = [
      "insert",
      "insertMany",
      "update",
      "replace",
      "delete",
      "updateMany",
      "deleteMany",
    ]
    for (const derived of [
      todos.find({ done: true }),
      todos.sort({ title: 1 }),
      todos.limit(1),
      todos.fields({ title: 1 }),
      todos.find({ done: true }).limit(1).sort({ title: -1 }),
    ]) {
      expect(derived).toBeInstanceOf(QueryBuilder)
      expect(derived).not.toBeInstanceOf(CollectionBuilder)
      const untyped = derived as unknown as Record<string, unknown>
      for (const method of methods) expect(untyped[method]).toBeUndefined()
      expect(() =>
        (untyped["updateMany"] as (...args: unknown[]) => unknown)({}, { $set: { done: false } }),
      ).toThrow(TypeError)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(socket.of("mut")).toEqual([])
    client.close()
  })
})
