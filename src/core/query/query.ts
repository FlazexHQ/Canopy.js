import { UPDATE_OPERATORS } from "../matcher/index.ts"
import {
  canonicalString,
  InvalidQueryError,
  isDocument,
  isForbiddenKey,
  sha256Hex,
} from "../protocol/index.ts"
import { type ParsedFilter, parseFilter } from "./filter.ts"
import { DEFAULT_LIMITS, type QueryLimits } from "./limits.ts"
import { normalizePositional, validatePath } from "./paths.ts"

function fail(message: string): never {
  throw new InvalidQueryError(message)
}

/** A validated sort specification. */
export interface ParsedSort {
  readonly sort: Readonly<Record<string, 1 | -1>>
  readonly paths: readonly string[]
}

/** Validates a sort such as `{ createdAt: -1 }`. Only `1` and `-1` are accepted. */
export function parseSort(input: unknown, limits: QueryLimits = DEFAULT_LIMITS): ParsedSort {
  if (!isDocument(input)) fail("A sort must be a document")
  const keys = Object.keys(input)
  if (keys.length > limits.maxSortKeys)
    fail(`A sort may not have more than ${limits.maxSortKeys} keys`)
  const sort: Record<string, 1 | -1> = {}
  for (const path of keys) {
    validatePath(path, { maxLength: limits.maxPathLength })
    const direction = input[path]
    if (direction !== 1 && direction !== -1) fail(`The sort direction for ${path} must be 1 or -1`)
    sort[path] = direction
  }
  return { sort, paths: keys }
}

/** A validated projection. */
export interface ParsedProjection {
  readonly projection: Readonly<Record<string, 0 | 1>>
  readonly mode: "include" | "exclude"
  readonly paths: readonly string[]
  readonly includeId: boolean
}

/** Validates an inclusion or exclusion projection. Projection operators are not accepted. */
export function parseProjection(
  input: unknown,
  limits: QueryLimits = DEFAULT_LIMITS,
): ParsedProjection {
  if (!isDocument(input)) fail("A projection must be a document")
  const keys = Object.keys(input)
  if (keys.length > limits.maxProjectionPaths) {
    fail(`A projection may not have more than ${limits.maxProjectionPaths} paths`)
  }
  const projection: Record<string, 0 | 1> = {}
  let mode: "include" | "exclude" | undefined
  let includeId = true
  const paths: string[] = []
  for (const path of keys) {
    validatePath(path, { maxLength: limits.maxPathLength })
    const raw = input[path]
    const flag = raw === 1 || raw === true ? 1 : raw === 0 || raw === false ? 0 : undefined
    if (flag === undefined) fail(`The projection of ${path} must be 0 or 1`)
    projection[path] = flag
    if (path === "_id") {
      includeId = flag === 1
      continue
    }
    const pathMode = flag === 1 ? "include" : "exclude"
    if (mode !== undefined && mode !== pathMode)
      fail("A projection cannot mix inclusion and exclusion")
    mode = pathMode
    paths.push(path)
  }
  for (const a of paths) {
    for (const b of paths) {
      if (a !== b && b.startsWith(`${a}.`)) fail(`Path collision between ${a} and ${b}`)
    }
  }
  return { projection, mode: mode ?? "exclude", paths, includeId }
}

/** Validates a `limit`. */
export function parseLimit(input: unknown, limits: QueryLimits = DEFAULT_LIMITS): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    fail("limit must be a non negative integer")
  }
  if (input > limits.maxLimit) fail(`limit may not exceed ${limits.maxLimit}`)
  return input === 0 ? 0 : input
}

/** A validated live query (the `q` of a `sub` message). */
export interface ParsedQuery {
  readonly filter: ParsedFilter
  readonly sort: ParsedSort | undefined
  readonly limit: number | undefined
  readonly fields: ParsedProjection | undefined
  /** Every path the query reads, for the unreadable path check. */
  readonly paths: readonly string[]
}

