---
"canopy.js": patch
---

Keep the first live snapshot visible as stale while the Rust client core loads. The query becomes
ready once it can immediately apply optimistic inserts and updates to its results.
