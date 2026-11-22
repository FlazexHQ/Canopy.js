import { allow, auth, collection } from "canopy.js/policy"

const ownFile = { bucket: "files", owner: auth("sub") }
export default collection("storage.objects", {
  exposed: true,
  policies: [
    allow.read("authenticated").where(ownFile),
    allow.insert("authenticated").check(ownFile),
    allow.update("authenticated").where(ownFile).check(ownFile),
    allow.delete("authenticated").where(ownFile),
  ],
})
