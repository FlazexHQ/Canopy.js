import {
  Binary,
  BSONRegExp,
  bsonTypeTag,
  Decimal128,
  type Document,
  InvalidQueryError,
  isDocument,
  isForbiddenKey,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "../core/protocol/index.ts"

const MAX_DEPTH = 200
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n
const MAX_DATE_MS = 8.64e15

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder("utf-8", { fatal: true })

let buffer = new Uint8Array(1024)
let view = new DataView(buffer.buffer)
let at = 0
let encoding = false

const SLAB_SIZE = 65536
let slab = new Uint8Array(SLAB_SIZE)
let slabUsed = 0

const INDEXES: readonly string[] = Array.from({ length: 256 }, (_, index) => String(index))

function malformed(reason: string): InvalidQueryError {
  return new InvalidQueryError(`Malformed BSON: ${reason}`)
}

function reserve(length: number): void {
  if (at + length <= buffer.length) return
  let size = buffer.length * 2
  while (size < at + length) size *= 2
  const next = new Uint8Array(size)
  next.set(buffer.subarray(0, at))
  buffer = next
  view = new DataView(buffer.buffer)
}

function writeByte(value: number): void {
  reserve(1)
  buffer[at] = value
  at += 1
}

function writeInt32(value: number): void {
  reserve(4)
  view.setInt32(at, value, true)
  at += 4
}

/** Writes UTF-8 text without a terminator; ASCII is copied directly, other text through `TextEncoder`. */
function writeText(text: string): void {
  const length = text.length
  reserve(length * 3)
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x80) {
      at += utf8.encodeInto(text.slice(index), buffer.subarray(at)).written
      return
    }
    buffer[at] = code
    at += 1
  }
}

function writeCString(text: string): void {
  if (text.includes("\u0000")) throw malformed("a name or pattern contains a NUL byte")
  writeText(text)
  writeByte(0)
}

function writeString(text: string): void {
  const start = at
  writeInt32(0)
  writeText(text)
  writeByte(0)
  view.setInt32(start, at - start - 4, true)
}

function writeBigInt64(value: bigint): void {
  if (value < INT64_MIN || value > INT64_MAX) throw malformed("an integer does not fit in 64 bits")
  reserve(8)
  view.setBigInt64(at, value, true)
  at += 8
}

function writeBytes(bytes: Uint8Array): void {
  reserve(bytes.length)
  buffer.set(bytes, at)
  at += bytes.length
}

function writeObjectId(hex: string): void {
  reserve(12)
  for (let index = 0; index < 12; index += 1)
    buffer[at + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  at += 12
}

function writeBinary(bytes: Uint8Array, subType: number): void {
  const old = subType === 2
  writeInt32(bytes.length + (old ? 4 : 0))
  writeByte(subType)
  if (old) writeInt32(bytes.length)
  writeBytes(bytes)
}

/** Writes one element: its type, its name and its value. */
function writeElement(name: string, value: unknown, depth: number): void {
  const typeAt = at
  writeByte(0)
  writeCString(name)
  const type = writeValue(value, depth)
  buffer[typeAt] = type
}

/** Writes a value and returns its BSON element type. */
function writeValue(value: unknown, depth: number): number {
  switch (typeof value) {
    case "string":
      writeString(value)
      return 0x02
    case "boolean":
      writeByte(value ? 1 : 0)
      return 0x08
    case "number":
      if (
        Number.isInteger(value) &&
        value >= INT32_MIN &&
        value <= INT32_MAX &&
        !Object.is(value, -0)
      ) {
        writeInt32(value)
        return 0x10
      }
      reserve(8)
      view.setFloat64(at, value, true)
      at += 8
      return 0x01
    case "bigint":
      writeBigInt64(value)
      return 0x12
    case "undefined":
      return 0x0a
    case "object":
      break
    default:
      throw new InvalidQueryError(`Cannot encode a value of type ${typeof value}`)
  }
  if (value === null) return 0x0a
  if (depth >= MAX_DEPTH) throw malformed("nesting too deep")
  if (Array.isArray(value)) {
    const start = at
    writeInt32(0)
    for (let index = 0; index < value.length; index += 1)
      writeElement(INDEXES[index] ?? String(index), value[index], depth + 1)
    writeByte(0)
    view.setInt32(start, at - start, true)
    return 0x04
  }
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms)) throw new InvalidQueryError("Cannot encode an invalid Date")
    writeBigInt64(BigInt(ms))
    return 0x09
  }
  if (value instanceof Uint8Array) {
    writeBinary(value, 0)
    return 0x05
  }
  if (value instanceof RegExp) {
    writeCString(value.source)
    writeCString(regexOptions(value.flags))
    return 0x0b
  }
  if (isDocument(value)) {
    writeFields(value, depth + 1)
    return 0x03
  }
  return writeTagged(value)
}

