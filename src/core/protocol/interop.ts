import {
  Binary,
  BSONRegExp,
  Decimal128,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "./bson.ts"

/**
 * The constructors of a full BSON library, such as the `BSON` namespace the MongoDB driver exports. The
 * protocol package has no runtime dependencies, so servers pass the library in.
 */
export interface BsonLibrary {
  readonly ObjectId: new (hex: string) => unknown
  readonly Long: { fromBigInt(value: bigint): unknown }
  readonly Decimal128: { fromString(value: string): unknown }
  readonly Binary: new (bytes: Uint8Array, subType: number) => unknown
  readonly Timestamp: new (value: { t: number; i: number }) => unknown
  readonly BSONRegExp: new (pattern: string, options: string) => unknown
  readonly MinKey: new () => unknown
  readonly MaxKey: new () => unknown
}

/**
 * Replaces the protocol's BSON value classes with instances from `library`, at any depth, so decoded EJSON
 * can be sent through the driver. Other values, including instances that already come from the library,
 * are kept as they are. Plain objects are copied with a null prototype.
 */
export function toBsonLibrary(value: unknown, library: BsonLibrary): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => toBsonLibrary(item, library))
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype === Object.prototype || prototype === null) {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(record)) out[key] = toBsonLibrary(record[key], library)
    return out
  }
  if (value instanceof ObjectId) return new library.ObjectId(value.hex)
  if (value instanceof Long) return library.Long.fromBigInt(value.value)
  if (value instanceof Decimal128) return library.Decimal128.fromString(value.value)
  if (value instanceof Binary) return new library.Binary(value.bytes, value.subType)
  if (value instanceof Timestamp) return new library.Timestamp({ t: value.t, i: value.i })
  if (value instanceof BSONRegExp) return new library.BSONRegExp(value.pattern, value.options)
  if (value instanceof MinKey) return new library.MinKey()
  if (value instanceof MaxKey) return new library.MaxKey()
  return value
}
