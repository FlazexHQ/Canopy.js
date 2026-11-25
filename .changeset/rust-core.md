---
"canopy.js": minor
---

The client evaluates filters, sorts, projections and optimistic updates on the Rust core of Canopy, compiled to WebAssembly and loaded after first paint, with a JavaScript translation where WebAssembly is unavailable or blocked by a content security policy. Documents cross to the core as BSON and are retained there between calls.
