import { normalize } from "./normalize.ts"
import { ConfigError, type Resolution, type ResolveOptions, type Source } from "./resolution.ts"
import { expandAuth, isPlainObject, Resolver, section } from "./resolver.ts"
import { NEEDS, ROOT, WELL_KNOWN } from "./spec.ts"
import type { ResolvedConfig } from "./types.ts"

const RESOLVED: unique symbol = Symbol.for("canopy.config.resolved")

/** Whether a value is a config returned by {@link resolveConfig} (or `loadConfig`). */
export function isResolvedConfig(value: unknown): value is ResolvedConfig {
  return typeof value === "object" && value !== null && Object.hasOwn(value, RESOLVED)
}

/**
 * Validates a config (the default export of a config file, already called if it is a function) and the
 * environment, and applies every default. Settings from the file and the well known `CANOPY_*`
 * variables are combined: a variable fills a setting the file leaves out, and a variable that contradicts
 * the file is an error. Throws a {@link ConfigError} listing every problem the command cares about.
 */
export function resolveConfig(input: unknown, options: ResolveOptions): Resolution {
  const resolver = new Resolver(options)
  const walked = resolver.walk(ROOT, input ?? {}, "")
  const tree: Record<string, unknown> = isPlainObject(walked) ? walked : {}
  expandAuth(resolver, tree)
  for (const [name, path, spec] of WELL_KNOWN) resolver.overlay(tree, name, path, spec)
  const config = normalize(resolver, tree, options)
  const needs = NEEDS[options.command]
  const problems = resolver.problems.filter(
    (problem) => !problem.missing || needs === "all" || needs.has(section(problem.path)),
  )
  if (problems.length > 0) throw new ConfigError(options.file, problems)
  Object.defineProperty(config, RESOLVED, { value: true })
  return { config, sources: resolver.sources, secrets: resolver.secrets }
}

/**
 * A copy of a resolved config with some sections replaced, still recognised by {@link isResolvedConfig}. For a
 * launcher that runs a server with settings of its own, such as the proxies it trusts.
 */
export function amendConfig(
  config: ResolvedConfig,
  changes: Partial<Omit<ResolvedConfig, "file">>,
): ResolvedConfig {
  const amended: ResolvedConfig = { ...config, ...changes }
  Object.defineProperty(amended, RESOLVED, { value: true })
  return amended
}

/** Masks the password of a MongoDB connection string. */
export function redactUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^:/@]+:)[^@]*@/, "$1••••@")
}

/**
 * Renders a resolved config for `canopy config print`: one `path = value` line per setting, secrets
 * masked, and with `sources` the origin of each value.
 */
export function formatConfig(
  resolution: Resolution,
  options: { readonly sources?: boolean } = {},
): string {
  const lines: string[] = []
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
      for (const [index, item] of value.entries()) visit(item, `${path}.${index}`)
      return
    }
    if (isPlainObject(value) && !(path === "auth.jwks")) {
      const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      if (entries.length === 0 && path !== "") lines.push(`${path} = {}`)
      for (const [key, item] of entries) visit(item, path === "" ? key : `${path}.${key}`)
      return
    }
    if (path === "file") return
    let shown: string
    if (
      resolution.secrets.has(path) ||
      [...resolution.secrets].some((secret) => path.startsWith(`${secret}.`))
    )
      shown = Array.isArray(value) ? `[${value.map(() => '"••••"').join(", ")}]` : '"••••"'
    else if (typeof value === "function") shown = "[function]"
    else if (path === "mongodb.uri" && typeof value === "string")
      shown = JSON.stringify(redactUri(value))
    else shown = JSON.stringify(value)
    const line = `${path} = ${shown}`
    if (options.sources !== true) {
      lines.push(line)
      return
    }
    const source = sourceOf(resolution.sources, path)
    lines.push(`${line}  (${source})`)
  }
  visit(resolution.config, "")
  return `${lines.join("\n")}\n`
}

function sourceOf(sources: ReadonlyMap<string, Source>, path: string): string {
  const key = [
    path,
    path.replace(/Ms$/, ""),
    path.replace(/Seconds$/, ""),
    path.replace(/^rest\.mutationTtlMs$/, "rest.mutationTtl"),
  ].find((candidate) => sources.has(candidate))
  const source = key === undefined ? undefined : sources.get(key)
  if (source === undefined) return "default"
  if (source.kind === "env")
    return source.envFile === undefined
      ? `env ${source.name}`
      : `${source.name} from ${source.envFile}`
  return source.kind === "file" ? "config file" : "default"
}
