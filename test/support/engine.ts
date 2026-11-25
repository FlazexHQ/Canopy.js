import { loadEngine } from "../../src/client/engine.ts"

/**
 * Loads the Rust client core before each test file, as a page has by the time its first snapshot arrives,
 * so tests that feed frames synchronously see rendered queries. `test/client/engine.test.ts` covers the
 * client before the core has loaded. With `CANOPY_TEST_CORE=js`, the core loads as its JavaScript
 * translation, as on Hermes or under a Content Security Policy that forbids WebAssembly.
 */
const host = globalThis as { WebAssembly?: unknown }
const saved = host.WebAssembly
if (process.env["CANOPY_TEST_CORE"] === "js") host.WebAssembly = undefined
try {
  const engine = await loadEngine()
  if (process.env["CANOPY_TEST_CORE"] === "js" && engine.kind !== "js")
    throw new Error("The client core did not load as JavaScript")
} finally {
  host.WebAssembly = saved
}
