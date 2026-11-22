import { InvalidQueryError, isDocument } from "../protocol/index.ts"
import { canAccess, type FieldAccess } from "./fields.ts"

type Stage = Record<string, unknown>

/** The search stages, which MongoDB only accepts as the first stage of a pipeline. */
export const SEARCH_STAGES: ReadonlySet<string> = new Set(["$search", "$vectorSearch"])

const OPERATORS = new Set([
  "autocomplete",
  "compound",
  "embeddedDocument",
  "equals",
  "exists",
  "geoShape",
  "geoWithin",
  "in",
  "moreLikeThis",
  "near",
  "phrase",
  "queryString",
  "range",
  "regex",
  "text",
  "wildcard",
])
const OPTIONS = new Set([
  "index",
  "highlight",
  "scoreDetails",
  "sort",
  "concurrent",
  "searchAfter",
  "searchBefore",
])
/** Operators whose text or source documents can name any indexed field. */
const ANY_FIELD = new Set(["queryString", "moreLikeThis"])
const COMPOUND_CLAUSES = new Set(["must", "mustNot", "should", "filter"])
const VECTOR_KEYS = new Set([
  "index",
  "path",
  "queryVector",
  "numCandidates",
  "limit",
  "exact",
  "filter",
])
/** The operators `$vectorSearch.filter` supports. */
const VECTOR_FILTER_OPERATORS = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$not",
])
const VECTOR_FILTER_LOGICAL = new Set(["$and", "$or", "$nor"])
const MAX_CANDIDATES = 10_000
const MAX_DIMENSIONS = 8192
const MAX_DEPTH = 32

function fail(message: string): never {
  throw new InvalidQueryError(message)
}

/** What a search may look at for one caller. */
export interface SearchScope {
  readonly readable: FieldAccess
  /** The most documents `$vectorSearch` may return. */
  readonly maxResults: number
}

function readablePath(scope: SearchScope, path: unknown, where: string): void {
  if (typeof path !== "string" || path === "" || path.startsWith("$"))
    fail(`${where} needs field paths`)
  if (!canAccess(scope.readable, path)) fail(`${where} cannot use the unreadable field ${path}`)
}

function everyField(scope: SearchScope, what: string): void {
  if (scope.readable.kind !== "all")
    fail(`${what} can match any field, so it needs every field of the collection to be readable`)
}

/**
 * Checks a `path` of a search operator: a field, `{ value, multi }`, `{ value, undefined }` (in score
 * functions), `{ wildcard }` or a list of those.
 */
function paths(scope: SearchScope, value: unknown, where: string): void {
  if (Array.isArray(value)) {
    if (value.length === 0) fail(`${where} needs at least one path`)
    for (const item of value) paths(scope, item, where)
    return
  }
  if (isDocument(value)) {
    if (Object.hasOwn(value, "wildcard")) {
      if (Object.keys(value).length !== 1 || typeof value["wildcard"] !== "string")
        fail(`${where} needs { wildcard: "<pattern>" }`)
      everyField(scope, "A wildcard path")
      return
    }
    for (const key of Object.keys(value))
      if (key !== "value" && key !== "multi" && key !== "undefined")
        fail(`Unknown path field ${key} in ${where}`)
    readablePath(scope, value["value"], where)
    return
  }
  readablePath(scope, value, where)
}

/** Walks an operator body, checking every path it names and refusing operators that can see any field. */
function walk(scope: SearchScope, value: unknown, where: string, depth: number): void {
  if (depth > MAX_DEPTH) fail("The search is nested too deeply")
  if (Array.isArray(value)) {
    for (const item of value) walk(scope, item, where, depth + 1)
    return
  }
  if (!isDocument(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (key === "path" || key === "defaultPath") paths(scope, item, where)
    else if (ANY_FIELD.has(key)) everyField(scope, key)
    else if (key === "operator" && isDocument(item)) operator(scope, item, depth + 1)
    else walk(scope, item, where, depth + 1)
  }
}

/** Checks one operator document such as `{ text: { query, path } }`, recursing into compound clauses. */
function operator(scope: SearchScope, value: unknown, depth: number): void {
  if (!isDocument(value)) fail("A search operator must be a document")
  const keys = Object.keys(value)
  const [name] = keys
  if (name === undefined || keys.length !== 1) fail("A search operator must have exactly one key")
  if (!OPERATORS.has(name)) fail(`The search operator ${name} is not allowed`)
  const body = value[name]
  if (!isDocument(body)) fail(`The search operator ${name} needs a document`)
  if (ANY_FIELD.has(name)) everyField(scope, name)
  if (name !== "compound") {
    walk(scope, body, name, depth)
    return
  }
  for (const [clause, item] of Object.entries(body)) {
    if (COMPOUND_CLAUSES.has(clause)) {
      for (const inner of Array.isArray(item) ? item : [item]) operator(scope, inner, depth + 1)
    } else if (clause === "minimumShouldMatch") {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)
        fail("minimumShouldMatch needs a non negative integer")
    } else if (clause === "score") {
      walk(scope, item, "compound", depth + 1)
    } else {
      fail(`Unknown compound field ${clause}`)
    }
  }
}

