import { isDocument, Long, longValue, regexParts, Timestamp } from "../protocol/index.ts"
import { bsonTypeOf, compareValues, valuesEqual } from "./compare.ts"
import { UnsupportedQueryError, UpdateError } from "./errors.ts"
import { compileFilterWith, type DocTest, type RegexEngine } from "./filter.ts"
import { readNumeric, toDouble } from "./numeric.ts"
import { isArrayIndex, splitPath } from "./path.ts"
import { compileSort } from "./sort.ts"

/** Options for {@link applyUpdate}. */
export interface UpdateOptions {
  /** Whether the update creates a new document through an upsert. Enables `$setOnInsert`. */
  readonly isInsert?: boolean
  /** Filters for `$[identifier]` positional updates. */
  readonly arrayFilters?: readonly Record<string, unknown>[]
  /** The clock used by `$currentDate`. Defaults to the current time. */
  readonly now?: Date
}

/** The update operators the in-process updater supports. */
export const UPDATE_OPERATORS: readonly string[] = [
  "$set",
  "$unset",
  "$inc",
  "$mul",
  "$min",
  "$max",
  "$currentDate",
  "$rename",
  "$setOnInsert",
  "$push",
  "$addToSet",
  "$pop",
  "$pull",
  "$pullAll",
  "$bit",
]

const OPERATORS = new Set(UPDATE_OPERATORS)
const MAX_PADDING = 1_500_000
const CREATING = new Set([
  "$rename-to",
  "$set",
  "$inc",
  "$mul",
  "$min",
  "$max",
  "$currentDate",
  "$setOnInsert",
  "$push",
  "$addToSet",
  "$bit",
])

interface Leaf {
  readonly op: string
  readonly operand: unknown
  readonly path: string
}

interface Node {
  readonly children: Map<string, Node>
  leaf: Leaf | undefined
  creates: boolean
  strict: boolean
}

function fail(message: string): never {
  throw new UpdateError(message)
}

function newNode(): Node {
  return { children: new Map(), leaf: undefined, creates: false, strict: false }
}

/** Returns true when `update` is an operator update rather than a replacement document. */
export function isOperatorUpdate(update: Record<string, unknown>): boolean {
  const keys = Object.keys(update)
  return keys.length > 0 && keys.every((key) => key.startsWith("$"))
}

interface Settings extends UpdateOptions {
  readonly regex: RegexEngine | undefined
}

/**
 * Applies a MongoDB update (operators or a replacement document) to a copy of `doc`, following MongoDB 5.0 and
 * later semantics, including lexicographic processing of new fields. The input is never modified. `regex`
 * compiles the regular expressions of `$pull` conditions and array filters; without one they throw
 * {@link UnsupportedQueryError}. Throws {@link UpdateError} where MongoDB would reject the update.
 */
export function applyUpdateWith(
  doc: Record<string, unknown>,
  update: unknown,
  options: UpdateOptions,
  regex: RegexEngine | undefined,
): Record<string, unknown> {
  if (Array.isArray(update))
    throw new UnsupportedQueryError("Pipeline updates are not evaluated in process")
  if (!isDocument(update)) fail("An update must be a document")
  const keys = Object.keys(update)
  if (keys.some((key) => key.startsWith("$"))) {
    if (!keys.every((key) => key.startsWith("$"))) fail("An update cannot mix operators and fields")
    return applyOperators(doc, update, { ...options, regex })
  }
  return applyReplacement(doc, update)
}

function applyReplacement(
  doc: Record<string, unknown>,
  replacement: Record<string, unknown>,
): Record<string, unknown> {
  validateStorage(replacement, "")
  const id = doc["_id"]
  if (
    replacement["_id"] !== undefined &&
    id !== undefined &&
    !valuesEqual(replacement["_id"], id)
  ) {
    fail("After applying the update, the (immutable) field '_id' was found to have been altered")
  }
  const out: Record<string, unknown> = {}
  if (id !== undefined) out["_id"] = id
  for (const key of Object.keys(replacement)) {
    if (key === "_id" && id !== undefined) continue
    out[key] = replacement[key]
  }
  return out
}

