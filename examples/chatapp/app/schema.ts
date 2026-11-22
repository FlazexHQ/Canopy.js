import { collection, defineSchema, t } from "canopy.js/schema"

export const schema = defineSchema(
  collection("messages", {
    authorId: t.string(),
    body: t.string(),
    createdAt: t.date(),
  }),
)
declare module "canopy.js" {
  interface Register {
    schema: typeof schema
  }
}
