import { allow, auth, collection } from "canopy.js/policy"

export default collection("messages", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({}),
    allow
      .insert("authenticated")
      .check({ authorId: auth("sub"), body: { $type: "string" }, createdAt: { $type: "date" } }),
  ],
  fields: { write: { default: { only: ["authorId", "body", "createdAt"] } } },
})
