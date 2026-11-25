import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  Binary,
  BSONRegExp,
  canonicalString,
  Decimal128,
  type Document,
  decode,
  InvalidQueryError,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "canopy.js/protocol"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { decodeDocuments, encodeDocument, encodeDocumentBatch } from "../../src/client/bson.ts"
import { bsonToEjson, ejsonToBson } from "../../src/core/wasm/client/canopy_client_js.js"

it("encodes a growing batch when a getter also encodes a document", () => {
  const text = "🦉".repeat(600)
  const doc = {
    get text() {
      expect(decodeDocuments(encodeDocument({ nested: true }))).toEqual([{ nested: true }])
      return text
    },
  }
  const batch = encodeDocumentBatch([{ count: 1 }, doc, { empty: null }])
  expect(decodeDocuments(batch)).toEqual([{ count: 1 }, { text }, { empty: null }])
})

const matcher = join(
  process.env["CANOPY_REPO"] ?? fileURLToPath(new URL("../../../Canopy", import.meta.url)),
  "conformance",
  "matcher",
)

/** What the Rust codec reads from BSON, in the client's value model. */
function rustValue(bytes: Uint8Array): string {
  return canonicalString(decode(JSON.parse(bsonToEjson(bytes, true)), { maxDepth: 200 }))
}

function outcome(run: () => Uint8Array): Uint8Array | "refused" {
  try {
    return run()
  } catch {
    return "refused"
  }
}

const key = fc
  .string({ unit: "grapheme", maxLength: 8 })
  .filter(
    (text) => !text.includes("\u0000") && !["__proto__", "constructor", "prototype"].includes(text),
  )

const hex = fc
  .uint8Array({ minLength: 12, maxLength: 12 })
  .map((bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""))

const decimal = fc
  .tuple(
    fc.constantFrom("", "-", "+"),
    fc.bigInt({ min: 0n, max: 10n ** 36n }),
    fc.integer({ min: -6200, max: 6200 }),
  )
  .map(([sign, digits, exponent]) => `${sign}${digits}E${exponent}`)

const leaf = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 12 }),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
  fc.integer({ min: -8.64e15, max: 8.64e15 }).map((ms) => new Date(ms)),
  hex.map((text) => new ObjectId(text)),
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map((value) => new Long(value)),
  fc
    .tuple(fc.uint8Array({ maxLength: 20 }), fc.integer({ min: 0, max: 255 }))
    .map(([bytes, subType]) => new Binary(bytes, subType)),
  fc.uint8Array({ maxLength: 8 }),
  fc
    .tuple(fc.nat({ max: 0xffffffff }), fc.nat({ max: 0xffffffff }))
    .map(([t, i]) => new Timestamp(t, i)),
  fc
    .tuple(
      fc.string({ maxLength: 8 }).filter((text) => !text.includes("\u0000")),
      fc.subarray(["i", "m", "s", "u", "x"]),
    )
    .map(([pattern, options]) => new BSONRegExp(pattern, options.join(""))),
  fc.constant(new MinKey()),
  fc.constant(new MaxKey()),
  decimal.map((text) => new Decimal128(text)),
)

const { document } = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.array(tie("value"), { maxLength: 4 }),
    tie("document"),
  ),
  document: fc.dictionary(key, tie("value"), { maxKeys: 5 }),
}))

