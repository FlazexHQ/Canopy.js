import { allow, auth, collection, ctx } from "canopy.js/policy"

export default collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("anon").where({ public: true }),
    allow.read("authenticated").where({ project: { $in: ctx("projectIds") } }),
    allow.insert("authenticated").check({ owner: auth("sub") }),
  ],
  fields: { read: { anon: { omit: ["secret"] } } },
})
