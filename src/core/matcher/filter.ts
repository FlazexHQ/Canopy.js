import { InvalidQueryError, isDocument, regexParts } from "../protocol/index.ts"
import { Bracket, type BsonType, bracketOf, bsonTypeOf, compareValues } from "./compare.ts"
import { equalityKey } from "./equality-key.ts"
import { UnsupportedQueryError } from "./errors.ts"
import { isNaNValue, readNumeric, toDouble } from "./numeric.ts"
import { anyPathValue, type LeafTest, splitPath } from "./path.ts"
import type { LinearRegex } from "./regex.ts"

/** A document test compiled from a MongoDB filter. */
export type DocTest = (doc: unknown) => boolean

/** A filter compiled for in-process evaluation. */
export interface CompiledFilter {
  /** Returns true when `doc` matches the filter. */
  matches(doc: unknown): boolean
}

const LOGICAL = new Set(["$and", "$or", "$nor"])
const UNSUPPORTED_TOP = new Set([
  "$expr",
  "$where",
  "$text",
  "$jsonSchema",
  "$comment",
  "$sampleRate",
])
const UNSUPPORTED_FIELD = new Set([
  "$geoWithin",
  "$geoIntersects",
  "$near",
  "$nearSphere",
  "$within",
  "$bitsAllSet",
  "$bitsAnySet",
  "$bitsAllClear",
  "$bitsAnyClear",
  "$jsonSchema",
])

const TYPE_ALIASES: Readonly<Record<string, readonly BsonType[]>> = {
  double: ["double"],
  string: ["string"],
  object: ["object"],
  array: ["array"],
  binData: ["binData"],
  undefined: ["undefined"],
  objectId: ["objectId"],
  bool: ["bool"],
  date: ["date"],
  null: ["null"],
  regex: ["regex"],
  javascript: ["javascript"],
  symbol: ["symbol"],
  int: ["int"],
  timestamp: ["timestamp"],
  long: ["long"],
  decimal: ["decimal"],
  minKey: ["minKey"],
  maxKey: ["maxKey"],
  number: ["double", "int", "long", "decimal"],
}

const TYPE_CODES: Readonly<Record<number, readonly BsonType[]>> = {
  1: ["double"],
  2: ["string"],
  3: ["object"],
  4: ["array"],
  5: ["binData"],
  6: ["undefined"],
  7: ["objectId"],
  8: ["bool"],
  9: ["date"],
  10: ["null"],
  11: ["regex"],
  13: ["javascript"],
  14: ["symbol"],
  16: ["int"],
  17: ["timestamp"],
  18: ["long"],
  19: ["decimal"],
  [-1]: ["minKey"],
  127: ["maxKey"],
}

function invalid(message: string): never {
  throw new InvalidQueryError(message)
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isDocument(value)) return false
  const first = Object.keys(value)[0]
  return first?.startsWith("$") ?? false
}

function isRegexValue(value: unknown): boolean {
  return regexParts(value) !== undefined
}

/** Compiles a `$regex` pattern into a linear time test. */
export type RegexEngine = (pattern: string, options: string) => LinearRegex

/**
 * Compiles a MongoDB query filter into a document test. Supports the matcher safe operators: comparisons, `$in`/`$nin`,
 * `$exists`, `$type`, logical operators, `$all`, `$elemMatch`, `$size`, `$mod` and linear time `$regex`.
 * `regex` compiles regular expressions; without one, `$regex` throws {@link UnsupportedQueryError}, which is
 * how `@canopy/matcher/lite` keeps the regex translator out of browser bundles. Throws
 * {@link UnsupportedQueryError} for valid constructs the matcher does not evaluate, and
 * {@link InvalidQueryError} for filters MongoDB would reject.
 */
export function compileFilterWith(filter: unknown, regex: RegexEngine | undefined): CompiledFilter {
  if (!isDocument(filter)) invalid("A filter must be a document")
  const test = compileDocument(filter, regex)
  return { matches: test }
}

/** Returns true when every operator in `filter` can be evaluated in process. */
export function isMatcherSafeWith(filter: unknown, regex: RegexEngine | undefined): boolean {
  try {
    compileFilterWith(filter, regex)
    return true
  } catch (error: unknown) {
    if (error instanceof UnsupportedQueryError) return false
    throw error
  }
}

function and(tests: readonly DocTest[]): DocTest {
  if (tests.length === 0) return () => true
  if (tests.length === 1) return tests[0] as DocTest
  return (doc) => {
    for (const test of tests) if (!test(doc)) return false
    return true
  }
}

