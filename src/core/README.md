# Vendored core

These files are copied from Canopy by `bun scripts/sync-core.ts`, with `@canopy/*` imports rewritten into
relative paths. Canopy is the source of truth: change them there, then run `bun run sync:core` here.
`bun run check:core` fails when this copy differs from Canopy.