function regexOptions(flags: string): string {
  let options = ""
  for (const flag of flags) if (flag === "i" || flag === "m" || flag === "s") options += flag
  return [...options].sort().join("")
}

function writeFields(document: object, depth: number): void {
  const start = at
  writeInt32(0)
  const fields = document as Record<string, unknown>
  const keys = Object.keys(fields)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string
    const item = fields[key]
    if (item !== undefined) writeElement(key, item, depth)
  }
  writeByte(0)
  view.setInt32(start, at - start, true)
}

/** Writes a BSON value class (from this package or the `bson` package) and returns its element type. */
function writeTagged(value: object): number {
  const tag = bsonTypeTag(value)
  const fields = value as Record<string, unknown>
  switch (tag) {
    case "ObjectId":
      writeObjectId((value as { toHexString(): string }).toHexString().toLowerCase())
      return 0x07
    case "Long":
      writeBigInt64((value as { toBigInt(): bigint }).toBigInt())
      return 0x12
    case "Int32":
    case "Double": {
      const inner = fields["value"]
      if (typeof inner !== "number") break
      return writeValue(inner, 0)
    }
    case "Decimal128":
      writeBytes(decimalBytes(String(value)))
      return 0x13
    case "Binary": {
      const bytes = fields["buffer"]
      const length = fields["position"]
      const subType = fields["sub_type"]
      if (
        !(bytes instanceof Uint8Array) ||
        typeof length !== "number" ||
        typeof subType !== "number"
      )
        break
      writeBinary(bytes.subarray(0, length), subType)
      return 0x05
    }
    case "Timestamp": {
      const t =
        fields["t"] ?? (typeof fields["high"] === "number" ? fields["high"] >>> 0 : undefined)
      const i = fields["i"] ?? (typeof fields["low"] === "number" ? fields["low"] >>> 0 : undefined)
      if (typeof t !== "number" || typeof i !== "number") break
      writeInt32(i | 0)
      writeInt32(t | 0)
      return 0x11
    }
    case "BSONRegExp": {
      const pattern = fields["pattern"]
      const options = fields["options"]
      if (typeof pattern !== "string" || typeof options !== "string") break
      writeCString(pattern)
      writeCString([...options].sort().join(""))
      return 0x0b
    }
    case "MinKey":
      return 0xff
    case "MaxKey":
      return 0x7f
    case "BSONSymbol": {
      const text = fields["value"]
      if (typeof text !== "string") break
      writeString(text)
      return 0x02
    }
    default:
      break
  }
  throw new InvalidQueryError(`Cannot encode BSON type ${tag ?? "unknown"}`)
}

/**
 * Encodes a document as BSON, with the types its canonical EJSON has: an integral number in the 32 bit
 * range is an int32 and any other number a double, a `bigint` or `Long` is an int64, and fields whose value
 * is `undefined` are left out (inside arrays, `undefined` is null). Throws `InvalidQueryError` for a value
 * that has no BSON form.
 */
export function encodeDocument(document: Document): Uint8Array {
  return encode(document, true)
}

/** Encodes consecutive documents into scratch space, valid until the next encoding starts. */
export function encodeDocumentBatch(documents: readonly Document[]): Uint8Array {
  return encode(documents, false)
}

function encode(input: Document | readonly Document[], owned: boolean): Uint8Array {
  if (encoding) {
    const previous = buffer
    const previousView = view
    const position = at
    buffer = new Uint8Array(1024)
    view = new DataView(buffer.buffer)
    try {
      return writeInput(input, owned)
    } finally {
      buffer = previous
      view = previousView
      at = position
    }
  }
  encoding = true
  try {
    return writeInput(input, owned)
  } finally {
    encoding = false
  }
}

