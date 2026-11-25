import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  initSync,
  validateCollectionSchemaDocument,
  validateConfigDocument,
  validatePolicySetDocument,
  validatePolicyTestDocument,
} from "../core/wasm/authoring/canopy_authoring.js"
import { AuthoringError, type BundlePart, EmitterError, PART_CODES } from "./errors.ts"

let loaded = false

/** Instantiates the Rust authoring module once, from the Wasm file next to this package's sources. */
function load(): void {
  if (loaded) return
  const url = new URL("../core/wasm/authoring/canopy_authoring_bg.wasm", import.meta.url)
  try {
    initSync({ module: readFileSync(fileURLToPath(url)) })
  } catch (error: unknown) {
    throw new EmitterError(`The Rust authoring module did not load from ${url.href}`, {
      cause: error,
    })
  }
  loaded = true
}

function refusal(part: BundlePart, error: unknown): AuthoringError {
  if (error instanceof Error && typeof (error as { path?: unknown }).path === "string") {
    const { code, path } = error as Error & { code?: unknown; path: string }
    const prefix = `${path === "" ? "/" : path}: `
    const reason = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message
    const known = Object.values(PART_CODES).find((candidate) => candidate === code)
    return new AuthoringError(known ?? PART_CODES[part], part, path, reason)
  }
  throw error
}

function run<T>(part: BundlePart, validate: () => T): T {
  load()
  try {
    return validate()
  } catch (error: unknown) {
    throw refusal(part, error)
  }
}

/** Validates a canonical policy set in Rust and returns its bundle version. */
export function checkPolicySet(document: unknown): string {
  return run("policies", () => validatePolicySetDocument(JSON.stringify(document)))
}

/** Validates one canonical policy test case in Rust. */
export function checkPolicyTest(document: unknown): void {
  run("tests", () => validatePolicyTestDocument(JSON.stringify(document)))
}

/** Validates a canonical unresolved config in Rust. */
export function checkConfig(document: unknown): void {
  run("config", () => validateConfigDocument(JSON.stringify(document)))
}

/** Validates a canonical collection schema in Rust. */
export function checkCollectionSchema(document: unknown): void {
  run("schema", () => validateCollectionSchemaDocument(JSON.stringify(document)))
}
