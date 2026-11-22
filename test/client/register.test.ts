import { collection, defineSchema, t } from "canopy.js/schema"
import { describe, expectTypeOf, it } from "vitest"

import {
  type CanopyClient,
  createClient,
  type Doc,
  type Document,
  type Id,
  type NewDoc,
  type ObjectId,
  type UntypedSchema,
} from "../../src/client/index.ts"

const schema = defineSchema(
  collection("todos", { title: t.string(), done: t.bool().default(false) }),
  collection("notes", { _id: t.string(), body: t.string() }),
)

/** Type checks run by `tsc -b` with no registered schema; never called. */
function checks(): void {
  expectTypeOf<Doc<"anything">>().toEqualTypeOf<Document>()
  expectTypeOf<NewDoc<"anything">>().toEqualTypeOf<Document>()
  expectTypeOf<Id<"anything">>().toEqualTypeOf<unknown>()
  expectTypeOf<Doc<"notes", typeof schema>>().toEqualTypeOf<{ _id: string; body: string }>()
  expectTypeOf<Id<"todos", typeof schema>>().toEqualTypeOf<ObjectId>()

  const untyped = createClient({ url: "u", publishableKey: "pk" })
  expectTypeOf(untyped).toEqualTypeOf<CanopyClient<UntypedSchema>>()

  const typed = createClient({ url: "u", publishableKey: "pk", schema })
  expectTypeOf(typed.insert("todos", { title: "a" }).id).toEqualTypeOf<ObjectId>()
  expectTypeOf(typed.insert("notes", { _id: "n", body: "b" }).id).toEqualTypeOf<string>()
  // @ts-expect-error notes uses caller supplied ids
  void typed.insert("notes", { body: "b" })
  // @ts-expect-error not a collection of the schema
  void typed.from("todo")
}

describe("helper types without a registered schema", () => {
  it("resolve to the untyped schema or to an explicit one", () => {
    expectTypeOf(checks).toBeFunction()
  })
})
