import { isEnvMarker, parseDuration } from "./env.ts"
import type { ConfigProblem, ResolveOptions, Source } from "./resolution.ts"
import { AUTH_KINDS, bool, oneOf, SECRET_PATHS, type Spec, str } from "./spec.ts"

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] ?? 0
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? 0 : 1),
      )
      previous = current
    }
  }
  return row[b.length] ?? 0
}

/** The closest candidate within a small edit distance, for "did you mean" hints. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(input.length / 3)) + 1
  for (const candidate of candidates) {
    const d = distance(input, candidate)
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return best
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "a list"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "object") return "an object"
  return String(value)
}

/** Joins values as `"a", "b" or "c"` for messages. */
export function quoted(values: readonly string[]): string {
  const parts = values.map((value) => JSON.stringify(value))
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} or ${parts.at(-1) ?? ""}`
}

/** Whether a value is an object literal (not an array, class instance or null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Sets an own, enumerable property. Unlike `target[key] = value` it never reaches a prototype, even when the
 * key is `__proto__`, so a key read from config input cannot pollute `Object.prototype`.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Walks a config tree against its spec: reads `env()` markers and the well known variables, applies
 * defaults, records where every value came from and which values are secret, and collects problems instead
 * of stopping at the first one.
 */
export class Resolver {
  readonly problems: ConfigProblem[] = []
  readonly sources = new Map<string, Source>()
  readonly secrets = new Set<string>(SECRET_PATHS)
  private readonly options: ResolveOptions

  constructor(options: ResolveOptions) {
    this.options = options
  }

  problem(path: string, message: string, missing = false): void {
    this.problems.push({ path, message, missing })
  }

  /** Parses text (from a variable) for a spec. */
  parseText(spec: Spec, text: string, path: string, label: string): unknown {
    const fail = (expected: string): undefined => {
      this.problem(
        path,
        `${label} is ${JSON.stringify(text)}.\nExpected ${expected}${expected.endsWith("?") ? "" : "."}`,
      )
      return undefined
    }
    switch (spec.t) {
      case "string":
        return text
      case "url":
        return URL.canParse(text.trim()) ? text.trim() : fail("an absolute URL")
      case "int":
        return /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : fail("an integer")
      case "bool": {
        const value = text.trim().toLowerCase()
        if (value === "true" || value === "1") return true
        if (value === "false" || value === "0") return false
        return fail("true, false, 1 or 0")
      }
      case "list":
        return text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")
      case "duration": {
        const value = parseDuration(text)
        return value === undefined ? fail("a duration such as 500ms, 30s, 5m, 24h or 7d") : value
      }
      case "enum": {
        if (spec.values.includes(text.trim())) return text.trim()
        const near = suggest(text.trim(), spec.values)
        return fail(
          `${quoted(spec.values)}${near === undefined ? "" : `. Did you mean "${near}"?`}`,
        )
      }
      case "origins": {
        const items = text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")
        return items.includes("*") ? "*" : items
      }
      default:
        return fail("a value that can be given as text")
    }
  }

  /** Validates a literal from the config file. */
  checkLiteral(spec: Spec, value: unknown, path: string): unknown {
    const wrong = (expected: string): undefined => {
      this.problem(
        path,
        `Received ${describe(value)}.\nExpected ${expected}${expected.endsWith("?") ? "" : "."}`,
      )
      return undefined
    }
    switch (spec.t) {
      case "string":
        return typeof value === "string" ? value : wrong("a string")
      case "url":
        return typeof value === "string" && URL.canParse(value) ? value : wrong("an absolute URL")
      case "int":
        return typeof value === "number" && Number.isSafeInteger(value)
          ? value
          : wrong("an integer")
      case "bool":
        return typeof value === "boolean" ? value : wrong("true or false")
      case "list":
        return Array.isArray(value) && value.every((item) => typeof item === "string")
          ? [...value]
          : wrong("a list of strings")
      case "duration":
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
        if (typeof value === "string") {
          const parsed = parseDuration(value)
          if (parsed !== undefined) return parsed
        }
        return wrong("milliseconds or a duration such as 500ms, 30s, 5m, 24h or 7d")
      case "enum": {
        if (typeof value === "string" && spec.values.includes(value)) return value
        const near = typeof value === "string" ? suggest(value, spec.values) : undefined
        return wrong(
          `${quoted(spec.values)}${near === undefined ? "" : `. Did you mean "${near}"?`}`,
        )
      }
      case "enums":
        if (
          Array.isArray(value) &&
          value.every((item) => typeof item === "string" && spec.values.includes(item))
        )
          return [...value]
        return wrong(`a list of ${quoted(spec.values)}`)
      case "origins":
        if (value === "*") return "*"
        return Array.isArray(value) && value.every((item) => typeof item === "string")
          ? [...value]
          : wrong('"*" or a list of origins')
      case "raw":
        return isPlainObject(value) ? value : wrong("an object")
      case "function":
        return typeof value === "function" ? value : wrong("a function")
      default:
        return wrong("a value")
    }
  }

  /** Walks the config file against the spec, resolving `env()` markers. */
  walk(spec: Spec, value: unknown, path: string): unknown {
    if (isEnvMarker(value)) {
      if (
        spec.t === "object" ||
        spec.t === "record" ||
        spec.t === "auth" ||
        spec.t === "policies" ||
        spec.t === "objects" ||
        spec.t === "tagged" ||
        spec.t === "function"
      )
        return this.checkLiteral(spec, value, path)
      const text = this.options.env[value.name]
      if (value.secret) this.secrets.add(path)
      if (text === undefined || text === "") {
        if (value.fallback !== undefined) {
          this.sources.set(path, { kind: "file" })
          return this.checkLiteral(spec, value.fallback, path)
        }
        if (!value.optional)
          this.problem(
            path,
            `${value.name} is not set.\nSet it in the environment${this.options.file === undefined ? "" : " or in an env file next to the config"}.`,
            true,
          )
        return undefined
      }
      this.sources.set(path, {
        kind: "env",
        name: value.name,
        envFile: this.options.envFiles?.get(value.name),
      })
      return this.parseText(spec, text, path, value.name)
    }
    if (value === undefined) return undefined
    switch (spec.t) {
      case "object":
        return this.walkObject(spec.fields, value, path)
      case "record": {
        if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) {
          const resolved = this.walk(spec.of, item, `${path}.${key}`)
          if (resolved !== undefined) out[key] = resolved
        }
        return out
      }
      case "toggle":
        if (value === true) return {}
        if (value === false) {
          this.sources.set(path, { kind: "file" })
          return false
        }
        return this.walk(spec.of, value, path)
      case "auth": {
        if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
        const kind = value["kind"]
        const fields = typeof kind === "string" ? AUTH_KINDS[kind] : undefined
        if (fields === undefined) {
          this.problem(
            `${path}.kind`,
            `Received ${describe(kind)}.\nUse builtin(), external(), external.auth0(), external.clerk(), external.firebase() or external.supabase().`,
          )
          return undefined
        }
        return this.walkObject(fields, value, path)
      }
      case "tagged": {
        if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
        const kind = value["kind"]
        const fields = typeof kind === "string" ? spec.kinds[kind] : undefined
        if (fields === undefined) {
          this.problem(`${path}.kind`, `Received ${describe(kind)}.\n${spec.hint}`)
          return undefined
        }
        return this.walkObject(fields, value, path)
      }
      case "objects": {
        if (!Array.isArray(value)) {
          this.problem(path, `Received ${describe(value)}.\nExpected a list.`)
          return undefined
        }
        return value.map((item, index) => this.walk(spec.of, item, `${path}.${index}`))
      }
      case "function": {
        const checked = this.checkLiteral(spec, value, path)
        if (checked !== undefined) this.sources.set(path, { kind: "file" })
        return checked
      }
      case "policies": {
        if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
        const fields: Record<string, Spec> = { dir: str, source: oneOf("database"), watch: bool }
        const out = this.walkObject(fields, value, path)
        if (isPlainObject(out)) {
          const hasDir = out["dir"] !== undefined
          const hasSource = out["source"] !== undefined
          if (hasDir === hasSource)
            this.problem(
              path,
              'Set either dir (a directory of policy files) or source: "database".',
            )
        }
        return out
      }
      default: {
        const checked = this.checkLiteral(spec, value, path)
        if (checked !== undefined) this.sources.set(path, { kind: "file" })
        return checked
      }
    }
  }

  private walkObject(
    fields: Readonly<Record<string, Spec>>,
    value: unknown,
    path: string,
  ): unknown {
    if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
    const out: Record<string, unknown> = {}
    const prefix = path === "" ? "" : `${path}.`
    for (const [key, item] of Object.entries(value)) {
      const spec = fields[key]
      if (spec === undefined) {
        const near = suggest(key, Object.keys(fields))
        this.problem(
          `${prefix}${key}`,
          `Unknown setting.${near === undefined ? "" : ` Did you mean ${prefix}${near}?`}`,
        )
        continue
      }
      const resolved = this.walk(spec, item, `${prefix}${key}`)
      if (resolved !== undefined) out[key] = resolved
    }
    return out
  }

  /**
   * Fills every unset setting that has a default and checks numeric ranges. Sections turned off (`false`)
   * are skipped, and so is auth other than built in auth.
   */
  fillDefaults(
    fields: Readonly<Record<string, Spec>>,
    node: Record<string, unknown>,
    prefix: string,
  ): void {
    for (const [key, spec] of Object.entries(fields)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue
      const path = `${prefix}${key}`
      const value = node[key]
      const nested =
        spec.t === "object"
          ? spec.fields
          : spec.t === "toggle" && spec.of.t === "object"
            ? spec.of.fields
            : spec.t === "auth" && isPlainObject(value) && value["kind"] === "builtin"
              ? AUTH_KINDS["builtin"]
              : undefined
      if (nested !== undefined) {
        if (value === false) continue
        if (value !== undefined && !isPlainObject(value)) continue
        const child: Record<string, unknown> = isPlainObject(value) ? value : {}
        this.fillDefaults(nested, child, `${path}.`)
        if (value === undefined && Object.keys(child).length > 0) setOwn(node, key, child)
        continue
      }
      if (value === undefined && spec.def !== undefined) {
        setOwn(node, key, Array.isArray(spec.def) ? [...spec.def] : spec.def)
        this.sources.set(path, { kind: "default" })
      }
      const current = node[key]
      const range = spec.range
      if (range !== undefined && typeof current === "number") {
        if (
          (range.min !== undefined && current < range.min) ||
          (range.max !== undefined && current > range.max)
        )
          this.problem(path, range.message(current))
      }
    }
  }

  /** Applies a well known variable on top of the file, refusing contradictions. */
  overlay(tree: Record<string, unknown>, name: string, path: string, spec: Spec): void {
    const text = this.options.env[name]
    if (text === undefined || text === "") return
    const parsed = this.parseText(spec, text, path, name)
    if (parsed === undefined) return
    if (SECRET_PATHS.has(path)) this.secrets.add(path)
    const keys = path.split(".")
    const last = keys.pop() ?? ""
    if (last === "__proto__" || last === "constructor" || last === "prototype") return
    let parent: Record<string, unknown> = tree
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") return
      const next = Object.hasOwn(parent, key) ? parent[key] : undefined
      if (next === false) {
        this.problem(
          path,
          `${name} is set, but ${keys.join(".")} is turned off in the config file.\nUnset ${name} or turn ${keys.join(".")} on.`,
        )
        return
      }
      if (!isPlainObject(next)) {
        const created: Record<string, unknown> = key === "auth" ? { kind: "external" } : {}
        setOwn(parent, key, created)
        parent = created
      } else {
        parent = next
      }
    }
    const source = this.sources.get(path)
    const envSource: Source = { kind: "env", name, envFile: this.options.envFiles?.get(name) }
    if (parent[last] === undefined || source === undefined) {
      setOwn(parent, last, parsed)
      this.sources.set(path, envSource)
      return
    }
    if (source.kind === "env" && source.name === name) return
    if (same(parent[last], parsed)) return
    const from =
      source.kind === "env" ? `the config file (through ${source.name})` : "the config file"
    this.problem(
      path,
      `${path} is set in ${from} and by ${name}, with different values.\nRemove one of them: the config file and the environment must not disagree.`,
    )
  }
}

/** Reads a dotted path of a resolved tree. */
export function get(tree: Record<string, unknown>, path: string): unknown {
  let value: unknown = tree
  for (const key of path.split(".")) {
    if (!isPlainObject(value)) return undefined
    value = value[key]
  }
  return value
}

/** The top level section of a dotted path. */
export function section(path: string): string {
  return path.split(".")[0] ?? path
}

/** Expands provider presets into plain external auth, keeping the source of what they were derived from. */
export function expandAuth(resolver: Resolver, tree: Record<string, unknown>): void {
  const auth = tree["auth"]
  if (!isPlainObject(auth)) return
  const text = (key: string): string | undefined =>
    typeof auth[key] === "string" ? (auth[key] as string) : undefined
  const derive = (from: string, fields: Record<string, unknown>): void => {
    const source = resolver.sources.get(`auth.${from}`) ?? { kind: "file" as const }
    const roles = text("rolesClaim")
    const next: Record<string, unknown> = { kind: "external", ...fields }
    if (roles !== undefined) next["rolesClaim"] = roles
    for (const key of Object.keys(fields)) resolver.sources.set(`auth.${key}`, source)
    tree["auth"] = next
  }
  const host = (value: string): string => {
    const authority = value.replace(/^https?:\/\//, "")
    let end = authority.length
    while (end > 0 && authority[end - 1] === "/") end--
    return authority.slice(0, end)
  }
  switch (auth["kind"]) {
    case "auth0": {
      const domain = text("domain")
      if (domain === undefined) return
      derive("domain", {
        jwksUrl: `https://${host(domain)}/.well-known/jwks.json`,
        issuer: `https://${host(domain)}/`,
        audience: auth["audience"],
        algorithms: ["RS256"],
      })
      return
    }
    case "clerk": {
      const api = text("frontendApi")
      if (api === undefined) return
      derive("frontendApi", {
        jwksUrl: `https://${host(api)}/.well-known/jwks.json`,
        issuer: `https://${host(api)}`,
        audience: auth["audience"],
        algorithms: ["RS256"],
      })
      return
    }
    case "firebase": {
      const project = text("projectId")
      if (project === undefined) return
      derive("projectId", {
        jwksUrl:
          "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
        issuer: `https://securetoken.google.com/${project}`,
        audience: project,
        algorithms: ["RS256"],
      })
      return
    }
    case "supabase": {
      const ref = text("projectRef")
      if (ref === undefined) return
      derive("projectRef", {
        jwksUrl: `https://${ref}.supabase.co/auth/v1/.well-known/jwks.json`,
        issuer: `https://${ref}.supabase.co/auth/v1`,
        audience: "authenticated",
        algorithms: ["ES256", "RS256"],
      })
      return
    }
    default:
      return
  }
}

/** Whether a host name is the loopback interface, where plain HTTP is accepted. */
export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}
