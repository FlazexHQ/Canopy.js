import { as, describePolicies } from "canopy.js/policy/testing"

describePolicies("notes", ({ doc, expect, where }) => {
  const note = doc({ _id: "n1", public: true, secret: "hidden" })
  expect(as.anon()).can.read(note).withoutFields(["secret"])
  expect(as.anon()).cannot.insert({ _id: "n2" })
  expect(as.user({ sub: "alice" }, { ctx: { projectIds: ["p1"] } })).can.read(
    where({ project: "p1" }),
  )
  expect(as.anon()).cannot.delete(where({ public: false }))
})
