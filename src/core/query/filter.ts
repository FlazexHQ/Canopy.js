import { isLinearRegex, isMatcherSafe } from "../matcher/index.ts"
import { InvalidQueryError, isDocument, isForbiddenKey, regexParts } from "../protocol/index.ts"
import { DEFAULT_LIMITS, type QueryLimits } from "./limits.ts"
import { validatePath } from "./paths.ts"

/**
 * Where a filter comes from. Each context has its own operator allowlist:
 * `filter` is a caller's query, `using` a policy clause evaluated in process and by MongoDB, and `check` a
 * policy clause evaluated only by MongoDB inside the write transaction.
 */
export type FilterContext = "filter" | "using" | "check"

/** Options for {@link parseFilter}. */
export interface ParseFilterOptions {
  readonly context?: FilterContext
  readonly limits?: QueryLimits
  /** Accept policy variables (`$auth`, `$ctx`, `$now`) in value positions. */
  readonly variables?: boolean
  /**
   * Accept `$expr` in a caller filter, with the variables an aggregation pipeline binds (`$$name`, starting
   * with a lower case letter). Used for the `$match` stages of sanitized aggregations.
   */
  readonly expressions?: boolean
}

/** The result of validating a filter. */
export interface ParsedFilter {
  readonly filter: Record<string, unknown>
  /** Every field path the filter reads, with `$elemMatch` prefixes resolved. */
  readonly paths: readonly string[]
  /** Whether the filter can be evaluated by the in-process matcher. */
  readonly matcherSafe: boolean
  /** Whether the filter contains policy variables. */
  readonly hasVariables: boolean
}

const LOGICAL = new Set(["$and", "$or", "$nor"])
const MATCHER_FIELD_OPERATORS = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$type",
  "$all",
  "$elemMatch",
  "$size",
  "$mod",
  "$regex",
  "$options",
  "$not",
])
const FILTER_ONLY_FIELD_OPERATORS = new Set([
  "$geoWithin",
  "$geoIntersects",
  "$near",
  "$nearSphere",
  "$bitsAllSet",
  "$bitsAnySet",
  "$bitsAllClear",
  "$bitsAnyClear",
])
const BANNED_EXPRESSIONS = new Set(["$function", "$accumulator", "$where"])
const ALLOWED_SYSTEM_VARIABLES = new Set(["$$NOW", "$$ROOT", "$$CURRENT", "$$REMOVE"])
const VARIABLE_KEYS = new Set(["$auth", "$ctx", "$now"])
const USER_VARIABLE = /^\$\$[a-z][A-Za-z0-9_]*$/

/** Returns true when `value` is a policy variable such as `{ $auth: 'sub' }`. */
export function isVariable(value: unknown): value is Record<string, unknown> {
  if (!isDocument(value)) return false
  const keys = Object.keys(value)
  const first = keys[0]
  return first !== undefined && VARIABLE_KEYS.has(first)
}

interface State {
  readonly context: FilterContext
  readonly limits: QueryLimits
  readonly variables: boolean
  readonly expressions: boolean
  readonly paths: Set<string>
  nodes: number
  hasVariables: boolean
}

function fail(message: string): never {
  throw new InvalidQueryError(message)
}

function count(state: State, amount: number): void {
  state.nodes += amount
  if (state.nodes > state.limits.maxNodes)
    fail(`A query may not have more than ${state.limits.maxNodes} values`)
}

function checkDepth(state: State, depth: number): void {
  if (depth > state.limits.maxDepth)
    fail(`A query may not nest deeper than ${state.limits.maxDepth} levels`)
}

/**
 * Validates an untrusted filter against the allowlist of its context and the query limits, and reports the
 * paths it reads. Throws {@link InvalidQueryError} with a reason a caller can act on.
 */
export function parseFilter(input: unknown, options: ParseFilterOptions = {}): ParsedFilter {
  const state: State = {
    context: options.context ?? "filter",
    limits: options.limits ?? DEFAULT_LIMITS,
    variables: options.variables ?? false,
    expressions: options.expressions ?? false,
    paths: new Set(),
    nodes: 0,
    hasVariables: false,
  }
  if (!isDocument(input)) fail("A filter must be a document")
  validateFilterDocument(input, state, 1, "")
  const matcherSafe = state.context === "filter" ? isMatcherSafe(input) : state.context === "using"
  return { filter: input, paths: [...state.paths], matcherSafe, hasVariables: state.hasVariables }
}

function validateFilterDocument(
  doc: Record<string, unknown>,
  state: State,
  depth: number,
  prefix: string,
): void {
  checkDepth(state, depth)
  const keys = Object.keys(doc)
  count(state, keys.length)
  for (const key of keys) {
    const value = doc[key]
    if (key.startsWith("$")) {
      validateTopOperator(key, value, state, depth, prefix)
      continue
    }
    validatePath(key, { maxLength: state.limits.maxPathLength })
    const path = prefix === "" ? key : `${prefix}.${key}`
    state.paths.add(path)
    validateCondition(value, path, state, depth + 1)
  }
}

