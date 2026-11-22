import { collection, defineSchema, t } from "canopy.js/schema"
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"

import {
  Binary,
  type CanopyClient,
  createClient,
  type Doc,
  type Id,
  type MutationHandle,
  type NewDoc,
  ObjectId,
  type Patch,
} from "../../../src/client/index.ts"
import { createRestClient, type RestClient } from "../../../src/client/rest/index.ts"
import { Server, ServerSocket } from "../support.ts"
import { schema } from "./canopy.schema.ts"

const options = { url: "http://canopy.test", publishableKey: "pk", WebSocket: Server }

afterEach(() => {
  for (const socket of ServerSocket.all) socket.close()
  ServerSocket.all.length = 0
})

async function connected(): Promise<{ client: CanopyClient; socket: ServerSocket }> {
  const client = createClient({ ...options, schema })
  const socket = ServerSocket.all.at(-1)
  if (socket === undefined) throw new Error("the client opened no socket")
  await socket.accept()
  return { client, socket }
}

function sentDocs(socket: ServerSocket): unknown[] {
  return socket.of("mut").map((message) => (message["args"] as { doc?: unknown }).doc)
}

/** Type checks run by `tsc -b` against the registered schema; never called. */
function checks(client: CanopyClient): void {
  expectTypeOf<Doc<"todos">>().toEqualTypeOf<{
    _id: ObjectId
    title: string
    done: boolean
    due: Date | null
    ownerId: string
    tags?: string[]
  }>()
  expectTypeOf<Id<"todos">>().toEqualTypeOf<ObjectId>()
  expectTypeOf<Id<"notes">>().toEqualTypeOf<string>()
  expectTypeOf<Id<"events">>().toEqualTypeOf<Binary>()
  expectTypeOf<Id<"counters">>().toEqualTypeOf<number>()
  expectTypeOf<NewDoc<"todos">["done"]>().toEqualTypeOf<boolean | undefined>()
  expectTypeOf<Patch<"todos">["tags"]>().toEqualTypeOf<string[] | null | undefined>()
  // @ts-expect-error not a registered collection
  type Missing = Doc<"todo">
  void (undefined as unknown as Missing)

  const draft: NewDoc<"todos"> = { title: "Ship", ownerId: "u1", due: null }
  void draft

  const saved = client.from("notes").insert({
    _id: "agenda",
    title: "Agenda",
    body: { text: "", format: "md" },
  })
  expectTypeOf(saved).toEqualTypeOf<MutationHandle<string>>()
  expectTypeOf(client.insert("todos", draft).id).toEqualTypeOf<ObjectId>()
  // @ts-expect-error notes uses caller supplied string ids
  void client.from("notes").insert({ title: "No id", body: { text: "", format: "plain" } })
  // @ts-expect-error not a registered collection
  void client.from("todo")
  // @ts-expect-error the schema option is required once a schema is registered
  void createClient({ url: "http://canopy.test", publishableKey: "pk" })
  const other = defineSchema(collection("todos", { x: t.int() }))
  // @ts-expect-error only the registered schema is accepted
  void createClient({ ...options, schema: other })
  expectTypeOf<Doc<"todos", typeof other>>().toEqualTypeOf<{ _id: ObjectId; x: number }>()

  const rest = createRestClient({ url: "http://canopy.test", publishableKey: "pk", schema })
  expectTypeOf(rest).toEqualTypeOf<RestClient>()
  // @ts-expect-error the REST client needs the registered schema too
  void createRestClient({ url: "http://canopy.test", publishableKey: "pk" })
  const byId = async () => (await rest.from("notes").findById("agenda")).data
  expectTypeOf<Awaited<ReturnType<typeof byId>>>().toEqualTypeOf<Doc<"notes">>()
  // @ts-expect-error notes have string ids
  void rest.from("notes").findById(new ObjectId())
  const titles = async () =>
    (await rest.from("todos").find({ done: false }).fields({ title: 1 }).page()).data
  expectTypeOf<Awaited<ReturnType<typeof titles>>>().toEqualTypeOf<
    readonly { _id: ObjectId; title: string }[]
  >()
}
void checks

