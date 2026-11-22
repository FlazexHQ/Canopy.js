import { bsonTypeTag } from "./bson.ts"

/**
 * Uniform accessors for BSON values that come either from this package or from the `bson` package used by the
 * MongoDB driver. Each accessor returns `undefined` when the value is not of the requested kind.
 */

interface WithHex {
  toHexString(): string
}
interface WithBigInt {
  toBigInt(): bigint
}
interface BinaryLike {
  sub_type: number
  position: number
  buffer: Uint8Array
}
interface TimestampLike {
  t?: number
  i?: number
  high?: number
  low?: number
}
interface RegExpLike {
  pattern: string
  options: string
}

/** Returns the lower case hex of an ObjectId. */
export function objectIdHex(value: unknown): string | undefined {
  if (bsonTypeTag(value) !== "ObjectId") return undefined
  return (value as WithHex).toHexString().toLowerCase()
}

/** Returns the value of a 64 bit integer wrapper (`Long`) as a bigint. */
export function longValue(value: unknown): bigint | undefined {
  if (bsonTypeTag(value) !== "Long") return undefined
  return (value as WithBigInt).toBigInt()
}

/** Returns the numeric value of an `Int32` or `Double` wrapper from the `bson` package. */
export function wrappedNumber(value: unknown): number | undefined {
  const tag = bsonTypeTag(value)
  if (tag !== "Int32" && tag !== "Double") return undefined
  const inner: unknown = (value as { value?: unknown }).value
  return typeof inner === "number" ? inner : undefined
}

/** Returns the string form of a Decimal128 value. */
export function decimalString(value: unknown): string | undefined {
  if (bsonTypeTag(value) !== "Decimal128") return undefined
  return String(value)
}

/** Returns the bytes and subtype of a Binary value. */
export function binaryParts(value: unknown): { bytes: Uint8Array; subType: number } | undefined {
  if (bsonTypeTag(value) !== "Binary") return undefined
  const binary = value as BinaryLike
  return { bytes: binary.buffer.subarray(0, binary.position), subType: binary.sub_type }
}

/** Returns the seconds and increment of a Timestamp value. */
export function timestampParts(value: unknown): { t: number; i: number } | undefined {
  if (bsonTypeTag(value) !== "Timestamp") return undefined
  const ts = value as TimestampLike
  const t = ts.t ?? (ts.high === undefined ? undefined : ts.high >>> 0)
  const i = ts.i ?? (ts.low === undefined ? undefined : ts.low >>> 0)
  if (t === undefined || i === undefined) return undefined
  return { t, i }
}

/** Returns the pattern and sorted option letters of a regular expression (BSON or JavaScript). */
export function regexParts(value: unknown): { pattern: string; options: string } | undefined {
  if (value instanceof RegExp) {
    return { pattern: value.source, options: jsFlagsToOptions(value.flags) }
  }
  if (bsonTypeTag(value) !== "BSONRegExp") return undefined
  const regex = value as RegExpLike
  return { pattern: regex.pattern, options: [...regex.options].sort().join("") }
}

function jsFlagsToOptions(flags: string): string {
  let options = ""
  for (const flag of flags) {
    if (flag === "i" || flag === "m" || flag === "s") options += flag
  }
  return [...options].sort().join("")
}

/** Returns true for objects that are plain documents (not arrays, dates or BSON wrappers). */
export function isDocument(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  if (Array.isArray(value) || value instanceof Date || value instanceof RegExp) return false
  if (value instanceof Uint8Array) return false
  return bsonTypeTag(value) === undefined
}