function writeInput(input: Document | readonly Document[], owned: boolean): Uint8Array {
  at = 0
  if (owned) writeFields(input, 0)
  else {
    for (const document of input as readonly Document[]) writeFields(document, 0)
    return buffer.subarray(0, at)
  }
  if (at > SLAB_SIZE / 4) return buffer.slice(0, at)
  if (slabUsed + at > SLAB_SIZE) {
    slab = new Uint8Array(SLAB_SIZE)
    slabUsed = 0
  }
  const out = slab.subarray(slabUsed, slabUsed + at)
  out.set(buffer.subarray(0, at))
  slabUsed += at
  return out
}

const DECIMAL_BIAS = 6176
const DECIMAL_MIN_EXPONENT = -6176
const DECIMAL_MAX_EXPONENT = 6111
const DECIMAL_MAX_DIGITS = 34

/** The 16 bytes of a Decimal128 given in string form. Values that would need rounding are refused. */
function decimalBytes(text: string): Uint8Array {
  const inexact = (): InvalidQueryError =>
    malformed(`${text} cannot be stored exactly as a Decimal128`)
  const negative = text.startsWith("-")
  const unsigned = negative || text.startsWith("+") ? text.slice(1) : text
  const sign = negative ? 1n << 63n : 0n
  const lower = unsigned.toLowerCase()
  if (lower === "nan") return packDecimal(0n, 0x7c00n << 48n)
  if (lower === "inf" || lower === "infinity") return packDecimal(0n, sign | (0x7800n << 48n))
  const marker = lower.indexOf("e")
  const mantissa = marker < 0 ? unsigned : unsigned.slice(0, marker)
  const written = marker < 0 ? "0" : unsigned.slice(marker + 1)
  if (!/^[+-]?\d+$/.test(written)) throw inexact()
  const dot = mantissa.indexOf(".")
  const whole = dot < 0 ? mantissa : mantissa.slice(0, dot)
  const fraction = dot < 0 ? "" : mantissa.slice(dot + 1)
  if ((whole === "" && fraction === "") || !/^\d*$/.test(whole) || !/^\d*$/.test(fraction))
    throw malformed(`${text} is not a decimal number`)
  let digits = `${whole}${fraction}`.replace(/^0+/, "")
  let exponent = Number(written) - fraction.length
  if (digits === "") digits = "0"
  while (digits.length > DECIMAL_MAX_DIGITS || exponent < DECIMAL_MIN_EXPONENT) {
    if (!digits.endsWith("0") || digits.length === 1) break
    digits = digits.slice(0, -1)
    exponent += 1
  }
  if (digits === "0")
    exponent = Math.min(Math.max(exponent, DECIMAL_MIN_EXPONENT), DECIMAL_MAX_EXPONENT)
  while (exponent > DECIMAL_MAX_EXPONENT && digits.length < DECIMAL_MAX_DIGITS && digits !== "0") {
    digits += "0"
    exponent -= 1
  }
  if (
    digits.length > DECIMAL_MAX_DIGITS ||
    exponent < DECIMAL_MIN_EXPONENT ||
    exponent > DECIMAL_MAX_EXPONENT
  )
    throw inexact()
  const coefficient = BigInt(digits)
  const high = sign | (BigInt(exponent + DECIMAL_BIAS) << 49n) | (coefficient >> 64n)
  return packDecimal(coefficient & 0xffff_ffff_ffff_ffffn, high)
}

function packDecimal(low: bigint, high: bigint): Uint8Array {
  const out = new Uint8Array(16)
  const data = new DataView(out.buffer)
  data.setBigUint64(0, low, true)
  data.setBigUint64(8, high, true)
  return out
}