function compileDocument(filter: Record<string, unknown>, regex: RegexEngine | undefined): DocTest {
  const tests: DocTest[] = []
  for (const key of Object.keys(filter)) {
    const value = filter[key]
    if (key.startsWith("$")) {
      tests.push(compileTopOperator(key, value, regex))
    } else {
      if (key === "") invalid("A field path may not be empty")
      tests.push(compileFieldCondition(key, value, regex))
    }
  }
  return and(tests)
}

function compileTopOperator(key: string, value: unknown, regex: RegexEngine | undefined): DocTest {
  if (LOGICAL.has(key)) {
    if (!Array.isArray(value) || value.length === 0) invalid(`${key} must be a nonempty array`)
    const branches = value.map((branch) => {
      if (!isDocument(branch)) invalid(`${key} argument entries must be objects`)
      return compileDocument(branch, regex)
    })
    if (key === "$and") return and(branches)
    const any: DocTest = (doc) => {
      for (const branch of branches) if (branch(doc)) return true
      return false
    }
    return key === "$or" ? any : (doc) => !any(doc)
  }
  if (UNSUPPORTED_TOP.has(key))
    throw new UnsupportedQueryError(`${key} is not evaluated in process`)
  return invalid(`unknown top level operator: ${key}`)
}

function compileFieldCondition(
  path: string,
  value: unknown,
  regex: RegexEngine | undefined,
): DocTest {
  const parts = splitPath(path)
  if (parts.some((part) => part === "")) invalid(`Invalid field path: ${path}`)
  if (isRegexValue(value)) {
    const leaf = regexLeaf(value, regex)
    return (doc) => anyPathValue(doc, parts, true, leaf)
  }
  if (isOperatorObject(value)) return compileOperators(parts, value, regex)
  const leaf = eqLeaf(value)
  return (doc) => anyPathValue(doc, parts, true, leaf)
}

function compileOperators(
  parts: readonly string[],
  ops: Record<string, unknown>,
  regex: RegexEngine | undefined,
): DocTest {
  const keys = Object.keys(ops)
  const tests: DocTest[] = []
  const hasRegex = keys.includes("$regex")
  if (keys.includes("$options") && !hasRegex) invalid("$options needs a $regex")
  for (const key of keys) {
    if (!key.startsWith("$")) invalid(`unknown operator: ${key}`)
    if (key === "$options") continue
    if (key === "$regex") {
      const leaf = regexLeaf(regexFromOperator(ops["$regex"], ops["$options"]), regex)
      tests.push((doc) => anyPathValue(doc, parts, true, leaf))
      continue
    }
    tests.push(compileOperator(parts, key, ops[key], regex))
  }
  return and(tests)
}

function compileOperator(
  parts: readonly string[],
  op: string,
  operand: unknown,
  regex: RegexEngine | undefined,
): DocTest {
  const expand =
    (leaf: LeafTest): DocTest =>
    (doc) =>
      anyPathValue(doc, parts, true, leaf)
  switch (op) {
    case "$eq":
      return expand(eqLeaf(operand))
    case "$ne": {
      if (isRegexValue(operand)) invalid("Can't have regex as arg to $ne.")
      const eq = expand(eqLeaf(operand))
      return (doc) => !eq(doc)
    }
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte":
      return expand(comparisonLeaf(op, operand))
    case "$in":
      return expand(inLeaf(operand, "$in", regex))
    case "$nin": {
      const test = expand(inLeaf(operand, "$nin", regex))
      return (doc) => !test(doc)
    }
    case "$exists": {
      const exists: DocTest = (doc) =>
        anyPathValue(doc, parts, false, (value) => value !== undefined)
      return truthy(operand) ? exists : (doc) => !exists(doc)
    }
    case "$type":
      return expand(typeLeaf(operand))
    case "$size": {
      const size = sizeOperand(operand)
      return (doc) =>
        anyPathValue(doc, parts, false, (value) => Array.isArray(value) && value.length === size)
    }
    case "$mod":
      return expand(modLeaf(operand))
    case "$all":
      return compileAll(parts, operand, regex)
    case "$elemMatch":
      return compileElemMatch(parts, operand, regex)
    case "$not":
      return compileNot(parts, operand, regex)
    default:
      if (UNSUPPORTED_FIELD.has(op))
        throw new UnsupportedQueryError(`${op} is not evaluated in process`)
      return invalid(`unknown operator: ${op}`)
  }
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value
  const numeric = readNumeric(value)
  if (numeric !== undefined) return toDouble(numeric) !== 0
  return value !== null && value !== undefined
}

