/**
 * Small BSON value classes for EJSON-lite. They carry the same `_bsontype` tags as the `bson` package, so code
 * that inspects values (the matcher, the codec) treats instances from either source the same way.
 */

const HEX = /^[0-9a-f]{24}$/i

let processUnique: Uint8Array | undefined
let counter = -1

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

/** A 12 byte MongoDB ObjectId. */
export class ObjectId {
  /** The lower case hexadecimal form. */
  readonly hex: string

  /** Creates an ObjectId from a 24 character hex string, or generates a new one. */
  constructor(hex?: string) {
    if (hex === undefined) {
      this.hex = ObjectId.generateHex()
    } else {
      if (!HEX.test(hex)) throw new TypeError("An ObjectId must be 24 hexadecimal characters")
      this.hex = hex.toLowerCase()
    }
  }

  /** The `bson` compatible type tag. */
  get _bsontype(): "ObjectId" {
    return "ObjectId"
  }

  /** Returns true when `value` is a 24 character hex string. */
  static isValid(value: unknown): boolean {
    return typeof value === "string" && HEX.test(value)
  }

  /** Generates the hex form of a new ObjectId: 4 byte timestamp, 5 random bytes, 3 byte counter. */
  static generateHex(nowMs: number = Date.now()): string {
    processUnique ??= randomBytes(5)
    if (counter < 0) {
      const seed = randomBytes(3)
      counter = ((seed[0] ?? 0) << 16) | ((seed[1] ?? 0) << 8) | (seed[2] ?? 0)
    }
    counter = (counter + 1) % 0x1000000
    const seconds = Math.floor(nowMs / 1000) >>> 0
    const bytes = new Uint8Array(12)
    bytes[0] = (seconds >>> 24) & 0xff
    bytes[1] = (seconds >>> 16) & 0xff
    bytes[2] = (seconds >>> 8) & 0xff
    bytes[3] = seconds & 0xff
    bytes.set(processUnique, 4)
    bytes[9] = (counter >>> 16) & 0xff
    bytes[10] = (counter >>> 8) & 0xff
    bytes[11] = counter & 0xff
    return toHex(bytes)
  }

  /** The creation time encoded in the first four bytes. */
  getTimestamp(): Date {
    return new Date(Number.parseInt(this.hex.slice(0, 8), 16) * 1000)
  }

  /** The `bson` compatible hex accessor. */
  toHexString(): string {
    return this.hex
  }

  toString(): string {
    return this.hex
  }

  toJSON(): string {
    return this.hex
  }

  equals(other: unknown): boolean {
    return other instanceof ObjectId && other.hex === this.hex
  }
}

const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n

/** A signed 64 bit integer backed by `bigint`. */
export class Long {
  readonly value: bigint

  constructor(value: bigint | number | string) {
    const big = typeof value === "bigint" ? value : BigInt(value)
    if (big < INT64_MIN || big > INT64_MAX)
      throw new RangeError("A Long must fit in 64 signed bits")
    this.value = big
  }

  get _bsontype(): "Long" {
    return "Long"
  }

  toBigInt(): bigint {
    return this.value
  }

  toNumber(): number {
    return Number(this.value)
  }

  toString(): string {
    return this.value.toString()
  }

  toJSON(): string {
    return this.value.toString()
  }
}

/** A decimal string; groups: fraction digits (after `1.` or `.`), then the written exponent. */
const DECIMAL = /^[+-]?(?:(?:\d+(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?|Infinity|inf|NaN)$/i

/**
 * A Decimal128 value, kept in its string form. Arithmetic is not supported. Its exponent, with the fraction
 * digits folded in, must stay within 6210 either way: Decimal128 holds exponents from -6176 to 6111 for up
 * to 34 digits, and computing with a larger one costs time and memory in proportion to it.
 */
export class Decimal128 {
  readonly value: string

  constructor(value: string) {
    const match = DECIMAL.exec(value)
    if (
      match === null ||
      Math.abs(Number(match[3] ?? 0) - (match[1] ?? match[2] ?? "").length) > 6210
    )
      throw new TypeError(`Invalid Decimal128 string: ${value}`)
    this.value = value
  }

  get _bsontype(): "Decimal128" {
    return "Decimal128"
  }

  toString(): string {
    return this.value
  }

  toJSON(): string {
    return this.value
  }
}

/** BSON binary data with a subtype. */
export class Binary {
  readonly bytes: Uint8Array
  readonly subType: number

  constructor(bytes: Uint8Array, subType = 0) {
    if (!Number.isInteger(subType) || subType < 0 || subType > 255) {
      throw new RangeError("A binary subtype must be an integer from 0 to 255")
    }
    this.bytes = bytes
    this.subType = subType
  }

  get _bsontype(): "Binary" {
    return "Binary"
  }

  /** The `bson` compatible subtype accessor. */
  get sub_type(): number {
    return this.subType
  }

  /** The `bson` compatible length accessor. */
  get position(): number {
    return this.bytes.length
  }

  /** The `bson` compatible buffer accessor. */
  get buffer(): Uint8Array {
    return this.bytes
  }
}

/** A BSON timestamp: seconds plus an increment, as used for cluster time. */
export class Timestamp {
  readonly t: number
  readonly i: number

  constructor(t: number, i: number) {
    if (!isUint32(t) || !isUint32(i)) {
      throw new RangeError("Timestamp parts must be unsigned 32 bit integers")
    }
    this.t = t
    this.i = i
  }

  get _bsontype(): "Timestamp" {
    return "Timestamp"
  }

  /** The uint64 value `(t << 32) | i`. */
  toBigInt(): bigint {
    return (BigInt(this.t) << 32n) | BigInt(this.i)
  }

  toString(): string {
    return this.toBigInt().toString()
  }
}

/** A BSON regular expression with MongoDB option letters. */
export class BSONRegExp {
  readonly pattern: string
  readonly options: string

  constructor(pattern: string, options = "") {
    this.pattern = pattern
    this.options = [...options].sort().join("")
  }

  get _bsontype(): "BSONRegExp" {
    return "BSONRegExp"
  }
}

/** The BSON MinKey value, which sorts before every other value. */
export class MinKey {
  get _bsontype(): "MinKey" {
    return "MinKey"
  }
}

/** The BSON MaxKey value, which sorts after every other value. */
export class MaxKey {
  get _bsontype(): "MaxKey" {
    return "MaxKey"
  }
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

/** Returns the `_bsontype` tag of a value, or `undefined` for plain values. */
export function bsonTypeTag(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const tag: unknown = (value as { _bsontype?: unknown })._bsontype
  return typeof tag === "string" ? tag : undefined
}
