# Vendored core

These files are copied from Canopy by `bun scripts/sync-core.ts`, with `@canopy/*` imports rewritten into
relative paths. Canopy is the source of truth: change them there, then run `bun run sync:core` here.
`bun run check:core` fails when this copy differs from Canopy.

`wasm/` holds the Rust client core, built by Canopy to WebAssembly and to JavaScript (wasm2js) and copied
by `bun scripts/sync-wasm.ts` with a checksum manifest; `bun run check:wasm` fails when the copy differs from
the build in Canopy. The client evaluates filters, sorts, projections and updates with it.