/** The string form of the 16 bytes of a Decimal128, as the BSON specification defines it. */
function decimalText(data: DataView, offset: number): string {
  const low = data.getBigUint64(offset, true)
  const high = data.getBigUint64(offset + 8, true)
  const negative = high >> 63n === 1n
  const combination = Number((high >> 58n) & 0x1fn)
  let biased: number
  let coefficient: bigint
  if (combination >> 3 === 0b11) {
    if (combination === 0b11110) return negative ? "-Infinity" : "Infinity"
    if (combination === 0b11111) return "NaN"
    biased = Number((high >> 47n) & 0x3fffn)
    coefficient = 0n
  } else {
    biased = Number((high >> 49n) & 0x3fffn)
    coefficient = ((high & 0x1_ffff_ffff_ffffn) << 64n) | low
    if (coefficient > 9_999_999_999_999_999_999_999_999_999_999_999n) coefficient = 0n
  }
  const exponent = biased - DECIMAL_BIAS
  const digits = coefficient.toString()
  const adjusted = exponent + digits.length - 1
  let out = negative ? "-" : ""
  if (exponent <= 0 && adjusted >= -6) {
    if (exponent === 0) return out + digits
    const places = -exponent
    if (places >= digits.length) return `${out}0.${"0".repeat(places - digits.length)}${digits}`
    const split = digits.length - places
    return `${out}${digits.slice(0, split)}.${digits.slice(split)}`
  }
  out += digits.slice(0, 1)
  if (digits.length > 1) out += `.${digits.slice(1)}`
  return `${out}E${adjusted >= 0 ? "+" : ""}${adjusted}`
}

const HEX: readonly string[] = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
)

const NOTHING: Uint8Array = new Uint8Array(0)
let input: Uint8Array = NOTHING
let inputView: DataView | undefined
let position = 0

/** A view of the input for reading numbers wider than 32 bits, made on first use. */
function wide(): DataView {
  inputView ??= new DataView(input.buffer, input.byteOffset, input.byteLength)
  return inputView
}

function need(length: number): void {
  if (position + length > input.length) throw malformed("unexpected end of input")
}

function readInt32(): number {
  need(4)
  const at = position
  position += 4
  return (
    (input[at] ?? 0) |
    ((input[at + 1] ?? 0) << 8) |
    ((input[at + 2] ?? 0) << 16) |
    ((input[at + 3] ?? 0) << 24)
  )
}

/** Reads UTF-8 text up to `end`; short ASCII text is built directly, other text through `TextDecoder`. */
function readText(end: number): string {
  if (end - position <= 8) {
    let text = ""
    let index = position
    for (; index < end; index += 1) {
      const byte = input[index] ?? 0
      if (byte >= 0x80) break
      text += String.fromCharCode(byte)
    }
    if (index === end) {
      position = end
      return text
    }
  }
  let text: string
  try {
    text = fromUtf8.decode(input.subarray(position, end))
  } catch (error: unknown) {
    throw new InvalidQueryError("Malformed BSON: invalid UTF-8", { cause: error })
  }
  position = end
  return text
}

function readCString(): string {
  let end = position
  while (end < input.length && input[end] !== 0) end += 1
  if (end >= input.length) throw malformed("unterminated name")
  const text = readText(end)
  position += 1
  return text
}

const names = new Map<number, string>()
const MAX_NAMES = 4096

/**
 * Reads a field name. Names repeat across documents, so each is kept once by a hash of its bytes: the same
 * string comes back every time, which makes building the document and checking the name cheap.
 */
function readName(): string {
  let end = position
  let hash = 0
  while (end < input.length) {
    const byte = input[end] ?? 0
    if (byte === 0) break
    hash = (Math.imul(hash, 31) + byte) | 0
    end += 1
  }
  if (end >= input.length) throw malformed("unterminated name")
  const length = end - position
  hash = (Math.imul(hash, 31) + length) | 0
  const known = names.get(hash)
  if (known !== undefined && known.length === length) {
    let same = true
    for (let index = 0; index < length; index += 1)
      if (known.charCodeAt(index) !== input[position + index]) {
        same = false
        break
      }
    if (same) {
      position = end + 1
      return known
    }
  }
  const name = readText(end)
  position += 1
  if (known === undefined && names.size < MAX_NAMES && name.length === length) names.set(hash, name)
  return name
}

