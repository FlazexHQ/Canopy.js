import { describe, expectTypeOf, it } from "vitest"

import { type CanopyAuth, createAuth } from "../../src/client/auth.ts"
import type {
  CanopyClient,
  DeepPartial,
  DocumentSchema,
  Filter,
  Long,
  ObjectId,
  Path,
  PathValue,
  Projected,
  Projection,
  QueryState,
  TokenSource,
  UntypedSchema,
  UpdateFilter,
} from "../../src/client/index.ts"
import { createClient } from "../../src/client/index.ts"
import type { ServerClient } from "../../src/client/server.ts"

interface TodoDocument {
  _id: ObjectId
  title: string
  done: boolean
  tags?: string[]
  meta?: { owner: { name: string; age: number } }
  items?: { sku: string; qty: number }[]
  count?: number | Long
  createdAt: Date
}

/** The shape `canopy gen types` writes. */
interface Database {
  todos: { Document: TodoDocument; Insert: Omit<TodoDocument, "_id"> & { _id?: ObjectId } }
  notes: { Document: { _id: string; body: string }; Insert: { _id: string; body: string } }
}

declare const canopy: CanopyClient<Database>
declare const untyped: CanopyClient
declare const server: ServerClient<Database>
declare const id: ObjectId

/** Type checks run by `tsc -b`; this function is never called. */
function checks(): void {
  void canopy.from("todos").find({ done: false, title: { $regex: "^a" } })
  void canopy.from("todos").find({ "meta.owner.name": "alice", "items.qty": { $gt: 1 } })
  void canopy.from("todos").find({ tags: "x" })
  void canopy.from("todos").find({ tags: { $all: ["x", "y"] }, "items.0.sku": "a" })
  void canopy.from("todos").find({ $or: [{ done: true }, { count: { $gte: 2 } }] })
  void canopy.from("todos").find({ items: { $elemMatch: { qty: { $lt: 3 } } } })
  // @ts-expect-error unknown field
  void canopy.from("todos").find({ titel: "x" })
  // @ts-expect-error wrong value type
  void canopy.from("todos").find({ done: "yes" })
  // @ts-expect-error wrong operator value type
  void canopy.from("todos").find({ title: { $in: [1, 2] } })
  // @ts-expect-error unknown nested field
  void canopy.from("todos").find({ "meta.owner.nmae": "x" })
  // @ts-expect-error unknown collection
  void canopy.from("todo")

  void canopy.from("todos").sort({ createdAt: -1, "meta.owner.age": 1 })
  // @ts-expect-error unknown sort field
  void canopy.from("todos").sort({ created: -1 })

  void canopy
    .from("todos")
    .update(id, { $set: { title: "x", "meta.owner.age": 3 }, $inc: { count: 1 } })
  void canopy
    .from("todos")
    .update(id, { $push: { tags: "x", items: { $each: [{ sku: "a", qty: 1 }] } } })
  void canopy.from("todos").update(id, { $unset: { tags: true }, $pull: { tags: "x" } })
  void canopy.update("todos", id, { $set: { done: true } }, { where: { done: false } })
  // @ts-expect-error unknown field in $set
  void canopy.from("todos").update(id, { $set: { titel: "x" } })
  // @ts-expect-error wrong value in $set
  void canopy.from("todos").update(id, { $set: { done: 1 } })
  // @ts-expect-error $inc on a string field
  void canopy.from("todos").update(id, { $inc: { title: 1 } })
  // @ts-expect-error $push on a non array field
  void canopy.from("todos").update(id, { $push: { title: "x" } })
  // @ts-expect-error string id where the document has an ObjectId
  void canopy.from("todos").update("abc", { $set: { done: true } })
  // @ts-expect-error unknown field in the where precondition
  void canopy.update("todos", id, { $set: { done: true } }, { where: { dne: false } })

  void canopy.from("todos").insert({ title: "x", done: false, createdAt: new Date() })
  void canopy.insert("notes", { _id: "n1", body: "b" })
  // @ts-expect-error missing required field
  void canopy.from("todos").insert({ title: "x", createdAt: new Date() })
  // @ts-expect-error notes need their _id
  void canopy.insert("notes", { body: "b" })
  // @ts-expect-error extra field
  void canopy.insert("notes", { _id: "n1", body: "b", extra: 1 })

  void canopy.deleteMany("todos", { done: true })
  // @ts-expect-error unknown field in a bulk filter
  void canopy.updateMany("todos", { dun: true }, { $set: { done: false } })

  const open = canopy.from("todos").find({ done: false })
  // @ts-expect-error a derived read query has no bulk write method
  void open.updateMany
  // @ts-expect-error nor single document writes
  void open.sort({ createdAt: -1 }).limit(5).insert
  void canopy.from("todos").updateMany({ done: false }, { $set: { done: true } })
  // @ts-expect-error a literal projection cannot mix inclusion and exclusion
  void canopy.from("todos").fields({ title: 1, done: 0 })
  // @ts-expect-error nor in a live read
  void canopy.live("todos", {}, { fields: { title: 1, done: 0 } })
  void canopy.from("todos").fields({ title: 1, _id: 0 })
  void canopy.live("todos", {}, { fields: { title: 0, _id: 1 } })

  const [projected] = canopy.live("todos", {}, { fields: { title: 1 } }).getState().data
  if (projected !== undefined) {
    expectTypeOf(projected.title).toEqualTypeOf<string>()
    // @ts-expect-error the projection omits done
    void projected.done
  }

  void untyped.from("anything").find({ any: { $gt: 1 }, "a.b": [1] })
  void untyped.update("x", "id", { $set: { y: 1 } })
}

