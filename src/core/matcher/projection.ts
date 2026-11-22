import { InvalidQueryError, isDocument } from "../protocol/index.ts"
import { UnsupportedQueryError } from "./errors.ts"
import { readNumeric, toDouble } from "./numeric.ts"
import { splitPath } from "./path.ts"

/** A projection tree: `true` marks a projected path, a nested tree marks a projected sub path. */
export interface ProjectionTree {
  readonly [field: string]: true | ProjectionTree
}

/** A compiled projection. */
export interface CompiledProjection {
  /** `include` keeps only the listed paths; `exclude` removes them. */
  readonly mode: "include" | "exclude"
  /** Whether `_id` is part of the result. */
  readonly includeId: boolean
  /** The projected paths, without `_id`. */
  readonly paths: readonly string[]
  /** Applies the projection, returning a new document. */
  apply(doc: Record<string, unknown>): Record<string, unknown>
}

function flag(path: string, value: unknown): boolean {
  if (typeof value === "boolean") return value
  const numeric = readNumeric(value)
  if (numeric !== undefined) return toDouble(numeric) !== 0
  if (isDocument(value) || typeof value === "string") {
    throw new UnsupportedQueryError(`The projection of ${path} is not evaluated in process`)
  }
  throw new InvalidQueryError(`Invalid projection value for ${path}`)
}

/** Builds a tree from dotted paths. Throws when one path is a prefix of another (a path collision). */
export function buildTree(paths: readonly string[]): ProjectionTree {
  const root: Record<string, true | Record<string, unknown>> = Object.create(null)
  for (const path of paths) {
    const parts = splitPath(path)
    if (parts.some((part) => part === "" || part.startsWith("$"))) {
      throw new InvalidQueryError(`Invalid projection path: ${path}`)
    }
    let node: Record<string, true | Record<string, unknown>> = root
    parts.forEach((part, index) => {
      const existing = node[part]
      if (existing === true) throw new InvalidQueryError(`Path collision at ${path}`)
      if (index === parts.length - 1) {
        if (existing !== undefined) throw new InvalidQueryError(`Path collision at ${path}`)
        node[part] = true
        return
      }
      if (existing === undefined) {
        const child: Record<string, true | Record<string, unknown>> = Object.create(null)
        node[part] = child
        node = child
      } else {
        node = existing as Record<string, true | Record<string, unknown>>
      }
    })
  }
  return root as ProjectionTree
}

function includeValue(value: unknown, tree: ProjectionTree): unknown {
  if (isDocument(value)) return includeDocument(value, tree)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const element of value) {
      if (isDocument(element) || Array.isArray(element)) out.push(includeValue(element, tree))
    }
    return out
  }
  return undefined
}

function includeDocument(
  doc: Record<string, unknown>,
  tree: ProjectionTree,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(doc)) {
    const rule = tree[key]
    if (rule === undefined) continue
    const value = doc[key]
    if (rule === true) {
      if (value !== undefined) out[key] = value
      continue
    }
    const projected = includeValue(value, rule)
    if (projected !== undefined) out[key] = projected
  }
  return out
}

function excludeValue(value: unknown, tree: ProjectionTree): unknown {
  if (isDocument(value)) return excludeDocument(value, tree)
  if (Array.isArray(value)) return value.map((element) => excludeValue(element, tree))
  return value
}

function excludeDocument(
  doc: Record<string, unknown>,
  tree: ProjectionTree,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(doc)) {
    const rule = tree[key]
    const value = doc[key]
    if (rule === true || value === undefined) continue
    out[key] = rule === undefined ? value : excludeValue(value, rule)
  }
  return out
}

/** Compiles a projection such as `{ title: 1, 'owner.name': 1 }` or `{ secret: 0 }`. */
export function compileProjection(spec: unknown): CompiledProjection {
  if (!isDocument(spec)) throw new InvalidQueryError("A projection must be a document")
  let includeId = true
  const included: string[] = []
  const excluded: string[] = []
  for (const path of Object.keys(spec)) {
    const on = flag(path, spec[path])
    if (path === "_id") {
      includeId = on
      continue
    }
    if (on) included.push(path)
    else excluded.push(path)
  }
  const nested = [...included, ...excluded].find((path) => path.startsWith("_id."))
  if (Object.hasOwn(spec, "_id") && nested !== undefined) {
    throw new InvalidQueryError(`Path collision at ${nested}`)
  }
  if (included.length > 0 && excluded.length > 0) {
    throw new InvalidQueryError("Cannot mix inclusion and exclusion in a projection")
  }
  if (included.length > 0) return inclusion(included, includeId)
  return exclusion(excluded, includeId)
}

/** Builds an inclusion projection from paths. */
export function inclusion(paths: readonly string[], includeId = true): CompiledProjection {
  const withId = includeId && !paths.some((path) => path === "_id" || path.startsWith("_id."))
  const tree = buildTree(withId ? [...paths, "_id"] : paths)
  return {
    mode: "include",
    includeId,
    paths,
    apply(doc) {
      const out = includeDocument(doc, tree)
      return includeId ? out : withoutId(out)
    },
  }
}

/** Builds an exclusion projection from paths. */
export function exclusion(paths: readonly string[], includeId = true): CompiledProjection {
  const tree = buildTree(paths)
  return {
    mode: "exclude",
    includeId,
    paths,
    apply(doc) {
      const out = excludeDocument(doc, tree)
      return includeId ? out : withoutId(out)
    },
  }
}

function withoutId(doc: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(doc, "_id")) return doc
  const { _id: _ignored, ...rest } = doc
  return rest
}