/** Returns true for the BSON null and undefined types and for missing values. */
function isNullish(value: unknown): boolean {
  if (value === null || value === undefined) return true
  return bsonTypeOf(value) === "undefined"
}

function eqLeaf(operand: unknown): LeafTest {
  if (operand === null) return isNullish
  if (operand === undefined) invalid("Cannot compare with undefined")
  const bracket = bracketOf(operand)
  const numeric = readNumeric(operand)
  if (numeric !== undefined && isNaNValue(numeric)) {
    return (value) => {
      const n = readNumeric(value)
      return n !== undefined && isNaNValue(n)
    }
  }
  const key = equalityKey(operand)
  if (key !== undefined && bracket !== Bracket.Number) {
    return (value) => equalityKey(value) === key
  }
  return (value) =>
    value !== undefined && bracketOf(value) === bracket && compareValues(value, operand) === 0
}

function comparisonLeaf(op: "$gt" | "$gte" | "$lt" | "$lte", operand: unknown): LeafTest {
  if (operand === undefined) invalid(`${op} needs a value`)
  if (isRegexValue(operand)) invalid(`Can't have RegEx as arg to non-equality predicate`)
  const inclusive = op === "$gte" || op === "$lte"
  const accept = (cmp: number): boolean => {
    switch (op) {
      case "$gt":
        return cmp > 0
      case "$gte":
        return cmp >= 0
      case "$lt":
        return cmp < 0
      case "$lte":
        return cmp <= 0
    }
  }
  if (operand === null) return inclusive ? isNullish : () => false
  const bracket = bracketOf(operand)
  if (bracket === Bracket.MinKey || bracket === Bracket.MaxKey) {
    return (value) => accept(compareValues(value === undefined ? null : value, operand))
  }
  const operandNumeric = readNumeric(operand)
  const operandNaN = operandNumeric !== undefined && isNaNValue(operandNumeric)
  return (value) => {
    if (value === undefined || bracketOf(value) !== bracket) return false
    if (bracket === Bracket.Number) {
      const n = readNumeric(value)
      const valueNaN = n !== undefined && isNaNValue(n)
      if (valueNaN || operandNaN) return inclusive && valueNaN && operandNaN
    }
    return accept(compareValues(value, operand))
  }
}

function inLeaf(operand: unknown, op: string, regex: RegexEngine | undefined): LeafTest {
  if (!Array.isArray(operand)) invalid(`${op} needs an array`)
  const keyed = new Set<string>()
  const keyedNumbers: LeafTest[] = []
  const regexes: LeafTest[] = []
  const others: LeafTest[] = []
  let matchesNull = false
  for (const item of operand) {
    if (isOperatorObject(item)) invalid(`cannot nest $ under ${op}`)
    if (isRegexValue(item)) {
      regexes.push(regexLeaf(item, regex))
      continue
    }
    if (item === null) {
      matchesNull = true
      continue
    }
    const key = equalityKey(item)
    if (key === undefined) {
      others.push(eqLeaf(item))
      continue
    }
    keyed.add(key)
    if (bracketOf(item) === Bracket.Number) keyedNumbers.push(eqLeaf(item))
  }
  return (value) => {
    if (matchesNull && isNullish(value)) return true
    if (value === undefined) return false
    if (keyed.size > 0) {
      const key = equalityKey(value)
      if (key !== undefined) {
        if (keyed.has(key)) return true
      } else if (keyedNumbers.length > 0 && bracketOf(value) === Bracket.Number) {
        for (const test of keyedNumbers) if (test(value)) return true
      }
    }
    for (const test of others) if (test(value)) return true
    for (const test of regexes) if (test(value)) return true
    return false
  }
}

function typeLeaf(operand: unknown): LeafTest {
  const specs = Array.isArray(operand) ? operand : [operand]
  if (specs.length === 0) invalid("$type must match at least one type")
  const wanted = new Set<BsonType>()
  for (const spec of specs) {
    if (typeof spec === "string") {
      const types = TYPE_ALIASES[spec]
      if (types === undefined) invalid(`Unknown type name alias: ${spec}`)
      for (const type of types) wanted.add(type)
      continue
    }
    const numeric = readNumeric(spec)
    if (numeric === undefined) invalid("type must be represented as a number or a string")
    const code = toDouble(numeric)
    const types = Number.isInteger(code) ? TYPE_CODES[code] : undefined
    if (types === undefined) invalid(`Invalid numerical type code: ${code}`)
    for (const type of types) wanted.add(type)
  }
  return (value) => value !== undefined && wanted.has(bsonTypeOf(value))
}

