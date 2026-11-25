import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { isEnvMarker } from "../core/config/env.ts"
import type { Command, Environment } from "../core/config/types.ts"
import type { CollectionPolicies, ContextDefinitions } from "../core/policy/model.ts"
import { isDocument, parse } from "../core/protocol/index.ts"
import { type PolicyTestCase, type PolicySuite, takeRegisteredSuites } from "../policy/testing.ts"
import {
  type CollectionSchemaDocument,
  type ConfigDocument,
  collectionSchemaDocument,
  configDocument,
  type PolicySetDocument,
  type PolicyTestDocument,
  policySetDocument,
  policyTestDocument,
} from "./documents.ts"
import { AuthoringError, type BundlePart, EmitterError, PART_CODES } from "./errors.ts"

/** The commands a config function can be evaluated for. */
export const COMMANDS: readonly Command[] = [
  "start",
  "dev",
  "realtime",
  "gen",
  "policies",
  "doctor",
  "print",
]

/** Where a project's files are and which mode and command its config is evaluated for. */
export interface EmitOptions {
  /** The project root. Defaults to the working directory. */
  readonly root?: string
  /** The config file. Defaults to `canopy.config.{ts,mts,js,mjs}` in the root, then in `canopy/`. */
  readonly config?: string
  /** The policy folder. Defaults to the config's `policies.dir`. */
  readonly policies?: string
  /** Another folder of policy test files, besides the policy folder. */
  readonly tests?: string
  /** The schema file. Defaults to `canopy.schema.ts`, then `canopy.schema.js`, in the root. */
  readonly schema?: string
  /** Defaults to `production` when `CANOPY_ENV` is `production`, else `development`. */
  readonly mode?: Environment
  /** Defaults to `start`. */
  readonly command?: Command
  /** The environment the policy folder's `env()` reference is read from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** The project files a bundle came from, relative to the root with forward slashes. */
export interface BundleFiles {
  readonly config: string | null
  readonly policies: string | null
  readonly tests: readonly string[]
  readonly schema: string | null
}

/** One project's canonical documents, as `canopy.js/emit` prints them. */
export interface Bundle {
  readonly version: 1
  readonly context: { readonly mode: Environment; readonly command: Command }
  readonly files: BundleFiles
  readonly config: ConfigDocument | null
  readonly policies: PolicySetDocument | null
  readonly tests: readonly PolicyTestDocument[]
  readonly schema: CollectionSchemaDocument | null
}

const CONFIG_NAMES = [
  "canopy.config.ts",
  "canopy.config.mts",
  "canopy.config.js",
  "canopy.config.mjs",
]
const SCHEMA_NAMES = ["canopy.schema.ts", "canopy.schema.js"]
const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"])
const TEST_FILE = /\.(?:test|spec)\./

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function failure(part: BundlePart, file: string | null, error: unknown): AuthoringError {
  if (error instanceof EmitterError) throw error
  if (error instanceof AuthoringError) return error.file === null ? error.inFile(file) : error
  const reason = error instanceof Error ? error.message : String(error)
  return new AuthoringError(PART_CODES[part], part, "", reason, file)
}

async function importModule(file: string): Promise<Record<string, unknown>> {
  const module: unknown = await import(pathToFileURL(file).href)
  return isDocument(module) ? module : {}
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A policy document in the stored form of `canopy.policies`, read from a `.json` file. */
function fromStoredJson(stored: Record<string, unknown>): CollectionPolicies {
  const policies = Array.isArray(stored["policies"]) ? stored["policies"] : []
  const filter = (text: unknown): unknown => (typeof text === "string" ? parse(text) : text)
  return {
    collection: String(stored["_id"]),
    exposed: stored["exposed"] === true,
    realtime: stored["realtime"] === true,
    policies: policies.map((policy: unknown) => {
      if (!isDocument(policy)) return policy as CollectionPolicies["policies"][number]
      const { using, check, ...rest } = policy
      return {
        ...rest,
        ...(using === undefined ? {} : { using: filter(using) }),
        ...(check === undefined ? {} : { check: filter(check) }),
      } as CollectionPolicies["policies"][number]
    }),
    ...(stored["fields"] === undefined
      ? {}
      : { fields: stored["fields"] as NonNullable<CollectionPolicies["fields"]> }),
    ...(stored["immutable"] === undefined
      ? {}
      : { immutable: stored["immutable"] as NonNullable<CollectionPolicies["immutable"]> }),
  }
}

function isCollectionPolicies(value: unknown): value is CollectionPolicies {
  return (
    isDocument(value) && typeof value["collection"] === "string" && Array.isArray(value["policies"])
  )
}

interface LoadedPolicies {
  readonly input: { collections: CollectionPolicies[]; contexts: ContextDefinitions }
  /** The file of each collection, by index, and of the context lookups. */
  readonly collectionFiles: string[]
  readonly contextsFile: string | null
}

async function loadPolicyFolder(
  dir: string,
  name: (file: string) => string,
): Promise<LoadedPolicies> {
  const collections: CollectionPolicies[] = []
  const collectionFiles: string[] = []
  let contexts: ContextDefinitions = {}
  let contextsFile: string | null = null
  const entries = readdirSync(dir)
    .filter((entry) => !TEST_FILE.test(entry))
    .sort(byName)
  for (const entry of entries) {
    const extension = extname(entry)
    if (extension !== ".json" && !MODULE_EXTENSIONS.has(extension)) continue
    const file = join(dir, entry)
    if (!isFile(file)) continue
    const label = name(file)
    let exported: unknown
    try {
      if (extension === ".json") {
        exported = parse(readFileSync(file, "utf8"))
        if (isDocument(exported) && typeof exported["_id"] === "string") {
          if (exported["_id"] === "_context") {
            contexts = (exported["lookups"] ?? {}) as ContextDefinitions
            contextsFile = label
            continue
          }
          exported = fromStoredJson(exported)
        }
      } else {
        exported = (await importModule(file))["default"]
      }
    } catch (error: unknown) {
      throw failure("policies", label, error)
    }
    if (entry.startsWith("_context.")) {
      if (!isDocument(exported))
        throw new AuthoringError(
          PART_CODES.policies,
          "policies",
          "/contexts",
          `${entry} must export context lookups`,
          label,
        )
      contexts = exported as ContextDefinitions
      contextsFile = label
      continue
    }
    for (const item of Array.isArray(exported) ? exported : [exported]) {
      if (!isCollectionPolicies(item))
        throw new AuthoringError(
          PART_CODES.policies,
          "policies",
          `/collections/${collections.length}`,
          `${entry} must export collection(...) policies`,
          label,
        )
      collections.push(item)
      collectionFiles.push(label)
    }
  }
  return { input: { collections, contexts }, collectionFiles, contextsFile }
}

function fileOfPolicyPath(loaded: LoadedPolicies, path: string): string | null {
  const collection = /^\/collections\/(\d+)(?:\/|$)/.exec(path)
  if (collection !== null) return loaded.collectionFiles[Number(collection[1])] ?? null
  if (path.startsWith("/contexts")) return loaded.contextsFile
  return null
}

function isSuite(value: unknown): value is PolicySuite {
  return isDocument(value) && Array.isArray(value["cases"]) && typeof value["name"] === "string"
}

function isCase(value: unknown): value is PolicyTestCase {
  return isDocument(value) && typeof value["action"] === "string"
}

function testFiles(dirs: readonly string[]): string[] {
  const files = new Set<string>()
  for (const dir of dirs) {
    for (const entry of readdirSync(dir).sort(byName)) {
      const file = join(dir, entry)
      if (TEST_FILE.test(entry) && MODULE_EXTENSIONS.has(extname(entry)) && isFile(file))
        files.add(file)
    }
  }
  return [...files]
}

/** The suites each test module registered when it was first imported; a cached module does not run again. */
const registered = new Map<string, readonly PolicySuite[]>()

async function loadTests(file: string, label: string): Promise<PolicyTestCase[]> {
  takeRegisteredSuites()
  let exported: unknown
  try {
    exported = (await importModule(file))["default"]
  } catch (error: unknown) {
    takeRegisteredSuites()
    throw failure("tests", label, error)
  }
  const declared = takeRegisteredSuites()
  if (!registered.has(file) || declared.length > 0) registered.set(file, declared)
  const suites: unknown[] = [...(registered.get(file) ?? [])]
  for (const item of Array.isArray(exported) ? exported : exported === undefined ? [] : [exported])
    if (!suites.includes(item)) suites.push(item)
  const cases: PolicyTestCase[] = []
  for (const item of suites) {
    if (isSuite(item)) cases.push(...item.cases)
    else if (isCase(item)) cases.push(item)
    else
      throw new AuthoringError(
        PART_CODES.tests,
        "tests",
        "",
        "A policy test file exports describePolicies(...) suites or test cases",
        label,
      )
  }
  return cases
}

function policyDir(
  options: EmitOptions,
  root: string,
  configFile: string | null,
  config: unknown,
): string | null {
  if (options.policies !== undefined) return resolve(root, options.policies)
  const policies = isDocument(config) ? config["policies"] : undefined
  const dir = isDocument(policies) ? policies["dir"] : undefined
  const base = configFile === null ? root : dirname(configFile)
  if (typeof dir === "string") return resolve(base, dir)
  if (isEnvMarker(dir)) {
    if (dir.secret)
      throw new AuthoringError(
        PART_CODES.config,
        "config",
        "/config/policies/dir",
        "The policy folder cannot be a secret",
      )
    const value = (options.env ?? process.env)[dir.name] ?? dir.fallback
    return typeof value === "string" && value !== "" ? resolve(base, value) : null
  }
  return null
}

/**
 * Loads a project (its config, policy folder, policy tests and schema), encodes each part as its canonical
 * document and validates it with the Rust authoring module. Throws an {@link AuthoringError} naming the
 * part, the RFC 6901 path of the refused value and the file it came from.
 */
export async function emitProject(options: EmitOptions = {}): Promise<Bundle> {
  const root = resolve(options.root ?? process.cwd())
  const env = options.env ?? process.env
  const mode: Environment =
    options.mode ?? (env["CANOPY_ENV"] === "production" ? "production" : "development")
  const command: Command = options.command ?? "start"
  const name = (file: string): string => {
    const rel = relative(root, file)
    return (rel === "" || rel.startsWith("..") || isAbsolute(rel) ? file : rel).split(sep).join("/")
  }

  const configFile =
    options.config !== undefined
      ? resolve(root, options.config)
      : ([root, join(root, "canopy")]
          .flatMap((dir) => CONFIG_NAMES.map((entry) => join(dir, entry)))
          .find(isFile) ?? null)
  let configInput: unknown
  let config: ConfigDocument | null = null
  if (configFile !== null) {
    const label = name(configFile)
    try {
      if (!isFile(configFile)) throw new Error(`Cannot find the config file ${label}`)
      const exported = (await importModule(configFile))["default"]
      if (exported === undefined)
        throw new Error(
          `${label} must export its config as default: export default defineConfig({ ... })`,
        )
      configInput =
        typeof exported === "function"
          ? await (exported as (context: { mode: Environment; command: Command }) => unknown)({
              mode,
              command,
            })
          : exported
      config = configDocument(configInput)
    } catch (error: unknown) {
      throw failure("config", label, error)
    }
  }

  const dir = policyDir(options, root, configFile, configInput)
  let policies: PolicySetDocument | null = null
  const testDirs: string[] = []
  if (dir !== null) {
    if (!isDirectory(dir))
      throw new AuthoringError(
        PART_CODES.policies,
        "policies",
        "",
        `The policy folder ${name(dir)} does not exist`,
        name(dir),
      )
    const loaded = await loadPolicyFolder(dir, name)
    try {
      policies = policySetDocument(loaded.input).document
    } catch (error: unknown) {
      if (error instanceof AuthoringError) throw error.inFile(fileOfPolicyPath(loaded, error.path))
      throw failure("policies", name(dir), error)
    }
    testDirs.push(dir)
  }
  if (options.tests !== undefined) {
    const extra = resolve(root, options.tests)
    if (!isDirectory(extra))
      throw new AuthoringError(
        PART_CODES.tests,
        "tests",
        "",
        `The test folder ${name(extra)} does not exist`,
        name(extra),
      )
    testDirs.push(extra)
  }
  const files = testFiles(testDirs)
  const tests: PolicyTestDocument[] = []
  for (const file of files) {
    const label = name(file)
    for (const testCase of await loadTests(file, label)) {
      try {
        tests.push(policyTestDocument(testCase))
      } catch (error: unknown) {
        throw failure("tests", label, error)
      }
    }
  }

  const schemaFile =
    options.schema !== undefined
      ? resolve(root, options.schema)
      : (SCHEMA_NAMES.map((entry) => join(root, entry)).find(isFile) ?? null)
  let schema: CollectionSchemaDocument | null = null
  if (schemaFile !== null) {
    const label = name(schemaFile)
    try {
      if (!existsSync(schemaFile)) throw new Error(`Cannot find the schema file ${label}`)
      const module = await importModule(schemaFile)
      const exported = module["schema"] ?? module["default"]
      if (exported === undefined)
        throw new Error(`${label} must export its schema: export const schema = defineSchema(...)`)
      schema = collectionSchemaDocument(exported)
    } catch (error: unknown) {
      throw failure("schema", label, error)
    }
  }

  return {
    version: 1,
    context: { mode, command },
    files: {
      config: configFile === null ? null : name(configFile),
      policies: dir === null ? null : name(dir),
      tests: files.map(name),
      schema: schemaFile === null ? null : name(schemaFile),
    },
    config,
    policies,
    tests,
    schema,
  }
}
