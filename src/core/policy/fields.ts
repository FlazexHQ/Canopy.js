import { exclusion, inclusion } from "../matcher/index.ts"
import { isDocument } from "../protocol/index.ts"
import { isWithin, pathsOverlap, stripIndexes } from "../query/index.ts"
import type { FieldRule, FieldRules } from "./model.ts"

/** The fields a request may read or write, after combining the rules of all its roles. */
export type FieldAccess =
  | { readonly kind: "all" }
  | { readonly kind: "only"; readonly paths: readonly string[] }
  | { readonly kind: "omit"; readonly paths: readonly string[] }

const ALL: FieldAccess = { kind: "all" }

/** Keeps the outermost of paths that contain each other: `profile` covers `profile.name`. */
function pruneDescendants(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)]
  return unique.filter((path) => !unique.some((other) => other !== path && isWithin(path, other)))
}

function fromRule(rule: FieldRule): FieldAccess {
  if ("only" in rule)
    return rule.only.includes("*") ? ALL : { kind: "only", paths: pruneDescendants(rule.only) }
  return rule.omit.length === 0 ? ALL : { kind: "omit", paths: pruneDescendants(rule.omit) }
}

function union(a: FieldAccess, b: FieldAccess): FieldAccess {
  if (a.kind === "all" || b.kind === "all") return ALL
  if (a.kind === "only" && b.kind === "only")
    return { kind: "only", paths: pruneDescendants([...a.paths, ...b.paths]) }
  if (a.kind === "omit" && b.kind === "omit") {
    const hidden = new Set<string>()
    for (const x of a.paths)
      for (const y of b.paths) {
        if (isWithin(x, y)) hidden.add(x)
        else if (isWithin(y, x)) hidden.add(y)
      }
    return hidden.size === 0 ? ALL : { kind: "omit", paths: pruneDescendants([...hidden]) }
  }
  const only = a.kind === "only" ? a : (b as { kind: "only"; paths: readonly string[] })
  const omit = a.kind === "omit" ? a : (b as { kind: "omit"; paths: readonly string[] })
  const hidden = omit.paths.filter((x) => !only.paths.some((allowed) => isWithin(x, allowed)))
  return hidden.length === 0 ? ALL : { kind: "omit", paths: pruneDescendants(hidden) }
}

/**
 * Combines the field rules of every role in the request. A role without an entry uses `default`;
 * without a `default` it may access every field. The combination is a union. When an `only` rule of one role
 * reaches inside a field another role omits as a whole, the field stays hidden: the combination never grants
 * more than either rule.
 */
export function fieldAccess(
  rules: FieldRules | undefined,
  roles: ReadonlySet<string>,
): FieldAccess {
  if (rules === undefined) return ALL
  let access: FieldAccess | undefined
  for (const role of roles) {
    const rule = Object.hasOwn(rules, role) ? rules[role] : rules["default"]
    const next = rule === undefined ? ALL : fromRule(rule)
    access = access === undefined ? next : union(access, next)
  }
  return access ?? (rules["default"] === undefined ? ALL : fromRule(rules["default"]))
}

/**
 * Returns true when `path` may be read or written under `access`. Under `only`, the path must equal an allowed
 * path or lie beneath one. Under `omit`, it must not equal, lie beneath or be an ancestor of a hidden path,
 * because reading or writing `profile` as a whole touches `profile.ssn`. Array indexes and
 * positional segments are ignored. `_id` is always accessible.
 */
export function canAccess(access: FieldAccess, path: string): boolean {
  if (access.kind === "all") return true
  const normalized = stripIndexes(path)
  if (normalized === "_id") return true
  switch (access.kind) {
    case "only":
      return access.paths.some((allowed) => isWithin(normalized, allowed))
    case "omit":
      return !access.paths.some((hidden) => pathsOverlap(normalized, hidden))
  }
}

/** Returns the paths in `paths` that `access` does not allow. */
export function deniedPaths(access: FieldAccess, paths: readonly string[]): string[] {
  return paths.filter((path) => !canAccess(access, path))
}

/**
 * Returns the written paths that touch an immutable path: equal to it, beneath it or an ancestor of it.
 * Array indexes are ignored, so `lines.0.sku` touches an immutable `lines.sku`.
 */