describe("client types", () => {
  it("is only checked at compile time", () => {
    expectTypeOf(checks).toBeFunction()
  })

  it("returns documents of the collection from a query", () => {
    const todos = () => canopy.from("todos").getState()
    const notes = () => canopy.live("notes", {}).getState().data
    expectTypeOf<ReturnType<typeof todos>>().toEqualTypeOf<QueryState<TodoDocument>>()
    expectTypeOf<ReturnType<typeof notes>>().toEqualTypeOf<
      readonly { _id: string; body: string }[]
    >()
  })

  it("types the id of an insert from the collection's documents", () => {
    const note = () => canopy.insert("notes", { _id: "n1", body: "hi" }).id
    const todo = () =>
      canopy.from("todos").insert({ title: "t", done: false, createdAt: new Date() }).id
    const loose = () => untyped.insert("anything", {}).id
    expectTypeOf<ReturnType<typeof note>>().toEqualTypeOf<string>()
    expectTypeOf<ReturnType<typeof todo>>().toEqualTypeOf<ObjectId>()
    expectTypeOf<ReturnType<typeof loose>>().toEqualTypeOf<unknown>()
  })

  it("narrows the document type by projection", () => {
    const included = () => canopy.from("todos").fields({ title: 1 }).getState().data[0]
    const withoutId = () => canopy.from("todos").fields({ title: 1, _id: 0 }).getState().data[0]
    expectTypeOf<ReturnType<typeof included>>().toEqualTypeOf<
      { _id: ObjectId; title: string } | undefined
    >()
    expectTypeOf<ReturnType<typeof withoutId>>().toEqualTypeOf<{ title: string } | undefined>()
    type Excluded = Projected<TodoDocument, { meta: 0; items: 0; tags: 0; count: 0; createdAt: 0 }>
    expectTypeOf<Excluded>().toEqualTypeOf<{ _id: ObjectId; title: string; done: boolean }>()
    type Nested = Projected<TodoDocument, { "meta.owner.name": 1 }>
    expectTypeOf<Nested["meta"]>().toEqualTypeOf<
      { owner?: { name?: string; age?: number } } | undefined
    >()
  })

  it("gives live reads and server snapshots the same projected documents", () => {
    const live = () => canopy.live("todos", {}, { fields: { title: 1 } }).getState().data[0]
    const ssr = async () => (await server.find("todos", {}, { fields: { title: 1 } })).docs[0]
    const full = async () => (await server.find("todos", { done: false })).docs[0]
    expectTypeOf<ReturnType<typeof live>>().toEqualTypeOf<
      { _id: ObjectId; title: string } | undefined
    >()
    expectTypeOf<Awaited<ReturnType<typeof ssr>>>().toEqualTypeOf<
      { _id: ObjectId; title: string } | undefined
    >()
    expectTypeOf<Awaited<ReturnType<typeof full>>>().toEqualTypeOf<TodoDocument | undefined>()
  })

  it("keeps a projection known only at runtime conservative", () => {
    const fields: Projection<TodoDocument> = { title: 1 }
    const dynamic = () => canopy.live("todos", {}, { fields }).getState().data[0]
    expectTypeOf<ReturnType<typeof dynamic>>().toEqualTypeOf<
      DeepPartial<TodoDocument> | undefined
    >()
  })

  it("keeps the type of the auth handle it was given", () => {
    const builtIn = () =>
      createClient({ url: "u", publishableKey: "pk", auth: createAuth({ url: "u" }) })
    const minimal = () =>
      createClient({ url: "u", publishableKey: "pk", auth: { getToken: () => "t" } })
    const none = () => createClient({ url: "u", publishableKey: "pk" })
    expectTypeOf<ReturnType<typeof builtIn>["auth"]>().toEqualTypeOf<CanopyAuth>()
    expectTypeOf<ReturnType<typeof builtIn>["auth"]["signInWithPassword"]>().toBeFunction()
    expectTypeOf<ReturnType<typeof minimal>["auth"]>().toEqualTypeOf<{ getToken: () => string }>()
    expectTypeOf<ReturnType<typeof none>["auth"]>().toEqualTypeOf<TokenSource | undefined>()
    const typed = () =>
      createClient<Database>({ url: "u", publishableKey: "pk", auth: createAuth({ url: "u" }) })
    expectTypeOf<ReturnType<typeof typed>>().toExtend<CanopyClient<Database>>()
  })

  it("resolves paths and their values", () => {
    expectTypeOf<PathValue<TodoDocument, "meta.owner.age">>().toEqualTypeOf<number>()
    expectTypeOf<PathValue<TodoDocument, "items.qty">>().toEqualTypeOf<number>()
    expectTypeOf<PathValue<TodoDocument, "items.1.sku">>().toEqualTypeOf<string>()
    expectTypeOf<"meta.owner.name">().toExtend<Path<TodoDocument>>()
    expectTypeOf<"meta.owner.missing">().not.toExtend<Path<TodoDocument>>()
  })

  it("leaves untyped documents open", () => {
    expectTypeOf<Path<Record<string, unknown>>>().toEqualTypeOf<string>()
    expectTypeOf<{ a: { $gt: 1 } }>().toExtend<Filter<Record<string, unknown>>>()
    expectTypeOf<{ $inc: { anything: 1 } }>().toExtend<UpdateFilter<Record<string, unknown>>>()
    expectTypeOf<typeof untyped>().toEqualTypeOf<CanopyClient<UntypedSchema>>()
  })

  it("makes _id optional on inserts of hand written row schemas", () => {
    type Notes = DocumentSchema<{ notes: { _id: string; body: string } }>
    expectTypeOf<{ body: string }>().toExtend<Notes["notes"]["Insert"]>()
    expectTypeOf<{ _id: number; body: string }>().not.toExtend<Notes["notes"]["Insert"]>()
  })
})
