import {
  Binary,
  BSONRegExp,
  bsonTypeTag,
  Decimal128,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "./bson.ts"
import { InvalidQueryError } from "./errors.ts"
import {
  binaryParts,
  decimalString,
  isDocument,
  longValue,
  objectIdHex,
  regexParts,
  timestampParts,
  wrappedNumber,
} from "./values.ts"

/** Limits applied while decoding untrusted EJSON. */
export interface DecodeOptions {
  /** Maximum nesting of arrays and documents. Defaults to 64. */
  readonly maxDepth?: number
  /** Maximum number of keys and array elements in total. Defaults to 100,000. */
  readonly maxNodes?: number
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"])
const WRAPPER_KEYS: ReadonlySet<string> = new Set([
  "$oid",
  "$numberLong",
  "$numberInt",
  "$numberDouble",
  "$numberDecimal",
  "$date",
  "$binary",
  "$uuid",
  "$timestamp",
  "$regularExpression",
  "$minKey",
  "$maxKey",
  "$symbol",
  "$code",
  "$scope",
  "$dbPointer",
  "$undefined",
])
const INT32 = /^-?\d{1,10}$/
const INT64 = /^-?\d{1,19}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TWO_POW_53 = 2 ** 53

/** Returns true when `key` may never appear in a decoded document. */
export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key)
}

/** Parses EJSON text (relaxed or canonical) into values. Objects are created with a null prototype. */
export function parse(text: string, options?: DecodeOptions): unknown {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error: unknown) {
    throw new InvalidQueryError("Malformed JSON", { cause: error })
  }
  return decode(raw, options)
}

/** Decodes a JSON value holding EJSON wrappers into values. */
export function decode(value: unknown, options: DecodeOptions = {}): unknown {
  const state = { nodes: 0, maxNodes: options.maxNodes ?? 100_000 }
  return decodeValue(value, 0, options.maxDepth ?? 64, state)
}

interface DecodeState {
  nodes: number
  readonly maxNodes: number
}

function decodeValue(value: unknown, depth: number, maxDepth: number, state: DecodeState): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return value
  if (typeof value !== "object")
    throw new InvalidQueryError(`Unsupported JSON value: ${typeof value}`)
  if (depth >= maxDepth) throw new InvalidQueryError(`Nesting deeper than ${maxDepth} levels`)
  if (Array.isArray(value)) {
    state.nodes += value.length
    if (state.nodes > state.maxNodes) throw new InvalidQueryError("Too many values")
    return value.map((item) => decodeValue(item, depth + 1, maxDepth, state))
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  state.nodes += keys.length
  if (state.nodes > state.maxNodes) throw new InvalidQueryError("Too many values")
  if (keys.some((key) => WRAPPER_KEYS.has(key))) return decodeWrapper(record, keys)
  const out = Object.fromEntries(
    keys.map((key) => {
      if (FORBIDDEN_KEYS.has(key)) throw new InvalidQueryError(`The key "${key}" is not allowed`)
      return [key, decodeValue(record[key], depth + 1, maxDepth, state)]
    }),
  )
  return Object.setPrototypeOf(out, null)
}

function decodeWrapper(record: Record<string, unknown>, keys: readonly string[]): unknown {
  const fail = (what: string): never => {
    throw new InvalidQueryError(`Invalid EJSON ${what}`)
  }
  if (keys.length !== 1) fail(`wrapper with keys ${keys.join(", ")}`)
  const key = keys[0] ?? ""
  const inner = record[key]
  switch (key) {
    case "$oid":
      if (typeof inner !== "string" || !ObjectId.isValid(inner)) fail("$oid")
      return new ObjectId(inner as string)
    case "$numberInt": {
      if (typeof inner !== "string" || !INT32.test(inner)) fail("$numberInt")
      const n = Number(inner)
      if (n < -2147483648 || n > 2147483647) fail("$numberInt")
      return n
    }
    case "$numberLong": {
      if (typeof inner !== "string" || !INT64.test(inner)) fail("$numberLong")
      try {
        return new Long(BigInt(inner as string))
      } catch {
        return fail("$numberLong")
      }
    }
    case "$numberDouble": {
      if (typeof inner !== "string") return fail("$numberDouble")
      if (inner === "Infinity") return Number.POSITIVE_INFINITY
      if (inner === "-Infinity") return Number.NEGATIVE_INFINITY
      if (inner === "NaN") return Number.NaN
      const n = Number(inner)
      if (inner.trim() === "" || !Number.isFinite(n)) fail("$numberDouble")
      return n
    }
    case "$numberDecimal":
      if (typeof inner !== "string") return fail("$numberDecimal")
      try {
        return new Decimal128(inner)
      } catch {
        return fail("$numberDecimal")
      }
    case "$date":
      return decodeDate(inner, fail)
    case "$binary": {
      if (!isPlainRecord(inner)) return fail("$binary")
      const base64 = inner["base64"]
      const subType = inner["subType"]
      if (
        typeof base64 !== "string" ||
        typeof subType !== "string" ||
        !/^[0-9a-f]{1,2}$/i.test(subType)
      ) {
        return fail("$binary")
      }
      return new Binary(base64ToBytes(base64, fail), Number.parseInt(subType, 16))
    }
    case "$uuid":
      if (typeof inner !== "string" || !UUID.test(inner)) return fail("$uuid")
      return new Binary(hexToBytes(inner.replaceAll("-", "")), 4)
    case "$timestamp": {
      if (!isPlainRecord(inner)) return fail("$timestamp")
      const t = inner["t"]
      const i = inner["i"]
      if (typeof t !== "number" || typeof i !== "number") return fail("$timestamp")
      try {
        return new Timestamp(t, i)
      } catch {
        return fail("$timestamp")
      }
    }
    case "$regularExpression": {
      if (!isPlainRecord(inner)) return fail("$regularExpression")
      const pattern = inner["pattern"]
      const options = inner["options"]
      if (
        typeof pattern !== "string" ||
        typeof options !== "string" ||
        !/^[imsux]*$/.test(options)
      ) {
        return fail("$regularExpression")
      }
      return new BSONRegExp(pattern, options)
    }
    case "$minKey":
      if (inner !== 1) fail("$minKey")
      return new MinKey()
    case "$maxKey":
      if (inner !== 1) fail("$maxKey")
      return new MaxKey()
    default:
      return fail(`type ${key}, which is not supported`)
  }
}