function validateStorage(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      validateStorage(element, `${path}.${index}`)
    })
    return
  }
  if (!isDocument(value)) return
  for (const key of Object.keys(value)) {
    if (key.startsWith("$")) {
      fail(
        `The dollar ($) prefixed field '${key}' in '${path === "" ? key : `${path}.${key}`}' is not allowed`,
      )
    }
    validateStorage(value[key], path === "" ? key : `${path}.${key}`)
  }
}

function applyOperators(
  doc: Record<string, unknown>,
  update: Record<string, unknown>,
  options: Settings,
): Record<string, unknown> {
  const root = newNode()
  const identifiers = parseArrayFilters(options.arrayFilters ?? [], options.regex)
  const used = new Set<string>()
  for (const op of Object.keys(update)) {
    if (!OPERATORS.has(op)) fail(`Unknown modifier: ${op}`)
    const operand = update[op]
    if (!isDocument(operand))
      fail(`Modifiers operate on fields but we found type ${bsonTypeOf(operand)} instead`)
    for (const path of Object.keys(operand)) {
      const value = operand[path]
      if (op === "$rename") {
        addRename(root, doc, path, value)
        continue
      }
      validateOperand(op, path, value)
      addLeaf(root, path, { op, operand: value, path }, identifiers, used)
    }
  }
  for (const identifier of identifiers.keys()) {
    if (!used.has(identifier)) {
      fail(`The array filter for identifier '${identifier}' was not used in the update`)
    }
  }
  const out = cloneDocument(doc)
  applyChildren(out, root, "", options, identifiers)
  if (doc["_id"] !== undefined && !valuesEqual(out["_id"], doc["_id"])) {
    fail("Performing an update on the path '_id' would modify the immutable field '_id'")
  }
  return out
}

function parseArrayFilters(
  filters: readonly Record<string, unknown>[],
  regex: RegexEngine | undefined,
): Map<string, DocTest> {
  const out = new Map<string, DocTest>()
  for (const filter of filters) {
    if (!isDocument(filter)) fail("Each array filter must be a document")
    let identifier: string | undefined
    for (const key of Object.keys(filter)) {
      const id = splitPath(key)[0] ?? ""
      if (!/^[a-z][a-zA-Z0-9]*$/.test(id)) {
        fail(
          `The top level field name must be an alphanumeric string beginning with a lowercase letter: ${id}`,
        )
      }
      if (identifier !== undefined && identifier !== id) {
        fail("Each array filter must use a single top level field name")
      }
      identifier = id
    }
    if (identifier === undefined) fail("Cannot use an expression without a top level field name")
    if (out.has(identifier))
      fail(`Found multiple array filters with the same top level field name ${identifier}`)
    const test = compileFilterWith(filter, regex).matches
    out.set(identifier, test)
  }
  return out
}

function validateOperand(op: string, path: string, value: unknown): void {
  switch (op) {
    case "$inc":
    case "$mul":
      if (readNumeric(value) === undefined) {
        fail(
          `Cannot ${op === "$inc" ? "increment" : "multiply"} with non-numeric argument: {${path}: ...}`,
        )
      }
      if (readNumeric(value)?.kind === "decimal") {
        throw new UnsupportedQueryError("Decimal128 arithmetic is not evaluated in process")
      }
      return
    case "$pop": {
      const numeric = readNumeric(value)
      const n = numeric === undefined ? Number.NaN : toDouble(numeric)
      if (n !== 1 && n !== -1) fail("$pop expects 1 or -1")
      return
    }
    case "$currentDate": {
      if (typeof value === "boolean") return
      if (isDocument(value)) {
        const type = value["$type"]
        if (Object.keys(value).length === 1 && (type === "date" || type === "timestamp")) return
      }
      fail(`${path} is not valid for $currentDate`)
      return
    }
    case "$pullAll":
      if (!Array.isArray(value))
        fail(`$pullAll requires an array argument but was given a ${bsonTypeOf(value)}`)
      return
    case "$bit": {
      if (!isDocument(value) || Object.keys(value).length === 0)
        fail("$bit needs a document of and, or, xor")
      for (const key of Object.keys(value)) {
        if (key !== "and" && key !== "or" && key !== "xor")
          fail(`The $bit modifier only supports and, or and xor, not ${key}`)
        const kind = readNumeric(value[key])?.kind
        if (kind !== "int" && kind !== "long")
          fail("The $bit modifier field must be an integer value")
      }
      return
    }
    case "$set":
    case "$setOnInsert":
    case "$min":
    case "$max":
      validateStorage(value, path)
      return
    case "$push":
    case "$addToSet":
      if (isDocument(value) && Object.hasOwn(value, "$each")) {
        validateEach(op, value)
      } else {
        validateStorage(value, path)
      }
      return
    default:
      return
  }
}

