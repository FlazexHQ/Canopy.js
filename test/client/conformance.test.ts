import { canonicalString, type Document, decode, InvalidQueryError } from "canopy.js/protocol"
import { describe, expect, it } from "vitest"

import type { Engine } from "../../src/client/engine.ts"
import { bsonToEjson, ejsonToBson } from "../../src/core/wasm/client/canopy_client_js.js"
import { matcherFixture } from "../support/conformance.ts"
import { freshGraph } from "../support/fresh.ts"

interface Fixture<Case> {
  readonly documents: readonly string[]
  readonly cases: readonly Case[]
}

async function fixture<Case>(name: string): Promise<Fixture<Case>> {
  return (await matcherFixture(name)) as Fixture<Case>
}

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

/**
 * The client's own value for a recorded BSON document, or `undefined` when the client's value model cannot
 * hold it exactly (an integral double, which JavaScript reads as a plain number, or a legacy BSON type):
 * the value must encode back to the recorded bytes.
 */
function value(base64: string): Document | undefined {
  const bytes = bytesOf(base64)
  const decoded = decode(JSON.parse(bsonToEjson(bytes, true))) as Document
  return sameBytes(ejsonToBson(canonicalString(decoded)), bytes) ? decoded : undefined
}

/** A recorded result as the client shows it. */
function shown(base64: string): string {
  return canonicalString(decode(JSON.parse(bsonToEjson(bytesOf(base64), true))))
}

function isUnsupported(error: unknown): boolean {
  return error instanceof InvalidQueryError && error.name === "UnsupportedQueryError"
}

/** Loads the client core in one format, from a fresh copy of the engine module. */
async function engineIn(kind: "wasm" | "js"): Promise<Engine> {
  const graph = freshGraph()
  const host = globalThis as { WebAssembly?: unknown }
  const saved = host.WebAssembly
  if (kind === "js") host.WebAssembly = undefined
  try {
    const { loadEngine } =
      await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const engine = await loadEngine()
    expect(engine.kind).toBe(kind)
    return engine
  } finally {
    host.WebAssembly = saved
  }
}

interface FilterCase {
  readonly filter: string
  readonly matches?: string
  readonly error?: string
}

interface SortCase {
  readonly sort: string
  readonly order?: readonly number[]
  readonly error?: string
}

interface ProjectionCase {
  readonly projection: string
  readonly documents?: readonly string[]
  readonly error?: string
}

interface UpdateCase {
  readonly document: number
  readonly update: string
  readonly arrayFilters?: string
  readonly result?: string
  readonly error?: string
}

