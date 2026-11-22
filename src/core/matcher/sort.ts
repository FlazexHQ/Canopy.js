import { InvalidQueryError, isDocument } from "../protocol/index.ts"
import { Bracket, bracketOf, compareValues } from "./compare.ts"
import { UnsupportedQueryError } from "./errors.ts"
import { readNumeric, toDouble } from "./numeric.ts"
import { isArrayIndex, splitPath } from "./path.ts"

/** One key of a sort specification. */
export interface SortKey {
  readonly path: string
  readonly parts: readonly string[]
  readonly direction: 1 | -1
}

/** A comparator over documents. */
export type DocComparator = (a: unknown, b: unknown) => number

const EMPTY_ARRAY = Symbol("empty array")

/** Parses a sort specification such as `{ createdAt: -1, _id: 1 }`. */
export function parseSort(spec: unknown): SortKey[] {
  if (!isDocument(spec)) throw new InvalidQueryError("A sort must be a document")
  const keys: SortKey[] = []
  for (const path of Object.keys(spec)) {
    const raw = spec[path]
    if (isDocument(raw)) throw new UnsupportedQueryError("$meta sorts are not evaluated in process")
    const numeric = readNumeric(raw)
    const value = numeric === undefined ? Number.NaN : toDouble(numeric)
    if (value !== 1 && value !== -1) {
      throw new InvalidQueryError(`The sort direction for ${path} must be 1 or -1`)
    }
    const parts = splitPath(path)
    if (path === "" || parts.some((part) => part === "" || part.startsWith("$"))) {
      throw new InvalidQueryError(`Invalid sort path: ${path}`)
    }
    keys.push({ path, parts, direction: value })
  }
  return keys
}

function compareKeys(a: unknown, b: unknown): number {
  if (a === EMPTY_ARRAY || b === EMPTY_ARRAY) {
    if (a === b) return 0
    const other = a === EMPTY_ARRAY ? b : a
    const sign = a === EMPTY_ARRAY ? -1 : 1
    return bracketOf(other) === Bracket.MinKey ? -sign : sign
  }
  return compareValues(a, b)
}

const PARALLEL = "cannot sort with keys that are parallel arrays"
const AMBIGUOUS =
  "Ambiguous field name found in array (do not use numeric field names in embedded elements in an array)"

/** Where a key path addressed an element of the array being expanded by its position. */
interface Positional {
  readonly indexed: unknown
  readonly dotted: unknown
  readonly remaining: number
}

function fieldOf(container: unknown, part: string): unknown {
  if (Array.isArray(container)) {
    return isArrayIndex(part) && Number(part) < container.length
      ? container[Number(part)]
      : undefined
  }
  if (isDocument(container) && Object.hasOwn(container, part)) return container[part]
  return undefined
}

/**
 * Follows a path from a document (or an array addressed by position) until its end or the first array,
 * returning the value found and the index of the first segment after it.
 */
function extract(container: unknown, parts: readonly string[], index: number): [unknown, number] {
  const sub = fieldOf(container, parts[index] ?? "")
  const next = index + 1
  if (sub === undefined) return [undefined, next]
  if (Array.isArray(sub) || next === parts.length) return [sub, next]
  if (isDocument(sub)) return extract(sub, parts, next)
  return [undefined, next]
}

/**
 * Generates the sort key tuples of a document the way MongoDB's key generator does: each key path is
 * followed to its end or to an array, every key that reaches an array must reach the same one (otherwise
 * they are parallel arrays), and that array is expanded element by element. A path that addresses an
 * element of the expanded array by position keeps reading that element while the others are expanded.
 */
function generate(
  paths: readonly (readonly string[])[],
  names: readonly number[],
  fixedIn: readonly unknown[],
  doc: Record<string, unknown> | undefined,
  positional: readonly (Positional | undefined)[],
  out: unknown[][],
): void {
  const next = [...names]
  const fixed = [...fixedIn]
  let array: unknown[] | undefined
  const expanding: number[] = []
  let expandElements = true
  paths.forEach((parts, i) => {
    const at = next[i] ?? parts.length
    if (at === parts.length) return
    const info = positional[i]
    const inDoc = doc !== undefined && Object.hasOwn(doc, parts[at] ?? "")
    if (inDoc && info !== undefined) throw new InvalidQueryError(AMBIGUOUS)
    let found: unknown
    if (inDoc) {
      ;[found, next[i]] = extract(doc, parts, at)
    } else if (info !== undefined) {
      if (Array.isArray(info.indexed)) expandElements = false
      next[i] = info.remaining
      found = info.dotted
    }
    if (found === undefined) {
      fixed[i] = null
      next[i] = parts.length
      return
    }
    if (Array.isArray(found)) {
      if (array !== undefined && array !== found) throw new InvalidQueryError(PARALLEL)
      array = found
      expanding.push(i)
      return
    }
    fixed[i] = found
  })
  if (array === undefined) {
    out.push(fixed)
    return
  }
  const shared = array
  const inner: (Positional | undefined)[] = paths.map(() => undefined)
  for (const i of expanding) {
    const parts = paths[i] ?? []
    const at = next[i] ?? parts.length
    if (at === parts.length) continue
    const indexed = fieldOf(shared, parts[at] ?? "")
    if (indexed === undefined) continue
    const [dotted, remaining] = extract(shared, parts, at)
    inner[i] = { indexed, dotted, remaining }
  }
  const expand = (entry: unknown, whole: boolean, info: readonly (Positional | undefined)[]) => {
    const withEntry = [...fixed]
    for (const i of expanding) {
      if (next[i] === (paths[i] ?? []).length) withEntry[i] = whole ? shared : entry
    }
    generate(paths, next, withEntry, isDocument(entry) ? entry : undefined, info, out)
  }
  if (shared.length === 0) {
    expand(EMPTY_ARRAY, false, [])
    return
  }
  for (const entry of shared) expand(entry === undefined ? null : entry, !expandElements, inner)
}