function sizeOperand(operand: unknown): number {
  const numeric = readNumeric(operand)
  if (numeric === undefined) invalid("$size needs a number")
  const size = toDouble(numeric)
  if (!Number.isInteger(size)) invalid("$size must be a whole number")
  if (size < 0) invalid("$size may not be negative")
  return size
}

function modLeaf(operand: unknown): LeafTest {
  if (!Array.isArray(operand) || operand.length !== 2) {
    invalid("malformed mod, needs to be an array of [divisor, remainder]")
  }
  const divisorNumeric = readNumeric(operand[0])
  const remainderNumeric = readNumeric(operand[1])
  if (divisorNumeric === undefined || remainderNumeric === undefined) {
    invalid("malformed mod, divisor and remainder must be numbers")
  }
  const divisorDouble = toDouble(divisorNumeric)
  const remainderDouble = toDouble(remainderNumeric)
  if (!Number.isFinite(divisorDouble) || !Number.isFinite(remainderDouble)) {
    invalid("malformed mod, divisor and remainder must be finite")
  }
  const divisor = truncToBigInt(divisorDouble)
  const remainder = truncToBigInt(remainderDouble)
  if (divisor === 0n) invalid("divisor cannot be 0")
  return (value) => {
    const numeric = readNumeric(value)
    if (numeric === undefined) return false
    let dividend: bigint
    if (numeric.kind === "long") {
      dividend = numeric.value
    } else {
      const double = toDouble(numeric)
      if (!Number.isFinite(double)) return false
      dividend = truncToBigInt(double)
    }
    return dividend % divisor === remainder
  }
}

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

function truncToBigInt(value: number): bigint {
  const truncated = BigInt(Math.trunc(value))
  if (truncated < INT64_MIN) return INT64_MIN
  if (truncated > INT64_MAX) return INT64_MAX
  return truncated
}

function regexFromOperator(pattern: unknown, options: unknown): unknown {
  if (options !== undefined && typeof options !== "string") invalid("$options has to be a string")
  if (typeof pattern === "string") {
    return { _bsontype: "BSONRegExp", pattern, options: options ?? "" }
  }
  const parts = regexParts(pattern)
  if (parts === undefined) invalid("$regex has to be a string")
  if (options !== undefined && parts.options !== "") {
    invalid("options set in both $regex and $options")
  }
  return { _bsontype: "BSONRegExp", pattern: parts.pattern, options: options ?? parts.options }
}

function regexLeaf(value: unknown, regex: RegexEngine | undefined): LeafTest {
  const parts = regexParts(value)
  if (parts === undefined) return invalid("expected a regular expression")
  if (regex === undefined)
    throw new UnsupportedQueryError("$regex needs the full matcher, not @canopy/matcher/lite")
  const compiled: LinearRegex = regex(parts.pattern, parts.options)
  const sortedOptions = [...parts.options].sort().join("")
  return (candidate) => {
    if (typeof candidate === "string") return compiled.test(candidate)
    const type = bsonTypeOf(candidate)
    if (type === "symbol") return compiled.test(String((candidate as { value?: unknown }).value))
    if (type === "regex") {
      const other = regexParts(candidate)
      return (
        other !== undefined && other.pattern === parts.pattern && other.options === sortedOptions
      )
    }
    return false
  }
}

function compileAll(
  parts: readonly string[],
  operand: unknown,
  regex: RegexEngine | undefined,
): DocTest {
  if (!Array.isArray(operand)) invalid("$all needs an array")
  if (operand.length === 0) return () => false
  const elemMatches = operand.filter(
    (item) => isDocument(item) && Object.keys(item)[0] === "$elemMatch",
  )
  if (elemMatches.length > 0 && elemMatches.length !== operand.length) {
    invalid("$all/$elemMatch has to be consistent")
  }
  const tests = operand.map((item) => {
    if (elemMatches.length > 0) {
      return compileElemMatch(parts, (item as Record<string, unknown>)["$elemMatch"], regex)
    }
    if (isOperatorObject(item)) invalid("no $ expressions in $all")
    const leaf = isRegexValue(item) ? regexLeaf(item, regex) : eqLeaf(item)
    return (doc: unknown) => anyPathValue(doc, parts, true, leaf)
  })
  return and(tests)
}

function isValueOperator(key: string): boolean {
  return key.startsWith("$") && !LOGICAL.has(key) && key !== "$expr"
}

