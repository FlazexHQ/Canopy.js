import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Vendors the Rust core of Canopy, built to WebAssembly and to JavaScript (wasm2js), into
 * `src/core/wasm`, with a checksum manifest. The artifacts come from the split build of `packages/wasm` in
 * Canopy (`bun --filter @canopy/wasm build:native --split`), which writes them under `generated/`.
 *
 * The client module holds the matcher and the EJSON codec; the transforms module holds sorting,
 * projection and update application. The authoring module validates the canonical documents for
 * `canopy.js/emit` and never loads from the client entry points.
 *
 * Usage:
 *   bun scripts/sync-wasm.ts                   copy from ../Canopy (or CANOPY_REPO, or --from <path>)
 *   bun scripts/sync-wasm.ts --check           exit 1 when the vendored files differ from the build in Canopy
 *   bun scripts/sync-wasm.ts --check --manifest-only
 *                                              exit 1 when the vendored files differ from the manifest only,
 *                                              for checkouts without a Rust build of Canopy
 *   bun scripts/sync-wasm.ts --dist            copy the vendored artifacts next to the compiled `dist/core`
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const WASM_DIR = join(ROOT, "src", "core", "wasm")
const DIST_DIR = join(ROOT, "dist", "core", "wasm")
const MANIFEST = join(WASM_DIR, "manifest.json")

/**
 * The vendored modules and the files of each, as `packages/wasm/generated/<module>/canopy_<module><suffix>`.
 * The authoring module runs only under `canopy.js/emit` on Bun, Node and Deno, which all have WebAssembly,
 * so its JavaScript translation is not vendored.
 */
const MODULES: Readonly<Record<string, readonly string[]>> = {
  client: [".js", ".d.ts", "_bg.wasm", "_js.js", "_js.d.ts", "_translated.js"],
  transforms: [".js", ".d.ts", "_bg.wasm", "_js.js", "_js.d.ts", "_translated.js"],
  authoring: [".js", ".d.ts", "_bg.wasm"],
}

interface Options {
  readonly from: string
  readonly mode: "sync" | "check" | "dist"
  readonly manifestOnly: boolean
}

interface Manifest {
  readonly source: string
  readonly files: Readonly<Record<string, string>>
}

function parseArgs(argv: readonly string[]): Options {
  let from = process.env["CANOPY_REPO"] ?? join(ROOT, "..", "Canopy")
  let mode: Options["mode"] = "sync"
  let manifestOnly = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--check") mode = "check"
    else if (arg === "--dist") mode = "dist"
    else if (arg === "--manifest-only") manifestOnly = true
    else if (arg === "--from") {
      const value = argv[++i]
      if (value === undefined) throw new Error("--from needs a path to a Canopy checkout")
      from = value
    } else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (manifestOnly && mode !== "check") throw new Error("--manifest-only goes with --check")
  return { from: resolve(from), mode, manifestOnly }
}

/** The vendored files, as paths relative to `src/core/wasm` with forward slashes. */
function vendoredNames(): string[] {
  return Object.entries(MODULES).flatMap(([module, suffixes]) =>
    suffixes.map((suffix) => `${module}/canopy_${module}${suffix}`),
  )
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function nativePath(base: string, name: string): string {
  return join(base, ...name.split("/"))
}

function readManifest(): Manifest {
  if (!existsSync(MANIFEST)) throw new Error("src/core/wasm/manifest.json is missing: run the sync")
  const parsed: unknown = JSON.parse(readFileSync(MANIFEST, "utf8"))
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("The manifest is not an object")
  const { source, files } = parsed as { source?: unknown; files?: unknown }
  if (typeof source !== "string" || typeof files !== "object" || files === null)
    throw new Error("The manifest needs a source and a files map")
  const entries: Record<string, string> = {}
  for (const [name, hash] of Object.entries(files)) {
    if (typeof hash !== "string") throw new Error(`The manifest entry of ${name} is not a hash`)
    entries[name] = hash
  }
  return { source, files: entries }
}

function generatedDir(from: string): string {
  const dir = join(from, "packages", "wasm", "generated")
  const missing = vendoredNames().filter((name) => !existsSync(nativePath(dir, name)))
  if (missing.length > 0)
    throw new Error(
      `${dir} has no split build (missing ${missing.join(", ")}); run bun --filter @canopy/wasm build:native --split in Canopy`,
    )
  return dir
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
}

function sync(from: string): void {
  const source = generatedDir(from)
  const names = vendoredNames()
  const files: Record<string, string> = {}
  for (const name of listFiles(WASM_DIR))
    if (name !== "manifest.json" && !names.includes(name)) rmSync(nativePath(WASM_DIR, name))
  for (const name of names) {
    const bytes = readFileSync(nativePath(source, name))
    const target = nativePath(WASM_DIR, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    files[name] = sha256(bytes)
  }
  const manifest: Manifest = { source: "packages/wasm/generated", files }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.warn(`Vendored ${names.length} Wasm artifacts from ${source}`)
}

function check(from: string, manifestOnly: boolean): void {
  const problems: string[] = []
  const manifest = readManifest()
  const names = vendoredNames()
  for (const name of Object.keys(manifest.files))
    if (!names.includes(name)) problems.push(`not vendored any more: ${name}`)
  for (const name of listFiles(WASM_DIR))
    if (name !== "manifest.json" && !names.includes(name)) problems.push(`unexpected: ${name}`)
  const source = manifestOnly ? undefined : generatedDir(from)
  for (const name of names) {
    const target = nativePath(WASM_DIR, name)
    const recorded = manifest.files[name]
    if (recorded === undefined) {
      problems.push(`not in the manifest: ${name}`)
      continue
    }
    if (!existsSync(target)) {
      problems.push(`missing: ${name}`)
      continue
    }
    if (sha256(readFileSync(target)) !== recorded)
      problems.push(`differs from the manifest: ${name}`)
    if (source !== undefined && sha256(readFileSync(nativePath(source, name))) !== recorded)
      problems.push(`differs from Canopy: ${name}`)
  }
  if (problems.length > 0) {
    console.error(
      `The vendored Wasm artifacts are out of date:\n  ${problems.join("\n  ")}\nRun bun scripts/sync-wasm.ts to update them.`,
    )
    process.exitCode = 1
  }
}

function dist(): void {
  const manifest = readManifest()
  rmSync(DIST_DIR, { recursive: true, force: true })
  for (const name of Object.keys(manifest.files)) {
    const target = nativePath(DIST_DIR, name)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(nativePath(WASM_DIR, name), target)
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (options.mode === "dist") dist()
  else if (options.mode === "check") check(options.from, options.manifestOnly)
  else sync(options.from)
}

main()
