# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

canopy.js is the TypeScript library of [Canopy](https://github.com/FlazexHQ/Canopy), the self hostable backend
platform for MongoDB. It is **one package**, `canopy.js`: the client at the root, and subpaths for the
framework bindings (`/react`, `/vue`, `/svelte`, `/solid`, `/tanstack-db`), `/devtools`, the client entry
points (`/auth`, `/rest`, `/server`, `/persist`, `/fallback`, `/rest-polling`, `/leader-tab`,
`/react-native`) and the authoring DSLs (`/policy`, `/policy/testing`, `/schema`, `/config`, `/protocol`).
Never split it into separately published packages. Framework libraries stay optional peer dependencies;
the package has no runtime dependencies.

Canopy (the platform: server, Studio, CLI, Rust core) lives in its own repository, cloned next to this one at
`../Canopy`. It runs as separate containers (`database`, `api`, `realtime`, `studio`, `edge`); start them with
`bun run stack:up` there. The library ships the separate `canopy-stack` command for local container stacks. Nothing is published to npm yet and no license has been chosen. The only branch is
**`master`**.

## Layout

- `src/client`, `src/react`, `src/vue`, `src/svelte`, `src/solid`, `src/tanstack-db`, `src/devtools`: owned
  here. `src/client/index.ts` is the root entry point.
- `src/core`: protocol support and generated Rust artifacts. Use `bun run sync:wasm` to refresh the
  artifacts. Client operations use the Rust client and transforms modules, and `canopy.js/emit` uses the
  Rust authoring module to validate inputs from the config, policy and schema builders.
- `src/cli`: the server only stack CLI, with its own TypeScript project. Its Compose template and
  Caddyfile live in `templates/cli`.
- `test/<module>`: Vitest suites per module; `test/vectors` holds the vendored protocol conformance vectors and
  `test/support/vectors.ts` replays them through the client. Tests import the package by its own name
  (`canopy.js`, `canopy.js/react`); `vitest.config.ts` aliases each name to its source.
- `examples/`: apps built on canopy.js that run against the Canopy container stack.

The package exports its sources under the `canopy-js-source` condition (only this repository's tests use it)
and `dist/` otherwise. TypeScript projects: `src/tsconfig.json` (universal: core and client, with
`isolatedDeclarations`) and `src/tsconfig.web.json`
(the DOM and JSX bindings), plus one project per test folder; `tsc -b` builds them all.

## Commands

```bash
bun install --frozen-lockfile
bun run check          # lint, format check, core layout and artifact checks, typecheck and tests
bun run build          # tsc -b into dist/
bun run test           # vitest run
bun run lint           # biome lint (formatting is bun fmt)
bun run format         # bun fmt
```

After changing anything here that Canopy uses, run `bun run build`, then `bun install` in Canopy: Canopy
installs a copy of this folder (`overrides` in its root `package.json`) until canopy.js is on npm.

## Rules (from the user, mandatory)

- **Bun first.** Bun is the primary runtime, then Node.js 24 and 26, then Deno; package managers in the order
  Bun, pnpm, Yarn, npm, and the package must install with all four. Code that runs in browsers stays on Web
  standard APIs (Web Crypto, `fetch`, `WebSocket`); server only entry points may use Bun's APIs behind an
  adapter with a Node counterpart. `bun fmt` is the formatter; Biome lints and orders imports.
- TypeScript **6.x**, ESM only, erasable syntax only (no `enum`, `namespace` or parameter properties), no
  `any`, no non null assertions, `unknown` at trust boundaries.
- **Comments:** TSDoc on exported APIs only; no narrating comments; never cite planning documents.
- **No dashes as punctuation** (no em or en dash, no spaced hyphen) in code, docs, strings or commits.
- **MongoDB vocabulary:** documents, collections, fields, databases; never rows, tables, columns or records.
- **Tests:** real tests that can fail, expected values from the spec or from MongoDB, never tailored to pass.
- Conventional Commits with DCO sign off (`git commit -s`), Changesets for release notes, semver.
