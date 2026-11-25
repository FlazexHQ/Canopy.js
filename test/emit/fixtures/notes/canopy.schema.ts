import { collection, defineSchema, t } from "canopy.js/schema"

export const schema = defineSchema(
  collection("notes", {
    _id: t.string(),
    public: t.bool().default(false),
    secret: t.string().optional(),
    project: t.string(),
  }),
  collection("archive", { owner: t.string(), at: t.date() }),
)