function validateTopOperator(
  key: string,
  value: unknown,
  state: State,
  depth: number,
  prefix: string,
): void {
  if (LOGICAL.has(key)) {
    if (!Array.isArray(value) || value.length === 0) fail(`${key} must be a nonempty array`)
    count(state, value.length)
    for (const branch of value) {
      if (!isDocument(branch)) fail(`${key} entries must be documents`)
      validateFilterDocument(branch, state, depth + 1, prefix)
    }
    return
  }
  if (key === "$expr") {
    if (state.context !== "check" && !state.expressions)
      fail("$expr is only allowed in check clauses")
    validateExpression(value, state, depth + 1)
    return
  }
  if (key === "$jsonSchema") {
    if (state.context !== "check") fail("$jsonSchema is only allowed in check clauses")
    if (!isDocument(value)) fail("$jsonSchema must be a document")
    validateLiteral(value, state, depth + 1, true)
    return
  }
  if (key === "$text") {
    if (state.context !== "filter" || prefix !== "" || depth !== 1)
      fail("$text is only allowed at the top level of a query")
    if (!isDocument(value)) fail("$text must be a document")
    validateLiteral(value, state, depth + 1, true)
    return
  }
  if (key === "$comment") {
    if (state.context !== "filter") fail("$comment is not allowed in policies")
    if (typeof value !== "string") fail("$comment must be a string")
    return
  }
  fail(`The operator ${key} is not allowed`)
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isDocument(value) || isVariable(value)) return false
  const first = Object.keys(value)[0]
  return first?.startsWith("$") ?? false
}

function validateCondition(value: unknown, path: string, state: State, depth: number): void {
  checkDepth(state, depth)
  if (regexParts(value) !== undefined) {
    validateRegex(value, state)
    return
  }
  if (isOperatorObject(value)) {
    validateOperators(value, path, state, depth)
    return
  }
  validateValue(value, state, depth)
}

function validateOperators(
  ops: Record<string, unknown>,
  path: string,
  state: State,
  depth: number,
): void {
  const keys = Object.keys(ops)
  count(state, keys.length)
  for (const op of keys) {
    const operand = ops[op]
    if (!op.startsWith("$"))
      fail(`Unknown operator ${op} at ${path}: operators and fields cannot be mixed`)
    if (FILTER_ONLY_FIELD_OPERATORS.has(op)) {
      if (state.context !== "filter") fail(`${op} is not allowed in policies`)
      validateLiteral(operand, state, depth + 1, true)
      continue
    }
    if (!MATCHER_FIELD_OPERATORS.has(op)) fail(`The operator ${op} is not allowed`)
    switch (op) {
      case "$eq":
      case "$ne":
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte":
        validateValue(operand, state, depth + 1)
        break
      case "$in":
      case "$nin":
      case "$all":
        validateList(op, operand, path, state, depth + 1)
        break
      case "$exists":
        if (typeof operand !== "boolean" && typeof operand !== "number")
          fail("$exists needs a boolean")
        break
      case "$type":
        if (Array.isArray(operand)) {
          count(state, operand.length)
          if (!operand.every((item) => typeof item === "string" || typeof item === "number")) {
            fail("$type needs type names or codes")
          }
        } else if (typeof operand !== "string" && typeof operand !== "number") {
          fail("$type needs a type name or code")
        }
        break
      case "$size":
        if (typeof operand !== "number") fail("$size needs a number")
        break
      case "$mod":
        if (
          !Array.isArray(operand) ||
          operand.length !== 2 ||
          !operand.every((item) => typeof item === "number")
        ) {
          fail("$mod needs [divisor, remainder]")
        }
        break
      case "$regex": {
        const pattern = typeof operand === "string" ? operand : regexParts(operand)?.pattern
        if (pattern === undefined) fail("$regex needs a string or a regular expression")
        const options =
          typeof ops["$options"] === "string"
            ? ops["$options"]
            : (regexParts(operand)?.options ?? "")
        validateRegexParts(pattern, options, state)
        break
      }
      case "$options":
        if (typeof operand !== "string" || !/^[imsxu]*$/.test(operand))
          fail("$options must be a string of imsxu")
        if (!keys.includes("$regex")) fail("$options needs a $regex")
        break
      case "$elemMatch":
        validateElemMatch(operand, path, state, depth + 1)
        break
      case "$not":
        if (regexParts(operand) !== undefined) {
          validateRegex(operand, state)
        } else if (isOperatorObject(operand)) {
          validateOperators(operand, path, state, depth + 1)
        } else {
          fail("$not needs a regular expression or a document of operators")
        }
        break
      default:
        fail(`The operator ${op} is not allowed`)
    }
  }
}

