import { bsonTypeTag, decimalString, longValue, wrappedNumber } from "../protocol/index.ts"

/** A number read from any supported representation. */
export type NumericValue =
  | { readonly kind: "int" | "double"; readonly value: number }
  | { readonly kind: "long"; readonly value: bigint }
  | { readonly kind: "decimal"; readonly value: string }

/**
 * Reads a numeric value. Plain JavaScript numbers are classified the way the `bson` serializer stores them:
 * integers in the int32 range as `int`, everything else as `double`. `bigint` is treated as `long`.
 */
export function readNumeric(value: unknown): NumericValue | undefined {
  if (typeof value === "number") {
    return { kind: isInt32(value) ? "int" : "double", value }
  }
  if (typeof value === "bigint") return { kind: "long", value }
  const tag = bsonTypeTag(value)
  if (tag === undefined) return undefined
  if (tag === "Long") {
    const long = longValue(value)
    return long === undefined ? undefined : { kind: "long", value: long }
  }
  if (tag === "Int32" || tag === "Double") {
    const n = wrappedNumber(value)
    return n === undefined ? undefined : { kind: tag === "Int32" ? "int" : "double", value: n }
  }
  if (tag === "Decimal128") {
    const text = decimalString(value)
    return text === undefined ? undefined : { kind: "decimal", value: text }
  }
  return undefined
}

/** Returns true for integers that the `bson` serializer stores as int32. */
export function isInt32(value: number): boolean {
  return (
    Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 && !Object.is(value, -0)
  )
}

type Exact =
  | { readonly kind: "nan" }
  | { readonly kind: "inf"; readonly sign: 1 | -1 }
  | { readonly kind: "finite"; readonly n: bigint; readonly d: bigint }

const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

function exactOfDouble(value: number): Exact {
  if (Number.isNaN(value)) return { kind: "nan" }
  if (!Number.isFinite(value)) return { kind: "inf", sign: value > 0 ? 1 : -1 }
  if (value === 0) return { kind: "finite", n: 0n, d: 1n }
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const sign = hi >>> 31 === 1 ? -1n : 1n
  const exponentBits = (hi >>> 20) & 0x7ff
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  let exponent: number
  if (exponentBits === 0) {
    exponent = -1074
  } else {
    mantissa |= 1n << 52n
    exponent = exponentBits - 1075
  }
  return exponent >= 0
    ? { kind: "finite", n: sign * (mantissa << BigInt(exponent)), d: 1n }
    : { kind: "finite", n: sign * mantissa, d: 1n << BigInt(-exponent) }
}

function exactOfDecimal(text: string): Exact {
  const lower = text.toLowerCase()
  if (lower === "nan" || lower === "+nan" || lower === "-nan") return { kind: "nan" }
  if (/^[+]?(inf|infinity)$/.test(lower)) return { kind: "inf", sign: 1 }
  if (/^-(inf|infinity)$/.test(lower)) return { kind: "inf", sign: -1 }
  const match = DECIMAL.exec(text)
  if (match === null) return { kind: "nan" }
  const sign = match[1] === "-" ? -1n : 1n
  const intPart = match[2] ?? ""
  const fracPart = match[3] ?? ""
  const exponent = Number.parseInt(match[4] ?? "0", 10) - fracPart.length
  const digits = `${intPart}${fracPart}`.replace(/^0+/, "")
  if (digits === "") return { kind: "finite", n: 0n, d: 1n }
  const coefficient = sign * BigInt(digits)
  return exponent >= 0
    ? { kind: "finite", n: coefficient * 10n ** BigInt(exponent), d: 1n }
    : { kind: "finite", n: coefficient, d: 10n ** BigInt(-exponent) }
}

function exactOf(value: NumericValue): Exact {
  switch (value.kind) {
    case "int":
    case "double":
      return exactOfDouble(value.value)
    case "long":
      return { kind: "finite", n: value.value, d: 1n }
    case "decimal":
      return exactOfDecimal(value.value)
  }
}

/**
 * Compares two numbers by exact value, the way MongoDB does across int, long, double and decimal. NaN equals
 * NaN and sorts before every other number; negative zero equals zero.
 */
export function compareNumeric(a: NumericValue, b: NumericValue): number {
  if ((a.kind === "int" || a.kind === "double") && (b.kind === "int" || b.kind === "double")) {
    const x = a.value
    const y = b.value
    if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : -1
    if (Number.isNaN(y)) return 1
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (a.kind === "long" && b.kind === "long") {
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  }
  const x = exactOf(a)
  const y = exactOf(b)
  if (x.kind === "nan") return y.kind === "nan" ? 0 : -1
  if (y.kind === "nan") return 1
  if (x.kind === "inf") return y.kind === "inf" ? (x.sign === y.sign ? 0 : x.sign) : x.sign
  if (y.kind === "inf") return -y.sign
  const left = x.n * y.d
  const right = y.n * x.d
  return left < right ? -1 : left > right ? 1 : 0
}

/** Returns true when the number is NaN in any representation. */
export function isNaNValue(value: NumericValue): boolean {
  if (value.kind === "int" || value.kind === "double") return Number.isNaN(value.value)
  if (value.kind === "decimal") return exactOfDecimal(value.value).kind === "nan"
  return false
}

/**
 * Converts a number to a JavaScript double, as MongoDB does for `$mod` and `$size` operands. Decimal values are
 * parsed with `Number`, which rounds to the nearest double.
 */
export function toDouble(value: NumericValue): number {
  switch (value.kind) {
    case "int":
    case "double":
      return value.value
    case "long":
      return Number(value.value)
    case "decimal":
      return Number(value.value)
  }
}