describe.each(["wasm", "js"] as const)("matcher conformance through the %s client core", (kind) => {
  it("decides every filter as MongoDB did", async () => {
    const engine = await engineIn(kind)
    const { documents, cases } = await fixture<FilterCase>("filters")
    const docs = documents.map(value)
    const held = docs.flatMap((doc, position) => (doc === undefined ? [] : [{ doc, position }]))
    let decided = 0
    let refused = 0
    let skipped = 0
    for (const [index, item] of cases.entries()) {
      const filter = value(item.filter)
      if (filter === undefined) {
        skipped += 1
        continue
      }
      if (item.error !== undefined) {
        expect(() => engine.compileFilter(filter), `filter ${index}`).toThrow(InvalidQueryError)
        refused += 1
        continue
      }
      const compiled = engine.compileFilter(filter)
      try {
        const expected = Uint8Array.from((item.matches ?? "").match(/../g) ?? [], (byte) =>
          Number.parseInt(byte, 16),
        )
        const decisions = compiled.matchAll(held.map(({ doc }) => doc))
        held.forEach(({ position }, at) => {
          const bit = ((expected[position >> 3] ?? 0) >> (position & 7)) & 1
          expect(decisions[at], `filter ${index}, document ${position}`).toBe(bit === 1)
        })
        decided += 1
      } finally {
        compiled.free()
      }
    }
    expect({ documents: held.length, decided, refused, skipped }).toEqual({
      documents: 286,
      decided: 1946,
      refused: 9,
      skipped: 45,
    })
  })

  it("sorts every page in MongoDB's order", async () => {
    const engine = await engineIn(kind)
    const { documents, cases } = await fixture<SortCase>("sorts")
    const docs = documents.map(value)
    const held = docs.flatMap((doc, position) => (doc === undefined ? [] : [{ doc, position }]))
    let sorted = 0
    let refused = 0
    for (const [index, item] of cases.entries()) {
      const spec = value(item.sort)
      if (spec === undefined) throw new Error(`sort ${index} is not a client value`)
      const sort = () =>
        engine.sortOrder(
          spec,
          held.map(({ doc }) => doc),
        )
      if (item.error !== undefined) {
        expect(sort, `sort ${index}`).toThrow(InvalidQueryError)
        refused += 1
        continue
      }
      const kept = new Set(held.map(({ position }) => position))
      const expected = (item.order ?? []).filter((position) => kept.has(position))
      expect(
        sort().map((at) => held[at]?.position),
        `sort ${index}`,
      ).toEqual(expected)
      sorted += 1
    }
    expect({ sorted, refused }).toEqual({ sorted: 121, refused: 79 })
  })

  it("projects every document as MongoDB did", async () => {
    const engine = await engineIn(kind)
    const { documents, cases } = await fixture<ProjectionCase>("projections")
    const docs = documents.map(value)
    let projected = 0
    let refused = 0
    let compared = 0
    for (const [index, item] of cases.entries()) {
      const spec = value(item.projection)
      if (spec === undefined) throw new Error(`projection ${index} is not a client value`)
      if (item.error !== undefined) {
        expect(() => engine.project(spec, [{ _id: 1 }]), `projection ${index}`).toThrow(
          InvalidQueryError,
        )
        refused += 1
        continue
      }
      const pairs = docs.flatMap((doc, position) => {
        const expected = item.documents?.[position]
        return doc === undefined || expected === undefined ? [] : [{ doc, expected, position }]
      })
      const results = engine.project(
        spec,
        pairs.map(({ doc }) => doc),
      )
      pairs.forEach(({ expected, position }, at) => {
        expect(canonicalString(results[at]), `projection ${index}, document ${position}`).toBe(
          shown(expected),
        )
        compared += 1
      })
      projected += 1
    }
    expect({ projected, refused, compared }).toEqual({
      projected: 122,
      refused: 78,
      compared: 122 * 286,
    })
  })

  it("applies every update as MongoDB did", async () => {
    const engine = await engineIn(kind)
    const { documents, cases } = await fixture<UpdateCase>("updates")
    const docs = documents.map(value)
    const counts = { applied: 0, refused: 0, unsupported: [] as number[], skipped: 0 }
    for (const [index, item] of cases.entries()) {
      const doc = docs[item.document]
      const update = value(item.update)
      if (doc === undefined || update === undefined || item.arrayFilters !== undefined) {
        counts.skipped += 1
        continue
      }
      let result: Document
      try {
        result = engine.applyUpdate(doc, update)
      } catch (error: unknown) {
        if (isUnsupported(error)) {
          expect((error as Error).message).toBe("Decimal128 arithmetic is not evaluated in process")
          counts.unsupported.push(index)
          continue
        }
        expect(item.error, `update ${index} threw ${String(error)}`).toBeDefined()
        expect(error).toBeInstanceOf(InvalidQueryError)
        counts.refused += 1
        continue
      }
      expect(item.error, `update ${index} should be refused`).toBeUndefined()
      expect(canonicalString(result), `update ${index}`).toBe(shown(item.result ?? ""))
      counts.applied += 1
    }
    expect(counts).toEqual({
      applied: 812,
      refused: 903,
      unsupported: [163, 596, 893, 1111],
      skipped: 281,
    })
  })
})