function compareTuples(
  a: readonly unknown[],
  b: readonly unknown[],
  keys: readonly SortKey[],
): number {
  for (let index = 0; index < keys.length; index += 1) {
    const cmp = compareKeys(a[index], b[index])
    if (cmp !== 0) return keys[index]?.direction === -1 ? -cmp : cmp
  }
  return 0
}

function bestTuple(doc: unknown, keys: readonly SortKey[]): unknown[] {
  const tuples: unknown[][] = []
  const paths = keys.map((key) => key.parts)
  generate(
    paths,
    keys.map(() => 0),
    keys.map(() => null),
    isDocument(doc) ? doc : undefined,
    [],
    tuples,
  )
  let best = tuples[0] ?? keys.map(() => null)
  for (let index = 1; index < tuples.length; index += 1) {
    const tuple = tuples[index] ?? []
    if (compareTuples(tuple, best, keys) < 0) best = tuple
  }
  return best
}

/**
 * Returns the sort key of a document for one path, as MongoDB computes it: the smallest reachable value for an
 * ascending sort and the largest for a descending sort. A missing field sorts as `null`, and an empty array
 * sorts before `null`.
 */
export function sortKeyOf(doc: unknown, key: SortKey): unknown {
  return bestTuple(doc, [key])[0]
}

/**
 * Compiles a sort specification into a total order. Ties are broken by `_id` ascending unless the
 * specification already sorts on `_id`, so the realtime engine, the SDK and snapshot queries (which append the
 * same tie breaker) agree on the order. Throws {@link InvalidQueryError} for documents with parallel arrays,
 * as MongoDB does.
 */
export function compileSort(spec: unknown): DocComparator {
  const order = compileSortKeys(spec)
  return (a, b) => order.compareKeys(order.key(a), order.key(b))
}

/** The sort key of one document under a compiled sort. Compare keys only with the sort that made them. */
export type DocSortKey = readonly unknown[]

/**
 * A sort split into its two steps, so each document's key is computed once instead of at every
 * comparison: computing a key walks the sorted paths and their arrays, comparing two keys does not.
 */
export interface CompiledSort {
  /** The key of a document. Throws {@link InvalidQueryError} for parallel arrays, as MongoDB does. */
  key(doc: unknown): DocSortKey
  /** Orders two keys of this sort. */
  compareKeys(a: DocSortKey, b: DocSortKey): number
  /** Sorts documents in place, computing each key once, and returns them. */
  sort<T>(docs: T[]): T[]
}

/**
 * Compiles a sort specification like {@link compileSort}, with the same order and `_id` tie breaker, into
 * separate key and comparison steps for callers that sort many documents or keep documents ordered.
 */
export function compileSortKeys(spec: unknown): CompiledSort {
  const keys = parseSort(spec)
  if (!keys.some((key) => key.path === "_id")) {
    keys.push({ path: "_id", parts: ["_id"], direction: 1 })
  }
  const key = (doc: unknown): DocSortKey => bestTuple(doc, keys)
  const compareKeys = (a: DocSortKey, b: DocSortKey): number => compareTuples(a, b, keys)
  return {
    key,
    compareKeys,
    sort<T>(docs: T[]): T[] {
      const keyed = docs.map((doc) => ({ doc, key: key(doc) }))
      keyed.sort((a, b) => compareKeys(a.key, b.key))
      for (const [index, entry] of keyed.entries()) docs[index] = entry.doc
      return docs
    },
  }
}

/** Returns the sort specification with the `_id` tie breaker appended, for queries sent to MongoDB. */
export function withIdTieBreaker(spec: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (Object.hasOwn(spec, "_id")) return { ...spec }
  return { ...spec, _id: 1 }
}