function readString(): string {
  const length = readInt32()
  if (length < 1) throw malformed("string length below 1")
  need(length)
  const end = position + length - 1
  if (input[end] !== 0) throw malformed("string without terminator")
  const text = readText(end)
  position += 1
  return text
}

/** Checks the length of a document or an array at the current position and returns where it ends. */
function openElements(depth: number): number {
  if (depth >= MAX_DEPTH) throw malformed("nesting too deep")
  const start = position
  const length = readInt32()
  if (length < 5 || start + length > input.length) throw malformed("bad document length")
  return start + length - 1
}

function closeElements(end: number): void {
  if (position !== end || input[end] !== 0) throw malformed("bad document terminator")
  position = end + 1
}

function readDocument(depth: number): Document {
  const end = openElements(depth)
  const out: Record<string, unknown> = {}
  while (position < end) {
    const kind = input[position] ?? 0
    position += 1
    const name = readName()
    if (isForbiddenKey(name)) throw new InvalidQueryError(`The key "${name}" is not allowed`)
    out[name] = readValue(kind, depth)
  }
  closeElements(end)
  return Object.setPrototypeOf(out, null) as Document
}

function readArray(depth: number): unknown[] {
  const end = openElements(depth)
  const items: unknown[] = []
  while (position < end) {
    const kind = input[position] ?? 0
    position += 1
    while (position < end && input[position] !== 0) position += 1
    position += 1
    items.push(readValue(kind, depth))
  }
  closeElements(end)
  return items
}

function readValue(kind: number, depth: number): unknown {
  switch (kind) {
    case 0x01: {
      need(8)
      const value = wide().getFloat64(position, true)
      position += 8
      return value
    }
    case 0x02:
    case 0x0e:
      return readString()
    case 0x03:
      return readDocument(depth + 1)
    case 0x04:
      return readArray(depth + 1)
    case 0x05: {
      let length = readInt32()
      need(length + 1)
      const subType = input[position] ?? 0
      position += 1
      if (subType === 2) {
        const inner = readInt32()
        if (inner !== length - 4) throw malformed("old binary length does not match its content")
        length = inner
      }
      const bytes = input.slice(position, position + length)
      position += length
      return new Binary(bytes, subType)
    }
    case 0x07: {
      need(12)
      let hex = ""
      for (let index = 0; index < 12; index += 1) hex += HEX[input[position + index] ?? 0]
      position += 12
      return new ObjectId(hex)
    }
    case 0x08: {
      need(1)
      const flag = input[position]
      position += 1
      if (flag === 0) return false
      if (flag === 1) return true
      throw malformed("boolean other than 0 or 1")
    }
    case 0x09: {
      need(8)
      const ms = Number(wide().getBigInt64(position, true))
      position += 8
      if (Math.abs(ms) > MAX_DATE_MS) throw new InvalidQueryError("Invalid EJSON $date")
      return new Date(ms)
    }
    case 0x0a:
      return null
    case 0x0b: {
      const pattern = readCString()
      return new BSONRegExp(pattern, readCString())
    }
    case 0x10:
      return readInt32()
    case 0x11: {
      need(8)
      const i = wide().getUint32(position, true)
      const t = wide().getUint32(position + 4, true)
      position += 8
      return new Timestamp(t, i)
    }
    case 0x12: {
      need(8)
      const value = wide().getBigInt64(position, true)
      position += 8
      return new Long(value)
    }
    case 0x13: {
      need(16)
      const text = decimalText(wide(), position)
      position += 16
      return new Decimal128(text)
    }
    case 0xff:
      return new MinKey()
    case 0x7f:
      return new MaxKey()
    default:
      throw new InvalidQueryError(
        `BSON type 0x${kind.toString(16).padStart(2, "0")} is not supported`,
      )
  }
}

/**
 * Decodes BSON documents laid end to end, into the values the EJSON codec gives for their canonical EJSON:
 * an int32 or a double is a number, an int64 a `Long`, and documents have a null prototype.
 */
export function decodeDocuments(bytes: Uint8Array): Document[] {
  input = bytes
  inputView = undefined
  position = 0
  const out: Document[] = []
  try {
    while (position < bytes.length) out.push(readDocument(0))
  } finally {
    input = NOTHING
    inputView = undefined
  }
  return out
}
