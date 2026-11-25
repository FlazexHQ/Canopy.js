import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, posix, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

/**
 * Vendors the universal core of Canopy (protocol, query, policy, config and the schema DSL, with the parts of
 * the matcher they use) into `src/core` (except `src/core/wasm`, which `sync-wasm.ts` owns), the protocol conformance vectors into `test/vectors`, and the edge config into the CLI templates.
 *
 * Canopy is the source of truth for these modules: the server, the Rust equivalence suites and the MongoDB
 * differential tests all live there. This script copies every file reachable from the entry points below,
 * rewrites `@canopy/*` imports into relative paths, and refuses any import of a third party package, so the
 * vendored core stays free of runtime dependencies.
 *
 * Usage:
 *   bun scripts/sync-core.ts                 copy from ../Canopy (or CANOPY_REPO, or --from <path>)
 *   bun scripts/sync-core.ts --check         exit 1 when vendored files differ from Canopy
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CORE_DIR = join(ROOT, "src", "core")
const WASM_DIR = join(CORE_DIR, "wasm")
const VECTORS_DIR = join(ROOT, "test", "vectors")
const EDGE_CONFIG = join(ROOT, "templates", "cli", "Caddyfile")

/**
 * The import specifiers the SDK needs; everything they reach is vendored too. The client evaluates filters,
 * sorts, projections and updates with the Rust core in `src/core/wasm` (see `sync-wasm.ts`), so the matcher
 * is vendored only as far as the authoring modules below reach it.
 */
const ENTRIES = [
  "@canopy/protocol",
  "@canopy/query",
  "@canopy/policy",
  "@canopy/policy/testing",
  "@canopy/config",
  "@canopy/schema/define",
] as const

/** Packages whose sources may be vendored. */
const VENDORED = new Set(["protocol", "matcher", "query", "policy", "config", "schema"])

/** How the public names of the vendored packages read inside canopy.js, for doc comments. */
const PUBLIC_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["`@canopy/schema/define`", "`canopy.js/schema`"],
  ["`@canopy/policy`", "`canopy.js/policy`"],
  ["`@canopy/config`", "`canopy.js/config`"],
  ["`@canopy/client`", "`canopy.js`"],
  ["`@canopy/protocol`", "`canopy.js/protocol`"],
]

interface Options {
  readonly from: string
  readonly check: boolean
}

function parseArgs(argv: readonly string[]): Options {
  let from = process.env["CANOPY_REPO"] ?? join(ROOT, "..", "Canopy")
  let check = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--check") check = true
    else if (arg === "--from") {
      const value = argv[++i]
      if (value === undefined) throw new Error("--from needs a path to a Canopy checkout")
      from = value
    } else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  return { from: resolve(from), check }
}

interface PackageInfo {
  readonly dir: string
  readonly src: string
  readonly exports: ReadonlyMap<string, string>
}

function readPackage(repo: string, name: string): PackageInfo {
  const dir = join(repo, "packages", name)
  const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  const exportsField =
    typeof manifest === "object" && manifest !== null && "exports" in manifest
      ? manifest.exports
      : undefined
  if (typeof exportsField !== "object" || exportsField === null)
    throw new Error(`packages/${name}/package.json has no exports map`)
  const exports = new Map<string, string>()
  for (const [subpath, target] of Object.entries(exportsField)) {
    if (typeof target !== "object" || target === null) continue
    const source: unknown = (target as Record<string, unknown>)["@canopy/source"]
    if (typeof source === "string") exports.set(subpath, join(dir, source))
  }
  return { dir, src: join(dir, "src"), exports }
}

function toPosix(path: string): string {
  return path.split(sep).join("/")
}

/**
 * Where the text of an import specifier starts. TypeScript reports the position of the opening quote, so
 * the result is checked against the specifier itself rather than trusted.
 */
function literalStart(text: string, reference: ts.FileReference): number {
  for (const start of [reference.pos + 1, reference.pos]) {
    if (text.startsWith(reference.fileName, start)) return start
  }
  throw new Error(`cannot locate the import of ${reference.fileName} at offset ${reference.pos}`)
}

