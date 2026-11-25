import { auth, context } from "canopy.js/policy"

export default context({
  projectIds: {
    from: "memberships",
    where: { member: auth("sub") },
    select: "project",
    max: 50,
    ttl: "30s",
  },
})