function validateEach(op: string, value: Record<string, unknown>): void {
  const each = value["$each"]
  if (!Array.isArray(each)) fail(`The argument to $each in ${op} must be an array`)
  for (const key of Object.keys(value)) {
    if (key === "$each") continue
    if (op === "$addToSet") fail(`Found unexpected fields after $each in $addToSet: ${key}`)
    if (key !== "$position" && key !== "$slice" && key !== "$sort")
      fail(`Unrecognized clause in $push: ${key}`)
  }
  for (const item of each) validateStorage(item, "")
  if (value["$position"] !== undefined) {
    const kind = readNumeric(value["$position"])
    if (kind === undefined || !Number.isInteger(toDouble(kind)))
      fail("The value for $position must be an integer")
  }
  if (value["$slice"] !== undefined) {
    const kind = readNumeric(value["$slice"])
    if (kind === undefined || !Number.isInteger(toDouble(kind)))
      fail("The value for $slice must be an integer")
  }
  if (value["$sort"] !== undefined) {
    const sort = value["$sort"]
    const numeric = readNumeric(sort)
    if (numeric !== undefined) {
      const n = toDouble(numeric)
      if (n !== 1 && n !== -1) fail("The $sort element value must be either 1 or -1")
    } else if (!isDocument(sort) || Object.keys(sort).length === 0) {
      fail(
        "The $sort is invalid: use 1/-1 to sort the whole element, or {field:1/-1} to sort embedded fields",
      )
    } else {
      compileSort(sort)
    }
  }
}

function pathParts(path: string): string[] {
  if (path === "") fail("An empty update path is not valid")
  const parts = splitPath(path)
  for (const part of parts) {
    if (part === "")
      fail(`The update path '${path}' contains an empty field name, which is not allowed`)
  }
  return parts
}

function addLeaf(
  root: Node,
  path: string,
  leaf: Leaf,
  identifiers: Map<string, DocTest>,
  used: Set<string>,
): void {
  const parts = pathParts(path)
  let node = root
  const creates = CREATING.has(leaf.op)
  const strict = !creates && leaf.op !== "$unset" && leaf.op !== "$rename-missing"
  parts.forEach((part, index) => {
    if (part.startsWith("$")) {
      if (part === "$")
        throw new UnsupportedQueryError("The positional $ operator is not evaluated in process")
      const match = /^\$\[([a-z][a-zA-Z0-9]*)?\]$/.exec(part)
      if (match === null)
        fail(`The dollar ($) prefixed field '${part}' in '${path}' is not allowed`)
      const identifier = match[1]
      if (identifier !== undefined) {
        if (!identifiers.has(identifier))
          fail(`No array filter found for identifier '${identifier}' in path '${path}'`)
        used.add(identifier)
      }
    }
    if (node.leaf !== undefined)
      fail(`Updating the path '${path}' would create a conflict at '${node.leaf.path}'`)
    if (creates) node.creates = true
    if (strict) node.strict = true
    const positional = part.startsWith("$[")
    for (const sibling of node.children.keys()) {
      if (
        sibling !== part &&
        (positional || sibling.startsWith("$[")) &&
        !(positional && sibling.startsWith("$["))
      ) {
        fail(
          `Updating the path '${path}' would create a conflict at '${parts.slice(0, index).join(".")}'`,
        )
      }
    }
    let child = node.children.get(part)
    if (child === undefined) {
      child = newNode()
      node.children.set(part, child)
    }
    node = child
    if (index === parts.length - 1) {
      if (node.leaf !== undefined || node.children.size > 0) {
        fail(`Updating the path '${path}' would create a conflict at '${path}'`)
      }
      node.leaf = leaf
      if (creates) node.creates = true
      if (strict) node.strict = true
    }
  })
}

