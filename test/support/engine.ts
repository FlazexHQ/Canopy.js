import { loadEngine } from "../../src/client/engine.ts"

/**
 * Loads the Rust client core before each test file, as a page has by the time its first snapshot arrives,
 * so tests that feed frames synchronously see rendered queries. `test/client/engine.test.ts` covers the
 * client before the core has loaded. With `CANOPY_TEST_CORE=js` (from the environment, or the `env` of a
 * Vitest project), the core loads as its JavaScript translation, as on Hermes or under a Content Security
 * Policy that forbids WebAssembly; otherwise it must load as WebAssembly.
 */
const expected = import.meta.env["CANOPY_TEST_CORE"] === "js" ? "js" : "wasm"
const host = globalThis as { WebAssembly?: unknown }
const saved = host.WebAssembly
if (expected === "js") host.WebAssembly = undefined
try {
  const engine = await loadEngine()
  if (engine.kind !== expected)
    throw new Error(`The client core loaded as ${engine.kind}, not as ${expected}`)
} finally {
  host.WebAssembly = saved
}
