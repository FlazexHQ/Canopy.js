---
"canopy.js": minor
---

Use the Rust core for client evaluation and authoring validation, and remove the vendored
TypeScript matcher, query parser, policy engine and config resolver. Config, policy and schema
builders still declare project inputs. Resolve config and execute policy tests with the Canopy
CLI. Pass a Standard Schema decoder to REST aggregation when you need output validation.