function decodeDate(inner: unknown, fail: (what: string) => never): Date {
  if (typeof inner === "string") {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(inner)) fail("$date")
    const ms = Date.parse(inner)
    if (Number.isNaN(ms)) fail("$date")
    return new Date(ms)
  }
  if (isPlainRecord(inner)) {
    const keys = Object.keys(inner)
    const long = inner["$numberLong"]
    if (keys.length !== 1 || typeof long !== "string" || !INT64.test(long)) fail("$date")
    const ms = Number(long)
    if (!Number.isSafeInteger(ms) || Math.abs(ms) > 8.64e15) fail("$date")
    return new Date(ms)
  }
  return fail("$date")
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function base64ToBytes(base64: string, fail: (what: string) => never): Uint8Array {
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    return fail("base64 payload")
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** Encodes values into relaxed EJSON (the `canopy.v1` wire form). */
export function encode(value: unknown): unknown {
  return encodeValue(value, false)
}

/** Encodes values into canonical EJSON v2, which preserves every type. */
export function toCanonical(value: unknown): unknown {
  return encodeValue(value, true)
}

/** Serializes values to relaxed EJSON text. */
export function stringify(value: unknown): string {
  return JSON.stringify(encode(value))
}

/**
 * Serializes values to canonical EJSON text. Equal values give equal strings, so the result can be used as a
 * key (for example the client cache key `c + '/' + canonicalString(id)`).
 */
export function canonicalString(value: unknown): string {
  return JSON.stringify(toCanonical(value))
}

function encodeNumber(value: number, canonical: boolean): unknown {
  if (Number.isNaN(value)) return { $numberDouble: "NaN" }
  if (value === Number.POSITIVE_INFINITY) return { $numberDouble: "Infinity" }
  if (value === Number.NEGATIVE_INFINITY) return { $numberDouble: "-Infinity" }
  if (Object.is(value, -0)) return { $numberDouble: "-0.0" }
  if (!canonical) return value
  if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
    return { $numberInt: String(value) }
  }
  return {
    $numberDouble: Number.isInteger(value) && Math.abs(value) < 1e21 ? `${value}.0` : String(value),
  }
}

function encodeLong(value: bigint, canonical: boolean): unknown {
  if (!canonical && value >= -BigInt(TWO_POW_53) && value <= BigInt(TWO_POW_53))
    return Number(value)
  return { $numberLong: value.toString() }
}

function encodeDate(value: Date, canonical: boolean): unknown {
  const ms = value.getTime()
  if (Number.isNaN(ms)) throw new InvalidQueryError("Cannot encode an invalid Date")
  const year = value.getUTCFullYear()
  if (!canonical && year >= 1970 && year <= 9999) return { $date: value.toISOString() }
  return { $date: { $numberLong: String(ms) } }
}

function encodeValue(value: unknown, canonical: boolean): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      return encodeNumber(value, canonical)
    case "bigint":
      return encodeLong(value, canonical)
    case "object":
      break
    default:
      throw new InvalidQueryError(`Cannot encode a value of type ${typeof value}`)
  }
  if (Array.isArray(value)) return value.map((item) => encodeValue(item, canonical))
  if (value instanceof Date) return encodeDate(value, canonical)
  if (value instanceof Uint8Array) {
    return { $binary: { base64: bytesToBase64(value), subType: "00" } }
  }
  if (isDocument(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, encodeValue(item, canonical)]),
    )
  }
  return encodeBsonValue(value, canonical)
}

function encodeBsonValue(value: object, canonical: boolean): unknown {
  const regex = regexParts(value)
  if (regex !== undefined) return { $regularExpression: regex }
  const tag = bsonTypeTag(value)
  switch (tag) {
    case "ObjectId":
      return { $oid: objectIdHex(value) }
    case "Long":
      return encodeLong(longValue(value) ?? 0n, canonical)
    case "Int32":
    case "Double":
      return encodeNumber(wrappedNumber(value) ?? 0, canonical)
    case "Decimal128":
      return { $numberDecimal: decimalString(value) }
    case "Binary": {
      const parts = binaryParts(value)
      if (parts === undefined) break
      return {
        $binary: {
          base64: bytesToBase64(parts.bytes),
          subType: parts.subType.toString(16).padStart(2, "0"),
        },
      }
    }
    case "Timestamp": {
      const parts = timestampParts(value)
      if (parts === undefined) break
      return { $timestamp: { t: parts.t, i: parts.i } }
    }
    case "MinKey":
      return { $minKey: 1 }
    case "MaxKey":
      return { $maxKey: 1 }
    default:
      break
  }
  throw new InvalidQueryError(`Cannot encode BSON type ${tag ?? "unknown"}`)
}
