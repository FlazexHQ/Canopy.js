import { binaryParts, bsonTypeTag, objectIdHex, regexParts, timestampParts } from "../protocol/index.ts"
import { compareNumeric, readNumeric } from "./numeric.ts"

/** BSON types, named as the `$type` aliases MongoDB accepts. */
export type BsonType =
  | "minKey"
  | "missing"
  | "undefined"
  | "null"
  | "double"
  | "int"
  | "long"
  | "decimal"
  | "string"
  | "symbol"
  | "object"
  | "array"
  | "binData"
  | "objectId"
  | "bool"
  | "date"
  | "timestamp"
  | "regex"
  | "javascript"
  | "maxKey"

/**
 * Canonical type brackets in MongoDB's comparison order (`canonicalizeBSONType`). Values in different
 * brackets never compare equal, and comparison query operators only match within one bracket.
 */
export const Bracket = {
  MinKey: -1,
  Missing: 0,
  Null: 5,
  Number: 10,
  String: 15,
  Object: 20,
  Array: 25,
  BinData: 30,
  ObjectId: 35,
  Bool: 40,
  Date: 45,
  Timestamp: 47,
  Regex: 50,
  Code: 60,
  MaxKey: 127,
} as const

/** Returns the BSON type of a value. `undefined` (an absent field) is reported as `missing`. */
export function bsonTypeOf(value: unknown): BsonType {
  if (value === undefined) return "missing"
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
      return "string"
    case "boolean":
      return "bool"
    case "number":
    case "bigint": {
      const numeric = readNumeric(value)
      return numeric?.kind ?? "double"
    }
    case "object":
      break
    default:
      return "javascript"
  }
  if (Array.isArray(value)) return "array"
  if (value instanceof Date) return "date"
  if (value instanceof RegExp) return "regex"
  if (value instanceof Uint8Array) return "binData"
  const tag = bsonTypeTag(value)
  switch (tag) {
    case undefined:
      return "object"
    case "ObjectId":
      return "objectId"
    case "Long":
      return "long"
    case "Int32":
      return "int"
    case "Double":
      return "double"
    case "Decimal128":
      return "decimal"
    case "Binary":
      return "binData"
    case "Timestamp":
      return "timestamp"
    case "BSONRegExp":
      return "regex"
    case "MinKey":
      return "minKey"
    case "MaxKey":
      return "maxKey"
    case "BSONSymbol":
      return "symbol"
    case "Code":
      return "javascript"
    case "DBRef":
      return "object"
    default:
      return "object"
  }
}

/** Returns the canonical comparison bracket of a value. */
export function bracketOf(value: unknown): number {
  switch (bsonTypeOf(value)) {
    case "minKey":
      return Bracket.MinKey
    case "missing":
    case "undefined":
      return Bracket.Missing
    case "null":
      return Bracket.Null
    case "double":
    case "int":
    case "long":
    case "decimal":
      return Bracket.Number
    case "string":
    case "symbol":
      return Bracket.String
    case "object":
      return Bracket.Object
    case "array":
      return Bracket.Array
    case "binData":
      return Bracket.BinData
    case "objectId":
      return Bracket.ObjectId
    case "bool":
      return Bracket.Bool
    case "date":
      return Bracket.Date
    case "timestamp":
      return Bracket.Timestamp
    case "regex":
      return Bracket.Regex
    case "javascript":
      return Bracket.Code
    case "maxKey":
      return Bracket.MaxKey
  }
}

