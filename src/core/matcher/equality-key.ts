import { bsonTypeTag, longValue, objectIdHex, wrappedNumber } from "../protocol/index.ts"

/**
 * Returns a string key such that two values with keys get equal keys exactly when MongoDB considers them
 * equal. Returns `undefined` for values without a cheap key (documents, arrays, decimals, binary data and
 * others); callers compare those with {@link valuesEqual}. Used for `$in` sets and the realtime predicate index.
 */
export function equalityKey(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return `s:${value}`
    case "number":
      return `n:${String(value)}`
    case "bigint":
      return bigintKey(value)
    case "boolean":
      return value ? "b:1" : "b:0"
    case "object":
      break
    default:
      return undefined
  }
  if (value === null) return "z"
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? undefined : `d:${ms}`
  }
  switch (bsonTypeTag(value)) {
    case "ObjectId":
      return `o:${objectIdHex(value)}`
    case "Int32":
    case "Double": {
      const n = wrappedNumber(value)
      return n === undefined ? undefined : `n:${String(n)}`
    }
    case "Long": {
      const n = longValue(value)
      return n === undefined ? undefined : bigintKey(n)
    }
    case "BSONSymbol": {
      const inner: unknown = (value as { value?: unknown }).value
      return typeof inner === "string" ? `s:${inner}` : undefined
    }
    default:
      return undefined
  }
}

function bigintKey(value: bigint): string {
  const asNumber = Number(value)
  if (BigInt(asNumber) === value) return `n:${String(asNumber)}`
  return `n:${value.toString()}`
}
