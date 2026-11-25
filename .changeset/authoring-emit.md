---
"canopy.js": minor
---

Add `canopy.js/emit`: run by the project's runtime (Bun, Node 24 or later, Deno), it loads the config, the policy folder, the policy tests and the schema, and prints one bundle of canonical documents on stdout for the Rust CLI. Every document is validated by the Rust authoring module, so invalid input fails with a stable code and an RFC 6901 path; `env()` references stay symbolic, so no resolved secret reaches a bundle. Policy tests can target every document a filter matches with `where(filter)`. The schema builders no longer throw while declaring collections: names, field builders, generators and duplicates are checked when the project is emitted.