/** Validates the parts of a live query from an untrusted caller. */
export function parseQuery(
  input: {
    readonly filter?: unknown
    readonly sort?: unknown
    readonly limit?: unknown
    readonly fields?: unknown
  },
  limits: QueryLimits = DEFAULT_LIMITS,
): ParsedQuery {
  const filter = parseFilter(input.filter ?? {}, { context: "filter", limits })
  const sort = input.sort === undefined ? undefined : parseSort(input.sort, limits)
  const limit = input.limit === undefined ? undefined : parseLimit(input.limit, limits)
  const fields = input.fields === undefined ? undefined : parseProjection(input.fields, limits)
  const paths = [...new Set([...filter.paths, ...(sort?.paths ?? [])])]
  return { filter, sort, limit, fields, paths }
}

/** A validated update. */
export interface ParsedUpdate {
  readonly update: Record<string, unknown>
  /** `operators` for an operator update, `replacement` for a whole document. */
  readonly kind: "operators" | "replacement"
  /** Every path the update writes, with positional segments removed. `$rename` contributes both sides. */
  readonly writtenPaths: readonly string[]
}

/** Options for {@link parseUpdate}. */
export interface ParseUpdateOptions {
  readonly limits?: QueryLimits
  /** Accept pipeline style updates. Only the `service` role may use them. */
  readonly allowPipeline?: boolean
}

const OPERATORS = new Set(UPDATE_OPERATORS)

/** Validates an update document from an untrusted caller and lists the paths it writes. */
export function parseUpdate(input: unknown, options: ParseUpdateOptions = {}): ParsedUpdate {
  const limits = options.limits ?? DEFAULT_LIMITS
  if (Array.isArray(input)) {
    if (options.allowPipeline !== true)
      fail("Pipeline updates are only accepted from the service role")
    fail("Pipeline updates are not supported yet")
  }
  if (!isDocument(input)) fail("An update must be a document")
  const keys = Object.keys(input)
  if (keys.length === 0 || !keys.some((key) => key.startsWith("$"))) {
    validateStoredDocument(input, limits)
    return { update: input, kind: "replacement", writtenPaths: Object.keys(input) }
  }
  if (!keys.every((key) => key.startsWith("$"))) fail("An update cannot mix operators and fields")
  const written: string[] = []
  for (const op of keys) {
    if (!OPERATORS.has(op)) fail(`The update operator ${op} is not allowed`)
    const operand = input[op]
    if (!isDocument(operand)) fail(`${op} needs a document`)
    for (const path of Object.keys(operand)) {
      validatePath(path, { maxLength: limits.maxPathLength, positional: true })
      written.push(normalizePositional(path))
      const value = operand[path]
      if (op === "$rename") {
        if (typeof value !== "string") fail("$rename targets must be strings")
        validatePath(value, { maxLength: limits.maxPathLength })
        written.push(value)
        continue
      }
      validateUpdateValue(op, value, limits, 1)
    }
  }
  return { update: input, kind: "operators", writtenPaths: written }
}

function validateUpdateValue(op: string, value: unknown, limits: QueryLimits, depth: number): void {
  if (op === "$pull") {
    if (isDocument(value)) parseFilter(isOperatorDocument(value) ? { v: value } : value, { limits })
    return
  }
  if (
    (op === "$push" || op === "$addToSet") &&
    isDocument(value) &&
    Object.hasOwn(value, "$each")
  ) {
    for (const key of Object.keys(value)) {
      if (!["$each", "$position", "$slice", "$sort"].includes(key))
        fail(`Unknown ${op} modifier ${key}`)
    }
    const each = value["$each"]
    if (!Array.isArray(each)) fail("$each needs an array")
    if (each.length > limits.maxInList)
      fail(`$each may not have more than ${limits.maxInList} values`)
    for (const item of each) validateValueForStorage(item, limits, depth + 1)
    return
  }
  if (op === "$currentDate" || op === "$bit") return
  validateValueForStorage(value, limits, depth)
}

function isOperatorDocument(value: Record<string, unknown>): boolean {
  return Object.keys(value)[0]?.startsWith("$") ?? false
}