/** Rewrites one vendored file and returns the files it reaches. */
function rewrite(
  file: string,
  text: string,
  packages: ReadonlyMap<string, PackageInfo>,
  destinationOf: (source: string) => string,
): { readonly text: string; readonly reached: readonly string[] } {
  const reached: string[] = []
  const destination = destinationOf(file)
  const imports = ts.preProcessFile(text, true, true).importedFiles
  const replaced = (specifier: string): string => {
    if (specifier.startsWith(".")) {
      reached.push(resolve(dirname(file), specifier))
      return specifier
    }
    const match = /^@canopy\/([a-z-]+)(\/.*)?$/.exec(specifier)
    if (match === null)
      throw new Error(
        `${file} imports ${JSON.stringify(specifier)}; the vendored core must not depend on other packages`,
      )
    const name = match[1] ?? ""
    const subpath = `.${match[2] ?? ""}`
    const info = packages.get(name)
    if (info === undefined || !VENDORED.has(name))
      throw new Error(`${file} imports ${specifier}, which is not part of the vendored core`)
    const target = info.exports.get(subpath)
    if (target === undefined) throw new Error(`${specifier} is not exported by @canopy/${name}`)
    reached.push(target)
    const path = toPosix(relative(dirname(destination), destinationOf(target)))
    return path.startsWith(".") ? path : `./${path}`
  }
  let out = ""
  let cursor = 0
  for (const reference of [...imports].sort((a, b) => a.pos - b.pos)) {
    const start = literalStart(text, reference)
    out += text.slice(cursor, start) + replaced(reference.fileName)
    cursor = start + reference.fileName.length
  }
  out += text.slice(cursor)
  let documented = out
  for (const [from, to] of PUBLIC_NAMES) documented = documented.split(from).join(to)
  return { text: documented, reached }
}

/** Builds the expected contents of `src/core` and `test/vectors`, keyed by absolute path. */
function plan(repo: string): Map<string, string> {
  const packages = new Map<string, PackageInfo>()
  for (const name of VENDORED) packages.set(name, readPackage(repo, name))

  const destinationOf = (source: string): string => {
    for (const [name, info] of packages) {
      const rel = relative(info.src, source)
      if (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "")
        return join(CORE_DIR, name, rel)
    }
    throw new Error(`${source} is outside the src folder of a vendored package`)
  }

  const files = new Map<string, string>()
  const queue: string[] = []
  for (const entry of ENTRIES) {
    const [, name = "", rest = ""] = /^@canopy\/([a-z-]+)(\/.*)?$/.exec(entry) ?? []
    const target = packages.get(name)?.exports.get(`.${rest}`)
    if (target === undefined) throw new Error(`${entry} is not exported`)
    queue.push(target)
  }
  const seen = new Set<string>()
  while (queue.length > 0) {
    const source = queue.pop()
    if (source === undefined || seen.has(source)) continue
    seen.add(source)
    if (!existsSync(source)) throw new Error(`${source} does not exist`)
    const text = readFileSync(source, "utf8").replace(/\r\n/g, "\n")
    const result = rewrite(source, text, packages, destinationOf)
    files.set(destinationOf(source), result.text)
    queue.push(...result.reached)
  }

  const vectors = join(repo, "conformance", "protocol")
  for (const name of readdirSync(vectors).sort()) {
    if (!name.endsWith(".json")) continue
    files.set(
      join(VECTORS_DIR, name),
      readFileSync(join(vectors, name), "utf8").replace(/\r\n/g, "\n"),
    )
  }
  files.set(
    EDGE_CONFIG,
    readFileSync(join(repo, "deploy", "compose", "edge", "Caddyfile"), "utf8").replace(
      /\r\n/g,
      "\n",
    ),
  )
  return files
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(join(options.from, "packages", "protocol", "package.json")))
    throw new Error(
      `${options.from} is not a Canopy checkout; pass --from <path> or set CANOPY_REPO`,
    )
  const expected = plan(options.from)
  const managed = (path: string): boolean =>
    (path.startsWith(CORE_DIR + sep) && !path.startsWith(WASM_DIR + sep)) ||
    (path.startsWith(VECTORS_DIR + sep) && path.endsWith(".json"))
  const present = [...listFiles(CORE_DIR), ...listFiles(VECTORS_DIR)].filter(
    (path) => managed(path) && !path.endsWith(`${sep}README.md`),
  )

  if (options.check) {
    const problems: string[] = []
    for (const [path, text] of expected) {
      const rel = posix.normalize(toPosix(relative(ROOT, path)))
      if (!existsSync(path)) problems.push(`missing: ${rel}`)
      else if (readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== text)
        problems.push(`differs: ${rel}`)
    }
    for (const path of present)
      if (!expected.has(path)) problems.push(`not in Canopy: ${toPosix(relative(ROOT, path))}`)
    if (problems.length > 0) {
      console.error(
        `The vendored files are out of date with ${options.from}:\n  ${problems.join("\n  ")}\nRun bun scripts/sync-core.ts to update it.`,
      )
      process.exitCode = 1
    }
    return
  }

  for (const path of present) if (!expected.has(path)) rmSync(path)
  for (const [path, text] of expected) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  console.warn(`Vendored ${expected.size} files from ${options.from}`)
}

main()