/**
 * The text `String(value)` gives, without failing on a value whose conversion throws (an object without a
 * prototype, as a parsed request body can hold), which reads `[object Object]` like any other object.
 */
function jsString(value: unknown): string {
  if (Array.isArray(value))
    return value
      .map((item) => (item === null || item === undefined ? "" : jsString(item)))
      .join(",")
  try {
    return String(value)
  } catch {
    return "[object Object]"
  }
}

function addRename(root: Node, doc: Record<string, unknown>, from: string, to: unknown): void {
  if (typeof to !== "string")
    fail(`The 'to' field for $rename must be a string: ${from}: ${jsString(to)}`)
  if (from === to) fail(`The source and target field for $rename must differ: ${from}: "${to}"`)
  if (to.startsWith(`${from}.`) || from.startsWith(`${to}.`)) {
    fail(`The source and target field for $rename must not be on the same path: ${from}: "${to}"`)
  }
  const fromParts = pathParts(from)
  const toParts = pathParts(to)
  if ([...fromParts, ...toParts].some((part) => part.startsWith("$"))) {
    fail("The source and target field for $rename must not contain positional operators")
  }
  const source = readForRename(doc, fromParts, "source")
  if (source.found) readForRename(doc, toParts, "destination")
  const empty = new Map<string, DocTest>()
  const used = new Set<string>()
  addLeaf(root, from, { op: "$unset", operand: "", path: from }, empty, used)
  if (source.found) {
    addLeaf(root, to, { op: "$rename-to", operand: source.value, path: to }, empty, used)
  } else {
    addLeaf(root, to, { op: "$rename-missing", operand: undefined, path: to }, empty, used)
  }
}

function readForRename(
  doc: Record<string, unknown>,
  parts: readonly string[],
  role: "source" | "destination",
): { found: boolean; value: unknown } {
  let value: unknown = doc
  for (const [index, part] of parts.entries()) {
    if (Array.isArray(value)) {
      fail(
        `The ${role} field cannot be an array element, '${parts.slice(0, index).join(".")}' is an array`,
      )
    }
    if (value === undefined) return { found: false, value: undefined }
    if (!isDocument(value)) {
      if (role === "destination") return { found: false, value: undefined }
      fail(
        `cannot use the part (${parts[index - 1] ?? part} of ${parts.join(".")}) to traverse the element`,
      )
    }
    if (!Object.hasOwn(value, part)) return { found: false, value: undefined }
    value = value[part]
  }
  return { found: true, value }
}

function cloneDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(doc)) out[key] = doc[key]
  return out
}

function compareFieldNames(a: string, b: string): number {
  const na = isArrayIndex(a)
  const nb = isArrayIndex(b)
  if (na && nb) return Number(a) - Number(b)
  return a < b ? -1 : a > b ? 1 : 0
}

function orderedChildren(node: Node): [string, Node][] {
  return [...node.children.entries()].sort(([a], [b]) => compareFieldNames(a, b))
}

function parentOf(path: string): string {
  const parts = path.split(".")
  return parts.slice(0, -1).join(".") || path
}

function describe(value: unknown): string {
  return bsonTypeOf(value)
}

function applyChildren(
  container: Record<string, unknown> | unknown[],
  node: Node,
  prefix: string,
  options: Settings,
  identifiers: Map<string, DocTest>,
): void {
  const touched = new Set<number>()
  for (const [key, child] of orderedChildren(node)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    if (key.startsWith("$[")) {
      if (!Array.isArray(container))
        fail(`Cannot apply array updates to non-array element ${prefix}`)
      const identifier = /^\$\[([a-zA-Z0-9]*)\]$/.exec(key)?.[1] ?? ""
      const test = identifier === "" ? undefined : identifiers.get(identifier)
      const targets: number[] = []
      container.forEach((element, index) => {
        if (test === undefined || test({ [identifier]: element })) targets.push(index)
      })
      for (const index of targets) {
        if (touched.has(index)) fail(`Update created a conflict at '${prefix}.${index}'`)
        touched.add(index)
        applyAt(container, String(index), child, `${prefix}.${index}`, options, identifiers)
      }
      continue
    }
    applyAt(container, key, child, path, options, identifiers)
  }
}