function validateValueForStorage(value: unknown, limits: QueryLimits, depth: number): void {
  if (depth > limits.maxDepth) fail(`A document may not nest deeper than ${limits.maxDepth} levels`)
  if (Array.isArray(value)) {
    for (const item of value) validateValueForStorage(item, limits, depth + 1)
    return
  }
  if (!isDocument(value)) return
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) fail(`The key "${key}" is not allowed`)
    if (key === "") fail("Field names may not be empty")
    if (key.startsWith("$")) fail(`Field names may not start with $: ${key}`)
    if (key.includes(".")) fail(`Field names may not contain dots: ${key}`)
    if (key.includes("\0")) fail("Field names may not contain NUL characters")
    validateValueForStorage(value[key], limits, depth + 1)
  }
}

/**
 * Validates a document that will be inserted or used as a replacement: no empty, `$` prefixed or dotted keys
 * and no prototype keys at any depth.
 */
export function validateStoredDocument(doc: unknown, limits: QueryLimits = DEFAULT_LIMITS): void {
  if (!isDocument(doc)) fail("A document must be an object")
  validateValueForStorage(doc, limits, 1)
}

/**
 * Returns a filter whose keys are sorted wherever order has no meaning (field conditions, operator objects,
 * `$in` sets, `$and`/`$or`/`$nor` branches), so equivalent filters share one canonical form. Literal documents
 * keep their order, because MongoDB document equality depends on it.
 */
export function canonicalizeFilter(filter: Record<string, unknown>): Record<string, unknown> {
  return canonicalDocument(filter)
}

function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort()
}

function canonicalDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of sortedKeys(doc)) {
    const value = doc[key]
    if (key === "$and" || key === "$or" || key === "$nor") {
      const branches = (value as unknown[]).map((branch) =>
        canonicalDocument(branch as Record<string, unknown>),
      )
      out[key] = sortByCanonical(branches)
    } else if (key.startsWith("$")) {
      out[key] = value
    } else {
      out[key] = canonicalCondition(value)
    }
  }
  return out
}

function canonicalCondition(value: unknown): unknown {
  if (!isDocument(value)) return value
  const first = Object.keys(value)[0]
  if (first === undefined || !first.startsWith("$")) return value
  const out: Record<string, unknown> = {}
  for (const key of sortedKeys(value)) {
    const operand = value[key]
    if ((key === "$in" || key === "$nin") && Array.isArray(operand))
      out[key] = sortByCanonical(operand)
    else if (key === "$elemMatch" && isDocument(operand)) {
      const inner = Object.keys(operand)[0]
      out[key] =
        inner?.startsWith("$") === true && !["$and", "$or", "$nor"].includes(inner)
          ? canonicalCondition(operand)
          : canonicalDocument(operand)
    } else if (key === "$not") out[key] = canonicalCondition(operand)
    else out[key] = operand
  }
  return out
}

function sortByCanonical(values: readonly unknown[]): unknown[] {
  return values
    .map((value) => ({ value, key: canonicalString(value) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.value)
}

/** The parts that identify an effective query. */
export interface QueryKeyParts {
  readonly collection: string
  readonly filter: Record<string, unknown>
  readonly sort?: Readonly<Record<string, unknown>> | undefined
  readonly limit?: number | undefined
  readonly projection?: Readonly<Record<string, unknown>> | undefined
}

/** Returns the canonical text of a query, used as the observer key. */
export function canonicalQuery(parts: QueryKeyParts): string {
  return canonicalString({
    c: parts.collection,
    f: canonicalizeFilter(parts.filter),
    s: parts.sort ?? null,
    l: parts.limit ?? null,
    p:
      parts.projection === undefined
        ? null
        : Object.fromEntries(
            Object.entries(parts.projection).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
  })
}

/** Returns the SHA-256 hash of the canonical query, prefixed with `sha256:`. */
export function queryHash(parts: QueryKeyParts): string {
  return `sha256:${sha256Hex(canonicalQuery(parts))}`
}
