import { collection, defineSchema, t } from "canopy.js/schema"

const todos = collection("todos", {
  title: t.string(),
  done: t.bool().default(false),
  tags: t.array(t.string()).optional(),
  due: t.date().nullable(),
  ownerId: t.string(),
})

const notes = collection("notes", {
  _id: t.string(),
  title: t.string(),
  body: t.object({ text: t.string(), format: t.enum(["md", "plain"]) }),
})

const events = collection("events", { _id: t.uuid(), at: t.date() })

const counters = collection("counters", { _id: t.int(), n: t.long() })

export const schema = defineSchema(todos, notes, events, counters)

declare module "canopy.js" {
  interface Register {
    schema: typeof schema
  }
}