function readSlot(
  container: Record<string, unknown> | unknown[],
  key: string,
): { exists: boolean; value: unknown } {
  if (Array.isArray(container)) {
    if (!isArrayIndex(key)) return { exists: false, value: undefined }
    const index = Number(key)
    return index < container.length
      ? { exists: true, value: container[index] }
      : { exists: false, value: undefined }
  }
  return Object.hasOwn(container, key)
    ? { exists: true, value: container[key] }
    : { exists: false, value: undefined }
}

function writeSlot(
  container: Record<string, unknown> | unknown[],
  key: string,
  value: unknown,
  path: string,
): void {
  if (Array.isArray(container)) {
    if (!isArrayIndex(key)) {
      fail(
        `Cannot create field '${key}' in element {${path.split(".").slice(0, -1).join(".")}: [...]}`,
      )
    }
    const index = Number(key)
    if (index > container.length + MAX_PADDING) {
      fail(`can't backfill more than ${MAX_PADDING} elements`)
    }
    while (container.length < index) container.push(null)
    container[index] = value
    return
  }
  container[key] = value
}

function applyAt(
  container: Record<string, unknown> | unknown[],
  key: string,
  node: Node,
  path: string,
  options: Settings,
  identifiers: Map<string, DocTest>,
): void {
  if (Array.isArray(container) && !isArrayIndex(key)) {
    if (node.creates) fail(`Cannot create field '${key}' in element {${parentOf(path)}: [...]}`)
    if (node.strict)
      fail(
        `Cannot use the part (${key}) of (${path}) to traverse the element ({${parentOf(path)}: [...]})`,
      )
    return
  }
  const slot = readSlot(container, key)
  if (node.leaf !== undefined) {
    applyLeaf(container, key, slot, node.leaf, path, options)
    return
  }
  const hasPositional = [...node.children.keys()].some((child) => child.startsWith("$["))
  if (!slot.exists || slot.value === undefined) {
    if (hasPositional)
      fail(`The path '${path}' must exist in the document in order to apply array updates.`)
    if (!node.creates) return
    if (Array.isArray(container) && !isArrayIndex(key)) {
      fail(
        `Cannot create field '${key}' in element {${path.split(".").slice(0, -1).join(".") || key}: [...]}`,
      )
    }
    const created: Record<string, unknown> = {}
    writeSlot(container, key, created, path)
    applyChildren(created, node, path, options, identifiers)
    return
  }
  const current = slot.value
  if (isDocument(current)) {
    const copy = cloneDocument(current)
    writeSlot(container, key, copy, path)
    applyChildren(copy, node, path, options, identifiers)
    return
  }
  if (Array.isArray(current)) {
    const copy = [...current]
    writeSlot(container, key, copy, path)
    applyChildren(copy, node, path, options, identifiers)
    return
  }
  const firstChild = [...node.children.keys()][0] ?? ""
  if (hasPositional)
    fail(`Cannot apply array updates to non-array element ${path}: ${describe(current)}`)
  if (node.creates)
    fail(`Cannot create field '${firstChild}' in element {${key}: ${describe(current)}}`)
  if (node.strict)
    fail(
      `Cannot use the part (${firstChild}) of (${path}.${firstChild}) to traverse the element ({${key}: ${describe(current)}})`,
    )
}