function search(scope: SearchScope, value: unknown): Stage {
  if (!isDocument(value)) fail("$search needs a document")
  let operators = 0
  for (const [key, item] of Object.entries(value)) {
    if (OPERATORS.has(key)) {
      operators += 1
      operator(scope, { [key]: item }, 1)
      continue
    }
    if (!OPTIONS.has(key)) fail(`The $search option ${key} is not allowed`)
    switch (key) {
      case "index":
      case "searchAfter":
      case "searchBefore":
        if (typeof item !== "string" || item === "") fail(`$search ${key} needs a string`)
        break
      case "scoreDetails":
      case "concurrent":
        if (typeof item !== "boolean") fail(`$search ${key} needs true or false`)
        break
      case "highlight":
        if (!isDocument(item)) fail("$search highlight needs a document")
        for (const field of Object.keys(item))
          if (field !== "path" && field !== "maxCharsToExamine" && field !== "maxNumPassages")
            fail(`Unknown highlight field ${field}`)
        paths(scope, item["path"], "highlight")
        break
      case "sort":
        if (!isDocument(item) || Object.keys(item).length === 0)
          fail("$search sort needs a document of fields")
        for (const [field, order] of Object.entries(item)) {
          if (isDocument(order) && Object.hasOwn(order, "$meta")) continue
          readablePath(scope, field, "$search sort")
        }
        break
    }
  }
  if (operators !== 1) fail("$search needs exactly one operator")
  return { $search: value }
}

/** Checks a `$vectorSearch.filter`: only the operators it supports, on readable fields. */
function vectorFilter(scope: SearchScope, value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) fail("The $vectorSearch filter is nested too deeply")
  if (!isDocument(value)) fail("$vectorSearch filter needs a document")
  for (const [key, item] of Object.entries(value)) {
    if (VECTOR_FILTER_LOGICAL.has(key)) {
      if (!Array.isArray(item) || item.length === 0) fail(`${key} needs a list of filters`)
      for (const inner of item) vectorFilter(scope, inner, depth + 1)
      continue
    }
    if (key.startsWith("$")) fail(`The $vectorSearch filter operator ${key} is not allowed`)
    readablePath(scope, key, "$vectorSearch filter")
    condition(item, depth + 1)
  }
}

function condition(value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) fail("The $vectorSearch filter is nested too deeply")
  if (!isDocument(value)) return
  const keys = Object.keys(value)
  if (keys.length === 0 || !keys.every((key) => key.startsWith("$"))) return
  for (const key of keys) {
    if (!VECTOR_FILTER_OPERATORS.has(key))
      fail(`The $vectorSearch filter operator ${key} is not allowed`)
    if (key === "$not") condition(value[key], depth + 1)
  }
}

function positive(value: unknown, what: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail(`${what} needs a positive integer`)
  if (value > max) fail(`${what} may not be more than ${max}`)
  return value
}

function vectorSearch(scope: SearchScope, value: unknown): Stage {
  if (!isDocument(value)) fail("$vectorSearch needs a document")
  for (const key of Object.keys(value))
    if (!VECTOR_KEYS.has(key)) fail(`The $vectorSearch option ${key} is not allowed`)
  if (typeof value["index"] !== "string" || value["index"] === "")
    fail("$vectorSearch needs an index")
  readablePath(scope, value["path"], "$vectorSearch")
  const vector = value["queryVector"]
  if (
    !Array.isArray(vector) ||
    vector.length === 0 ||
    vector.length > MAX_DIMENSIONS ||
    !vector.every((item) => typeof item === "number" && Number.isFinite(item))
  )
    fail(`$vectorSearch queryVector needs 1 to ${MAX_DIMENSIONS} numbers`)
  const limit = positive(value["limit"], "$vectorSearch limit", scope.maxResults)
  const exact = value["exact"]
  if (exact !== undefined && typeof exact !== "boolean")
    fail("$vectorSearch exact needs true or false")
  if (exact !== true) {
    const candidates = positive(
      value["numCandidates"],
      "$vectorSearch numCandidates",
      MAX_CANDIDATES,
    )
    if (candidates < limit) fail("$vectorSearch numCandidates may not be less than limit")
  } else if (value["numCandidates"] !== undefined) {
    fail("$vectorSearch numCandidates does not apply to an exact search")
  }
  if (value["filter"] !== undefined) vectorFilter(scope, value["filter"], 1)
  return { $vectorSearch: value }
}

/**
 * Checks a `$search` or `$vectorSearch` stage of a caller who is not `service`: only documented operators and
 * options, and every field it searches, sorts, highlights or filters on readable for the caller. Throws
 * {@link InvalidQueryError}.
 */
export function secureSearchStage(scope: SearchScope, name: string, value: unknown): Stage {
  return name === "$search" ? search(scope, value) : vectorSearch(scope, value)
}