describe("the client's BSON codec", () => {
  it("encodes every recorded conformance document as the Rust codec does, and reads it back", () => {
    const { documents } = JSON.parse(readFileSync(join(matcher, "filters.json"), "utf8")) as {
      readonly documents: readonly string[]
    }
    let compared = 0
    for (const [index, base64] of documents.entries()) {
      const recorded = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      let doc: Document
      try {
        doc = decode(JSON.parse(bsonToEjson(recorded, true)), { maxDepth: 200 }) as Document
      } catch {
        continue
      }
      const expected = ejsonToBson(canonicalString(doc))
      const bytes = encodeDocument(doc)
      expect(Array.from(bytes), `document ${index}`).toEqual(Array.from(expected))
      expect(decodeDocuments(expected).map(canonicalString), `document ${index}`).toEqual([
        canonicalString(doc),
      ])
      compared += 1
    }
    expect(compared).toBeGreaterThan(250)
  })

  it("writes the bytes the Rust codec writes for any document of the client's values", () => {
    fc.assert(
      fc.property(document, (doc) => {
        const text = canonicalString(doc)
        const expected = outcome(() => ejsonToBson(text))
        const actual = outcome(() => encodeDocument(doc))
        if (expected === "refused" || actual === "refused") {
          expect(actual).toBe(expected)
          return
        }
        expect(Array.from(actual)).toEqual(Array.from(expected))
        const read = decodeDocuments(actual).map(canonicalString)
        expect(read).toEqual([rustValue(actual)])
        if (!text.includes("$numberDecimal")) expect(read).toEqual([text])
      }),
      { numRuns: 400 },
    )
  })

  it("stores Decimal128 values exactly as the Rust codec does, refusing the same inexact ones", () => {
    const texts = [
      "0",
      "-0",
      "1.50",
      "1.5E+3",
      "+5",
      ".5",
      "5.",
      "0E+10",
      "0.000001",
      "0.0000001",
      "1E-6176",
      "1E-6177",
      "10E-6177",
      "1E+6111",
      "1E+6112",
      "1E+6144",
      "1E+6145",
      "1234567890123456789012345678901234",
      "12345678901234567890123456789012340",
      "12345678901234567890123456789012345",
      "9999999999999999999999999999999999E+6111",
      "Infinity",
      "-inf",
      "NaN",
      "-NaN",
    ]
    for (const text of texts) {
      const expected = outcome(() => ejsonToBson(`{"d":{"$numberDecimal":"${text}"}}`))
      const actual = outcome(() => encodeDocument({ d: new Decimal128(text) }))
      if (expected === "refused" || actual === "refused") {
        expect(actual, text).toBe(expected)
        continue
      }
      expect(Array.from(actual), text).toEqual(Array.from(expected))
      const [decoded] = decodeDocuments(actual)
      expect(String(decoded?.["d"]), text).toBe(
        (JSON.parse(bsonToEjson(actual, true)) as { d: { $numberDecimal: string } }).d
          .$numberDecimal,
      )
    }
  })

  it("writes documents larger than its scratch buffer", () => {
    const doc = {
      text: "x".repeat(3000),
      items: Array.from({ length: 300 }, (_, index) => ({ index, name: `item ${index}` })),
      tail: { at: new Date(0), id: new ObjectId("0123456789abcdef01234567") },
    }
    const bytes = encodeDocument(doc)
    expect(Array.from(bytes)).toEqual(Array.from(ejsonToBson(canonicalString(doc))))
    expect(decodeDocuments(bytes).map(canonicalString)).toEqual([canonicalString(doc)])
  })

  it("keeps numbers in the types canonical EJSON gives them", () => {
    const [decoded] = decodeDocuments(
      encodeDocument({ i: 7, d: 7.5, z: -0, big: 2 ** 31, n: 5n, l: new Long(-3n), u: undefined }),
    )
    expect(Object.keys(decoded ?? {})).toEqual(["i", "d", "z", "big", "n", "l"])
    expect(decoded?.["i"]).toBe(7)
    expect(decoded?.["d"]).toBe(7.5)
    expect(Object.is(decoded?.["z"], -0)).toBe(true)
    expect(decoded?.["big"]).toBe(2 ** 31)
    expect(decoded?.["n"]).toBeInstanceOf(Long)
    expect(String(decoded?.["n"])).toBe("5")
    expect(String(decoded?.["l"])).toBe("-3")
    expect(Object.getPrototypeOf(decoded)).toBeNull()
    expect(decodeDocuments(encodeDocument({ a: [1, undefined] }))[0]?.["a"]).toEqual([1, null])
  })

  it("refuses values that have no BSON form", () => {
    const refusals: Document[] = [
      { "a\u0000b": 1 },
      { a: new BSONRegExp("x\u0000", "") },
      { a: () => 1 },
      { a: Symbol("s") },
      { a: 2n ** 63n },
      { a: new Date(Number.NaN) },
      { a: new Decimal128("1E+6200") },
    ]
    for (const doc of refusals) expect(() => encodeDocument(doc)).toThrow(InvalidQueryError)
  })

  it("refuses malformed or unsupported BSON instead of guessing", () => {
    const name = Array.from("constructor", (char) => char.charCodeAt(0))
    const forbidden = Uint8Array.of(22, 0, 0, 0, 0x10, ...name, 0, 1, 0, 0, 0, 0)
    const undefinedType = Uint8Array.of(8, 0, 0, 0, 0x06, 0x61, 0, 0)
    const truncated = ejsonToBson('{"a":"text"}').subarray(0, 10)
    const unterminated = Uint8Array.of(5, 0, 0, 0, 1)
    for (const bytes of [forbidden, undefinedType, truncated, unterminated])
      expect(() => decodeDocuments(bytes)).toThrow(InvalidQueryError)
  })
})