function applyLeaf(
  container: Record<string, unknown> | unknown[],
  key: string,
  slot: { exists: boolean; value: unknown },
  leaf: Leaf,
  path: string,
  options: Settings,
): void {
  const { op, operand } = leaf
  const set = (value: unknown): void => writeSlot(container, key, value, path)
  const present = slot.exists && slot.value !== undefined
  switch (op) {
    case "$set":
      set(operand)
      return
    case "$setOnInsert":
      if (options.isInsert === true) set(operand)
      return
    case "$rename-to":
      set(operand)
      return
    case "$rename-missing":
      return
    case "$unset":
      if (!slot.exists) return
      if (Array.isArray(container)) container[Number(key)] = null
      else delete container[key]
      return
    case "$inc":
    case "$mul": {
      if (!present) {
        set(op === "$inc" ? operand : zeroLike(operand))
        return
      }
      if (readNumeric(slot.value) === undefined) {
        fail(`Cannot apply ${op} to a value of non-numeric type. {${key}: ${describe(slot.value)}}`)
      }
      set(arithmetic(op, slot.value, operand))
      return
    }
    case "$min":
    case "$max": {
      if (!present) {
        set(operand)
        return
      }
      const cmp = compareValues(operand, slot.value)
      if ((op === "$min" && cmp < 0) || (op === "$max" && cmp > 0)) set(operand)
      return
    }
    case "$currentDate": {
      const now = options.now ?? new Date()
      const wantsTimestamp = isDocument(operand) && operand["$type"] === "timestamp"
      set(
        wantsTimestamp
          ? new Timestamp(Math.floor(now.getTime() / 1000), 1)
          : new Date(now.getTime()),
      )
      return
    }
    case "$push":
    case "$addToSet": {
      if (present && !Array.isArray(slot.value)) {
        fail(
          `The field '${key}' must be an array but is of type ${describe(slot.value)} in document`,
        )
      }
      const current = present ? [...(slot.value as unknown[])] : []
      set(op === "$push" ? push(current, operand) : addToSet(current, operand))
      return
    }
    case "$pop": {
      if (!present) return
      if (!Array.isArray(slot.value))
        fail(`Path '${path}' contains an element of non-array type '${describe(slot.value)}'`)
      if (slot.value.length === 0) return
      const n = toDouble(readNumeric(operand) ?? { kind: "int", value: 1 })
      set(n === 1 ? slot.value.slice(0, -1) : slot.value.slice(1))
      return
    }
    case "$pull":
    case "$pullAll": {
      if (!present) return
      if (!Array.isArray(slot.value)) fail("Cannot apply $pull to a non-array value")
      const remove =
        op === "$pullAll" ? pullAllTest(operand as unknown[]) : pullTest(operand, options.regex)
      set(slot.value.filter((element) => !remove(element)))
      return
    }
    case "$bit": {
      const current = present ? slot.value : 0
      const kind = readNumeric(current)?.kind
      if (kind !== "int" && kind !== "long") {
        fail(`Cannot apply $bit to a value of non-integral type. {${key}: ${describe(current)}}`)
      }
      set(bitwise(current, operand as Record<string, unknown>))
      return
    }
    default:
      fail(`Unknown modifier: ${op}`)
  }
}

function zeroLike(operand: unknown): unknown {
  const numeric = readNumeric(operand)
  if (numeric?.kind === "long") return longLike(operand, 0n)
  if (numeric?.kind === "double") return numeric.value * 0
  return 0
}

function longLike(template: unknown, value: bigint): unknown {
  if (typeof template === "bigint") return value
  return new Long(value)
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value
  const long = longValue(value)
  if (long !== undefined) return long
  return BigInt(toDouble(readNumeric(value) ?? { kind: "int", value: 0 }))
}

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

function arithmetic(op: string, current: unknown, operand: unknown): unknown {
  const a = readNumeric(current)
  const b = readNumeric(operand)
  if (a === undefined || b === undefined) fail(`Cannot apply ${op}`)
  if (a.kind === "decimal" || b.kind === "decimal") {
    throw new UnsupportedQueryError("Decimal128 arithmetic is not evaluated in process")
  }
  if (a.kind === "double" || b.kind === "double") {
    const x = toDouble(a)
    const y = toDouble(b)
    return op === "$inc" ? x + y : x * y
  }
  if (a.kind === "int" && b.kind === "int") {
    const exact =
      op === "$inc" ? BigInt(a.value) + BigInt(b.value) : BigInt(a.value) * BigInt(b.value)
    const asNumber = Number(exact)
    return Number.isSafeInteger(asNumber) ? asNumber : longLike(current, exact)
  }
  const x = asBigInt(current)
  const y = asBigInt(operand)
  const result = op === "$inc" ? x + y : x * y
  if (result < INT64_MIN || result > INT64_MAX) {
    fail(`Failed to apply ${op} operations to current value: integer overflow`)
  }
  return longLike(a.kind === "long" ? current : operand, result)
}