/** Compares strings by Unicode code point, which equals the UTF-8 byte order MongoDB uses. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.charCodeAt(index)
    const y = b.charCodeAt(index)
    if (x === y) continue
    const xs = x >= 0xd800 && x <= 0xdfff
    const ys = y >= 0xd800 && y <= 0xdfff
    if (xs === ys) return x < y ? -1 : 1
    return xs ? 1 : -1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return a.length - b.length
}

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value
  return String((value as { value?: unknown }).value ?? value)
}

function binaryOf(value: unknown): { bytes: Uint8Array; subType: number } {
  if (value instanceof Uint8Array) return { bytes: value, subType: 0 }
  return binaryParts(value) ?? { bytes: new Uint8Array(0), subType: 0 }
}

function compareEntries(a: readonly [string, unknown][], b: readonly [string, unknown][]): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const [ka, va] = a[index] ?? ["", undefined]
    const [kb, vb] = b[index] ?? ["", undefined]
    const byType = bracketOf(va) - bracketOf(vb)
    if (byType !== 0) return sign(byType)
    const byName = compareStrings(ka, kb)
    if (byName !== 0) return byName
    const byValue = compareValues(va, vb)
    if (byValue !== 0) return byValue
  }
  return sign(a.length - b.length)
}

function documentEntries(value: Record<string, unknown>): [string, unknown][] {
  const entries: [string, unknown][] = []
  for (const key of Object.keys(value)) {
    const item = value[key]
    if (item !== undefined) entries.push([key, item])
  }
  return entries
}

/**
 * Compares two BSON values in MongoDB's total order (simple collation): first by type bracket, then by value.
 * Returns a negative number, zero or a positive number.
 */
export function compareValues(a: unknown, b: unknown): number {
  const ba = bracketOf(a)
  const bb = bracketOf(b)
  if (ba !== bb) return sign(ba - bb)
  switch (ba) {
    case Bracket.MinKey:
    case Bracket.Missing:
    case Bracket.Null:
    case Bracket.MaxKey:
      return 0
    case Bracket.Number: {
      const x = readNumeric(a)
      const y = readNumeric(b)
      if (x === undefined || y === undefined) return 0
      return compareNumeric(x, y)
    }
    case Bracket.String:
    case Bracket.Code:
      return compareStrings(stringValue(a), stringValue(b))
    case Bracket.Object:
      return compareEntries(
        documentEntries(a as Record<string, unknown>),
        documentEntries(b as Record<string, unknown>),
      )
    case Bracket.Array: {
      const x = a as readonly unknown[]
      const y = b as readonly unknown[]
      const length = Math.min(x.length, y.length)
      for (let index = 0; index < length; index += 1) {
        const ex = x[index] === undefined ? null : x[index]
        const ey = y[index] === undefined ? null : y[index]
        const byType = bracketOf(ex) - bracketOf(ey)
        if (byType !== 0) return sign(byType)
        const byValue = compareValues(ex, ey)
        if (byValue !== 0) return byValue
      }
      return sign(x.length - y.length)
    }
    case Bracket.BinData: {
      const x = binaryOf(a)
      const y = binaryOf(b)
      if (x.bytes.length !== y.bytes.length) return sign(x.bytes.length - y.bytes.length)
      if (x.subType !== y.subType) return sign(x.subType - y.subType)
      return sign(compareBytes(x.bytes, y.bytes))
    }
    case Bracket.ObjectId: {
      const x = objectIdHex(a) ?? ""
      const y = objectIdHex(b) ?? ""
      return x < y ? -1 : x > y ? 1 : 0
    }
    case Bracket.Bool:
      return a === b ? 0 : a === false ? -1 : 1
    case Bracket.Date:
      return sign((a as Date).getTime() - (b as Date).getTime())
    case Bracket.Timestamp: {
      const x = timestampParts(a) ?? { t: 0, i: 0 }
      const y = timestampParts(b) ?? { t: 0, i: 0 }
      return x.t !== y.t ? sign(x.t - y.t) : sign(x.i - y.i)
    }
    case Bracket.Regex: {
      const x = regexParts(a) ?? { pattern: "", options: "" }
      const y = regexParts(b) ?? { pattern: "", options: "" }
      const byPattern = compareStrings(x.pattern, y.pattern)
      return byPattern !== 0 ? byPattern : compareStrings(x.options, y.options)
    }
    default:
      return 0
  }
}

/** Returns true when two values are equal under BSON comparison (same bracket, equal value). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return compareValues(a, b) === 0
}
