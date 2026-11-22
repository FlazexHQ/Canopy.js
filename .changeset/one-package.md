---
"canopy.js": minor
---

canopy.js brings the Canopy client, the React, Vue, Svelte, Solid and TanStack DB bindings, devtools, and the
policy, schema and config DSLs together in one package with subpath exports, replacing `@canopy/client`,
`@canopy/react`, `@canopy/vue`, `@canopy/svelte`, `@canopy/solid`, `@canopy/tanstack-db` and
`@canopy/devtools`. Import from `canopy.js` instead of `@canopy/client`, from `canopy.js/react` instead of
`@canopy/react`, and so on; schema registration now augments `canopy.js` (`declare module "canopy.js"`).