function bitwise(current: unknown, spec: Record<string, unknown>): unknown {
  let value = asBigInt(current)
  let isLong = readNumeric(current)?.kind === "long"
  for (const key of Object.keys(spec)) {
    const operand = spec[key]
    if (readNumeric(operand)?.kind === "long") isLong = true
    const other = asBigInt(operand)
    value = key === "and" ? value & other : key === "or" ? value | other : value ^ other
  }
  if (!isLong) {
    const asInt = Number(BigInt.asIntN(32, value))
    return asInt
  }
  return new Long(BigInt.asIntN(64, value))
}

function push(current: unknown[], operand: unknown): unknown[] {
  if (!isDocument(operand) || !Object.hasOwn(operand, "$each")) return [...current, operand]
  const each = operand["$each"] as unknown[]
  let out = [...current]
  const positionRaw = operand["$position"]
  if (positionRaw === undefined) {
    out.push(...each)
  } else {
    let position = toDouble(readNumeric(positionRaw) ?? { kind: "int", value: 0 })
    if (position < 0) position = Math.max(0, out.length + position)
    position = Math.min(position, out.length)
    out.splice(position, 0, ...each)
  }
  const sort = operand["$sort"]
  if (sort !== undefined) {
    const numeric = readNumeric(sort)
    if (numeric !== undefined) {
      const direction = toDouble(numeric)
      out = stableSort(out, (a, b) => direction * compareValues(a, b))
    } else {
      const compare = compileElementSort(sort as Record<string, unknown>)
      out = stableSort(out, compare)
    }
  }
  const sliceRaw = operand["$slice"]
  if (sliceRaw !== undefined) {
    const slice = toDouble(readNumeric(sliceRaw) ?? { kind: "int", value: 0 })
    out = slice >= 0 ? out.slice(0, slice) : out.slice(Math.max(0, out.length + slice))
  }
  return out
}

function compileElementSort(spec: Record<string, unknown>): (a: unknown, b: unknown) => number {
  const keys = Object.keys(spec).map((path) => ({
    parts: splitPath(path),
    direction: toDouble(readNumeric(spec[path]) ?? { kind: "int", value: 1 }),
  }))
  const read = (value: unknown, parts: readonly string[]): unknown => {
    let current = value
    for (const part of parts) {
      if (!isDocument(current)) return null
      current = current[part]
    }
    return current === undefined ? null : current
  }
  return (a, b) => {
    for (const key of keys) {
      const cmp = compareValues(read(a, key.parts), read(b, key.parts))
      if (cmp !== 0) return key.direction * cmp
    }
    return 0
  }
}

function stableSort(values: unknown[], compare: (a: unknown, b: unknown) => number): unknown[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort((x, y) => compare(x.value, y.value) || x.index - y.index)
    .map((entry) => entry.value)
}

function addToSet(current: unknown[], operand: unknown): unknown[] {
  const items =
    isDocument(operand) && Object.hasOwn(operand, "$each")
      ? (operand["$each"] as unknown[])
      : [operand]
  const out = [...current]
  for (const item of items) {
    if (!out.some((existing) => valuesEqual(existing, item))) out.push(item)
  }
  return out
}

function pullAllTest(values: readonly unknown[]): (element: unknown) => boolean {
  return (element) => values.some((value) => valuesEqual(element, value))
}

function isExpressionKey(key: string): boolean {
  return key.startsWith("$") && !["$and", "$or", "$nor"].includes(key)
}

function pullTest(
  condition: unknown,
  regex: RegexEngine | undefined,
): (element: unknown) => boolean {
  if (isDocument(condition)) {
    const first = Object.keys(condition)[0]
    const isExpression = first !== undefined && isExpressionKey(first)
    if (isExpression) {
      const test = compileFilterWith({ v: condition }, regex).matches
      return (element) => test({ v: element })
    }
    const test = compileFilterWith(condition, regex).matches
    return (element) => isDocument(element) && test(element)
  }
  if (regexParts(condition) !== undefined) {
    const test = compileFilterWith({ v: condition }, regex).matches
    return (element) => !Array.isArray(element) && test({ v: element })
  }
  return (element) => valuesEqual(element, condition)
}