function validateList(
  op: string,
  operand: unknown,
  path: string,
  state: State,
  depth: number,
): void {
  if (isVariable(operand)) {
    validateVariable(operand, state)
    return
  }
  if (!Array.isArray(operand)) fail(`${op} needs an array`)
  if (operand.length > state.limits.maxInList)
    fail(`${op} may not have more than ${state.limits.maxInList} values`)
  count(state, operand.length)
  for (const item of operand) {
    if (op === "$all" && isDocument(item) && Object.keys(item)[0] === "$elemMatch") {
      validateElemMatch(item["$elemMatch"], path, state, depth + 1)
    } else if (regexParts(item) !== undefined) {
      if (op === "$all") fail("$all does not accept regular expressions here")
      validateRegex(item, state)
    } else {
      validateValue(item, state, depth + 1)
    }
  }
}

function isOperatorKey(key: string): boolean {
  return key.startsWith("$") && !LOGICAL.has(key)
}

function validateElemMatch(operand: unknown, path: string, state: State, depth: number): void {
  if (!isDocument(operand)) fail("$elemMatch needs a document")
  const first = Object.keys(operand)[0]
  if (first !== undefined && isOperatorKey(first)) {
    validateOperators(operand, path, state, depth)
    return
  }
  validateFilterDocument(operand, state, depth, path)
}

function validateRegex(value: unknown, state: State): void {
  const parts = regexParts(value)
  if (parts === undefined) fail("expected a regular expression")
  validateRegexParts(parts.pattern, parts.options, state)
}

function validateRegexParts(pattern: string, options: string, state: State): void {
  if (pattern.length > state.limits.maxRegexLength) {
    fail(`A regular expression may not be longer than ${state.limits.maxRegexLength} characters`)
  }
  if (!/^[imsxu]*$/.test(options)) fail(`Unsupported regular expression options: ${options}`)
  if (state.context === "using" && !isLinearRegex(pattern, options)) {
    fail(
      "Regular expressions in using clauses must be compatible with a linear time engine (no backreferences or lookaround)",
    )
  }
}

function validateValue(value: unknown, state: State, depth: number): void {
  if (isVariable(value)) {
    validateVariable(value, state)
    return
  }
  validateLiteral(value, state, depth, false)
}

function validateVariable(value: Record<string, unknown>, state: State): void {
  if (!state.variables)
    fail(`Variables such as ${Object.keys(value)[0] ?? ""} are only allowed in policies`)
  state.hasVariables = true
  count(state, Object.keys(value).length)
}

function validateLiteral(
  value: unknown,
  state: State,
  depth: number,
  allowDollarKeys: boolean,
): void {
  checkDepth(state, depth)
  if (Array.isArray(value)) {
    count(state, value.length)
    for (const item of value) validateLiteral(item, state, depth + 1, allowDollarKeys)
    return
  }
  if (!isDocument(value)) return
  const keys = Object.keys(value)
  count(state, keys.length)
  for (const key of keys) {
    if (isForbiddenKey(key)) fail(`The key "${key}" is not allowed`)
    if (key.startsWith("$") && !allowDollarKeys) fail(`The key ${key} is not allowed in a value`)
    validateLiteral(value[key], state, depth + 1, allowDollarKeys)
  }
}

/**
 * Validates an aggregation expression from an untrusted caller: `$function`, `$accumulator` and `$where`
 * are rejected at any depth, and so are system variables other than `$$NOW`, `$$ROOT`, `$$CURRENT` and
 * `$$REMOVE`. Variables bound by the pipeline (`$$name`) are accepted. Throws {@link InvalidQueryError}.
 */
export function parseExpression(input: unknown, limits: QueryLimits = DEFAULT_LIMITS): void {
  const state: State = {
    context: "filter",
    limits,
    variables: false,
    expressions: true,
    paths: new Set(),
    nodes: 0,
    hasVariables: false,
  }
  validateExpression(input, state, 1)
}

function validateExpression(value: unknown, state: State, depth: number): void {
  checkDepth(state, depth)
  if (typeof value === "string") {
    if (value.startsWith("$$")) {
      const name = value.split(".")[0] ?? value
      if (!ALLOWED_SYSTEM_VARIABLES.has(name) && !(state.expressions && USER_VARIABLE.test(name)))
        fail(`The system variable ${name} is not allowed`)
    }
    return
  }
  if (Array.isArray(value)) {
    count(state, value.length)
    for (const item of value) validateExpression(item, state, depth + 1)
    return
  }
  if (isVariable(value)) {
    validateVariable(value, state)
    return
  }
  if (!isDocument(value)) return
  const keys = Object.keys(value)
  count(state, keys.length)
  for (const key of keys) {
    if (isForbiddenKey(key)) fail(`The key "${key}" is not allowed`)
    if (BANNED_EXPRESSIONS.has(key)) fail(`The expression ${key} is never allowed`)
    validateExpression(value[key], state, depth + 1)
  }
}