function compileElemMatch(
  parts: readonly string[],
  operand: unknown,
  regex: RegexEngine | undefined,
): DocTest {
  if (!isDocument(operand)) invalid("$elemMatch needs an Object")
  const first = Object.keys(operand)[0]
  const valueForm = first !== undefined && isValueOperator(first)
  let element: LeafTest
  if (valueForm) {
    const tests = Object.keys(operand).map((key) => {
      if (key === "$options") return undefined
      if (key === "$regex") {
        return regexLeaf(regexFromOperator(operand["$regex"], operand["$options"]), regex)
      }
      return valueOperatorLeaf(key, operand[key], regex)
    })
    const leaves = tests.filter((test): test is LeafTest => test !== undefined)
    element = (value) => leaves.every((leaf) => leaf(value))
  } else {
    const test = compileDocument(operand, regex)
    element = (value) => {
      if (isDocument(value)) return test(value)
      return Array.isArray(value) && test(arrayAsDocument(value))
    }
  }
  return (doc) =>
    anyPathValue(
      doc,
      parts,
      false,
      (value) => Array.isArray(value) && value.some((item) => element(item)),
    )
}

function arrayAsDocument(value: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  value.forEach((element, index) => {
    out[String(index)] = element
  })
  return out
}

function valueOperatorLeaf(op: string, operand: unknown, regex: RegexEngine | undefined): LeafTest {
  switch (op) {
    case "$eq":
      return eqLeaf(operand)
    case "$ne": {
      if (isRegexValue(operand)) invalid("Can't have regex as arg to $ne.")
      const eq = eqLeaf(operand)
      return (value) => !eq(value)
    }
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte":
      return comparisonLeaf(op, operand)
    case "$in":
      return inLeaf(operand, op, regex)
    case "$nin": {
      const test = inLeaf(operand, op, regex)
      return (value) => !test(value)
    }
    case "$exists": {
      const wanted = truthy(operand)
      return (value) => (value !== undefined) === wanted
    }
    case "$type":
      return typeLeaf(operand)
    case "$size": {
      const size = sizeOperand(operand)
      return (value) => Array.isArray(value) && value.length === size
    }
    case "$mod":
      return modLeaf(operand)
    case "$elemMatch": {
      const test = compileElemMatch([], operand, regex)
      return (value) => test(value)
    }
    case "$all":
      return singleAllLeaf(operand, regex)
    case "$not":
      return singleNotLeaf(operand, regex)
    default:
      if (UNSUPPORTED_FIELD.has(op))
        throw new UnsupportedQueryError(`${op} is not evaluated in process`)
      return invalid(`unknown operator: ${op}`)
  }
}

function singleAllLeaf(operand: unknown, regex: RegexEngine | undefined): LeafTest {
  if (!Array.isArray(operand)) invalid("$all needs an array")
  if (operand.length === 0) return () => false
  const leaves = operand.map((item) => {
    if (isDocument(item) && Object.keys(item)[0] === "$elemMatch") {
      const test = compileElemMatch([], item["$elemMatch"], regex)
      return (value: unknown) => test(value)
    }
    if (isOperatorObject(item)) invalid("no $ expressions in $all")
    return isRegexValue(item) ? regexLeaf(item, regex) : eqLeaf(item)
  })
  return (value) => leaves.every((leaf) => leaf(value))
}

function singleNotLeaf(operand: unknown, regex: RegexEngine | undefined): LeafTest {
  if (isRegexValue(operand)) {
    const leaf = regexLeaf(operand, regex)
    return (value) => !leaf(value)
  }
  if (!isDocument(operand) || Object.keys(operand).length === 0)
    invalid("$not needs a regex or a document")
  const keys = Object.keys(operand)
  if (!keys.every((key) => key.startsWith("$")))
    invalid("$not needs a regex or a document of operators")
  const leaves = keys
    .filter((key) => key !== "$options")
    .map((key) =>
      key === "$regex"
        ? regexLeaf(regexFromOperator(operand["$regex"], operand["$options"]), regex)
        : valueOperatorLeaf(key, operand[key], regex),
    )
  return (value) => !leaves.every((leaf) => leaf(value))
}

function compileNot(
  parts: readonly string[],
  operand: unknown,
  regex: RegexEngine | undefined,
): DocTest {
  if (isRegexValue(operand)) {
    const leaf = regexLeaf(operand, regex)
    return (doc) => !anyPathValue(doc, parts, true, leaf)
  }
  if (!isDocument(operand)) invalid("$not needs a regex or a document")
  const keys = Object.keys(operand)
  if (keys.length === 0) invalid("$not cannot be empty")
  if (!keys.every((key) => key.startsWith("$")))
    invalid("$not needs a regex or a document of operators")
  if (keys.includes("$regex") === false && keys.includes("$options"))
    invalid("$options needs a $regex")
  const inner = compileOperators(parts, operand, regex)
  return (doc) => !inner(doc)
}