/** The read contract fixture: both expectations must be type errors. */
export function checkReadContract(client: CanopyClient): string | undefined {
  const open = client.from("todos").find({ done: false })
  // @ts-expect-error A derived read query has no bulk write method.
  void open.updateMany

  const [todo] = client.live("todos", {}, { fields: { title: 1 } }).getState().data
  if (todo === undefined) return undefined
  // @ts-expect-error The projection omits done.
  void todo.done
  return todo.title
}

describe("a client with the registered schema", () => {
  it("generates the declared ObjectId and fills defaults before the optimistic apply", async () => {
    const { client, socket } = await connected()
    const handle = client.from("todos").insert({ title: "a", ownerId: "u1", due: null })
    expect(handle.id).toBeInstanceOf(ObjectId)
    expect(client.store.view("todos", handle.id)).toMatchObject({
      _id: handle.id,
      title: "a",
      done: false,
      due: null,
    })
    expect(sentDocs(socket)).toEqual([
      {
        _id: { $oid: handle.id.toHexString() },
        title: "a",
        ownerId: "u1",
        due: null,
        done: false,
      },
    ])
    client.close()
  })

  it("generates a UUID for uuid ids", async () => {
    const { client } = await connected()
    const id = client.insert("events", { at: new Date(0) }).id
    expect(id).toBeInstanceOf(Binary)
    expect(id.subType).toBe(4)
    client.close()
  })

  it("refuses a missing caller id before anything is queued", async () => {
    const { client, socket } = await connected()
    const insert = client.insert.bind(client) as (c: string, doc: object) => unknown
    expect(() => insert("notes", { title: "x", body: { text: "", format: "md" } })).toThrow(
      /need an _id/,
    )
    expect(client.pendingMutations).toBe(0)
    expect(socket.of("mut")).toEqual([])
    expect(client.store.pendingLayers).toBe(0)
    client.close()
  })

  it("keeps explicit ids, including numeric zero", async () => {
    const { client, socket } = await connected()
    expect(client.insert("counters", { _id: 0, n: 1 }).id).toBe(0)
    const note = { _id: "a", title: "t", body: { text: "", format: "md" as const } }
    expect(client.insert("notes", note).id).toBe("a")
    expect(sentDocs(socket).map((doc) => (doc as { _id: unknown })._id)).toEqual([0, "a"])
    client.close()
  })

  it("checks every document of insertMany before adding a layer or a queue entry", async () => {
    const { client, socket } = await connected()
    const insertMany = client.insertMany.bind(client) as (c: string, docs: object[]) => unknown
    expect(() =>
      insertMany("notes", [
        { _id: "a", title: "ok", body: { text: "", format: "md" } },
        { title: "no id", body: { text: "", format: "md" } },
      ]),
    ).toThrow(TypeError)
    expect(client.pendingMutations).toBe(0)
    expect(socket.of("mut")).toEqual([])
    expect(client.store.pendingLayers).toBe(0)
    client.close()
  })

  it("prefers the schema's id generator to idTypes", () => {
    const client = createClient({ ...options, schema, idTypes: { todos: "string" } })
    const handle = client.insert("todos", { title: "a", ownerId: "u", due: null })
    expect(handle.id).toBeInstanceOf(ObjectId)
    client.close()
  })

  it("fills defaults on replace without adding an _id to the replacement", async () => {
    const { client, socket } = await connected()
    void client.replace("todos", new ObjectId(), { title: "b", ownerId: "u", due: null })
    expect(sentDocs(socket)).toEqual([
      {
        title: "b",
        ownerId: "u",
        due: null,
        done: false,
      },
    ])
    client.close()
  })
})
