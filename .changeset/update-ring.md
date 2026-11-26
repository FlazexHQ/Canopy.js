---
"canopy.js": patch
---

Apply an optimistic update with one call into the core, which keeps the documents it updated last instead of releasing them when JavaScript collects them. Memory for optimistic updates stays bounded, and a document the core has dropped is sent again.