export function immutableViolations(
  written: readonly string[],
  immutable: readonly string[],
): string[] {
  const frozen = immutable.map(stripIndexes)
  return written.filter((path) => {
    const stripped = stripIndexes(path)
    return frozen.some((field) => pathsOverlap(stripped, field))
  })
}

/** The refusal of a `$text` search by a caller that cannot read every field. */
export const TEXT_SEARCH_DENIED = "$text is not available when some fields are not readable"

/**
 * Whether a filter's `$text` search is out of reach for `access`. A text index may cover fields the caller
 * cannot read, and `$text` names none of them, so it is allowed only when every field is readable.
 */
export function deniesTextSearch(
  access: FieldAccess,
  filter: Readonly<Record<string, unknown>>,
): boolean {
  return access.kind !== "all" && Object.hasOwn(filter, "$text")
}

/** Removes every field `access` does not allow from a document. `_id` is always kept. */
export function projectReadable(
  access: FieldAccess,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  switch (access.kind) {
    case "all":
      return doc
    case "only":
      return inclusion(access.paths, true).apply(doc)
    case "omit":
      return exclusion(access.paths, true).apply(doc)
  }
}

/**
 * Expresses `access` as one MongoDB projection, for push down. Returns `undefined` when every
 * field is readable.
 */
export function toProjection(access: FieldAccess): Record<string, 0 | 1> | undefined {
  switch (access.kind) {
    case "all":
      return undefined
    case "only":
      return Object.fromEntries(access.paths.map((path) => [path, 1 as const]))
    case "omit":
      return Object.fromEntries(access.paths.map((path) => [path, 0 as const]))
  }
}

/**
 * Intersects a caller's projection with the readable fields. Returns the projection to send to MongoDB, or
 * `undefined` when no projection is needed. Fields outside `readable` are also stripped in process by
 * {@link projectReadable}, so the intersection only needs to be safe, not minimal.
 */
export function intersectProjection(
  user: Readonly<Record<string, 0 | 1>> | undefined,
  readable: FieldAccess,
): Record<string, 0 | 1> | undefined {
  if (user === undefined) return toProjection(readable)
  const userPaths = Object.keys(user).filter((path) => path !== "_id")
  const userInclude = userPaths.some((path) => user[path] === 1)
  if (readable.kind === "all") return { ...user }
  if (userInclude) {
    const kept = userPaths.filter((path) => user[path] === 1 && canAccess(readable, path))
    if (readable.kind === "only") {
      for (const allowed of readable.paths) {
        if (
          userPaths.some((path) => user[path] === 1 && isWithin(allowed, path)) &&
          !kept.includes(allowed)
        ) {
          kept.push(allowed)
        }
      }
    }
    const pruned = kept.filter(
      (path) => !kept.some((other) => other !== path && isWithin(path, other)),
    )
    const out: Record<string, 0 | 1> = Object.fromEntries(pruned.map((path) => [path, 1 as const]))
    if (user["_id"] === 0) out["_id"] = 0
    return pruned.length === 0 ? { _id: 1 } : out
  }
  if (readable.kind === "omit") {
    const excluded = [...new Set([...userPaths, ...readable.paths])]
    const pruned = excluded.filter(
      (path) => !excluded.some((other) => other !== path && isWithin(path, other)),
    )
    const out: Record<string, 0 | 1> = Object.fromEntries(pruned.map((path) => [path, 0 as const]))
    if (user["_id"] === 0) out["_id"] = 0
    return out
  }
  const kept = readable.paths.filter((path) => !userPaths.some((hidden) => isWithin(path, hidden)))
  const out: Record<string, 0 | 1> = Object.fromEntries(kept.map((path) => [path, 1 as const]))
  if (user["_id"] === 0) out["_id"] = 0
  return kept.length === 0 ? { _id: 1 } : out
}

/** Lists the top level fields of a document, which is what an insert or a replacement writes. */
export function documentPaths(doc: Record<string, unknown>): string[] {
  return isDocument(doc) ? Object.keys(doc).filter((key) => doc[key] !== undefined) : []
}
