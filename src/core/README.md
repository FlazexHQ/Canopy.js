# Core bindings and protocol

`protocol/` contains wire types, framing, BSON and EJSON codecs, and shared wire error support.
`wasm/` contains the generated Rust client, transforms and authoring artifacts and their checksum
manifest. Run `bun run sync:wasm` to refresh them from the Canopy build. The client and transforms
modules ship WebAssembly and wasm2js variants. The emitter uses the WebAssembly authoring module.

Config, policy and schema builders live alongside the SDK in `src/config`, `src/policy` and
`src/schema`. They create typed inputs for the Rust authoring module. Client insert preparation
applies defaults and calls generators declared by the application. The conformance snapshots
under `test/vectors` exercise the protocol and authoring interfaces.

`bun run check:core-layout` enforces the file allowlist for these directories and checks the generated
artifact paths and hashes against the local Wasm manifest. Changes to the allowlist require review.
