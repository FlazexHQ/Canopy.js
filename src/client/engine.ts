import {
  type CanopyErrorOptions,
  type Document,
  InvalidQueryError,
  isDocument,
} from "../core/protocol/index.ts"
import { decodeDocuments, encodeDocument, encodeDocumentBatch } from "./bson.ts"

/**
 * Raised for a valid MongoDB query construct that the client core does not evaluate in process. A live
 * query with such a filter trusts the server's membership instead of predicting it.
 */
export class UnsupportedQueryError extends InvalidQueryError {
  static {
    UnsupportedQueryError.registerType(UnsupportedQueryError.prototype, "UnsupportedQueryError")
  }

  constructor(message: string, options?: CanopyErrorOptions) {
    super(message, options)
  }
}

/** A filter compiled by the client core. Release it with `free()` once it is no longer used. */
export interface DocumentFilter {
  /**
   * Decides every document in one call: `true` for a match, `false` for no match, `undefined` when the
   * core cannot decide (callers then rely on the server).
   * Pass a new document object when its BSON content changes, including changes to nested values.
   */
  matchAll(documents: readonly Document[]): (boolean | undefined)[]
  /** Releases the compiled filter. */
  free(): void
}

/**
 * The Rust client core, as the client uses it. Documents cross the boundary as BSON. A retained document
 * keeps its slot until its object is collected. The store replaces the object when its content changes.
 */
export interface Engine {
  /** `wasm` when the WebAssembly build runs, `js` for its JavaScript translation. */
  readonly kind: "wasm" | "js"
  /** Compiles a filter. Throws `UnsupportedQueryError` or `InvalidQueryError`. */
  compileFilter(filter: Document): DocumentFilter
  /**
   * Orders documents by a MongoDB sort with the `_id` tie breaker. Returns the position of each document in
   * sorted order. Throws `InvalidQueryError` for an invalid sort or for parallel arrays.
   */
  sortOrder(sort: Readonly<Record<string, unknown>>, documents: readonly Document[]): number[]
  /** Projects every document with one specification. */
  project(fields: Readonly<Record<string, unknown>>, documents: readonly Document[]): Document[]
  /**
   * Applies a MongoDB update to a copy of `doc`; the copy shares the values of the top level fields the update
   * leaves alone. Throws when MongoDB would refuse the update.
   */
  applyUpdate(doc: Document, update: Document): Document
}

interface FilterBinding {
  matchConcatenated(documents: Uint8Array): Uint8Array
  free(): void
}

interface CacheBinding {
  retain(documents: Uint8Array): Uint32Array
  release(slots: Uint32Array): void
  matchFilter(filter: FilterBinding, slots: Uint32Array): Uint8Array
  reserveMatchBatch(capacity: number): number
  matchBatch(filter: FilterBinding, count: number): void
}

interface ClientBinding {
  readonly Filter: { fromBson(bytes: Uint8Array): FilterBinding }
  readonly DocumentCache: new () => CacheBinding
  matchBatchMemory(): ArrayBuffer
}

interface UpdateCacheBinding {
  retain(document: Uint8Array): number
  release(slots: Uint32Array): void
  update(slot: number, update: Uint8Array, now?: string | null): Uint8Array
}

interface TransformsBinding {
  sortBson(spec: Uint8Array, documents: Uint8Array): Uint32Array
  projectBson(spec: Uint8Array, documents: Uint8Array): Uint8Array
  updateBson(update: Uint8Array, documents: Uint8Array, now?: string | null): Uint8Array
  readonly UpdateCache: new () => UpdateCacheBinding
}

type WasmSource = URL | BufferSource

interface WasmModule {
  default(input: { module_or_path: WasmSource }): Promise<unknown>
}

interface HostFs {
  readFileSync(path: string): Uint8Array<ArrayBuffer>
}

interface HostUrl {
  fileURLToPath(url: string): string
}

interface Host {
  readonly process?: { getBuiltinModule?(id: string): unknown }
}

const MATCH = 1
const NO_MATCH = 0

/** The bytes of a module next to this file when it runs from disk, where `fetch` cannot read `file:`. */
function wasmSource(url: URL): WasmSource {
  if (url.protocol !== "file:") return url
  const builtin = (globalThis as Host).process?.getBuiltinModule
  if (builtin === undefined) return url
  const fs = builtin("node:fs") as HostFs | undefined
  const path = builtin("node:url") as HostUrl | undefined
  if (fs === undefined || path === undefined) return url
  return fs.readFileSync(path.fileURLToPath(url.href))
}

/**
 * Loads one module: the WebAssembly build where WebAssembly exists and may compile, its JavaScript
 * translation otherwise (React Native on Hermes, or a page whose Content Security Policy forbids
 * compiling WebAssembly).
 */
async function loadModule<T>(
  native: () => Promise<WasmModule & T>,
  translated: () => Promise<T>,
  asset: () => URL,
): Promise<{ readonly binding: T; readonly kind: "wasm" | "js" }> {
  if (typeof WebAssembly === "object") {
    try {
      const binding = await native()
      await binding.default({ module_or_path: wasmSource(asset()) })
      return { binding, kind: "wasm" }
    } catch {}
  }
  return { binding: await translated(), kind: "js" }
}

const encodings = new WeakMap<object, Uint8Array>()

/** The BSON of a document, encoded on first use and kept as long as the document object lives. */
function bsonOf(doc: Readonly<Record<string, unknown>>): Uint8Array {
  let bytes = encodings.get(doc)
  if (bytes === undefined) {
    bytes = encodeDocument(doc)
    encodings.set(doc, bytes)
  }
  return bytes
}

let joined = new Uint8Array(4096)

/** The BSON of documents laid end to end, in a buffer reused by the next call. */
function bsonOfAll(documents: readonly Document[]): Uint8Array {
  if (documents.length === 1) {
    const [only] = documents
    if (only !== undefined) return bsonOf(only)
  }
  const parts: Uint8Array[] = new Array(documents.length)
  let length = 0
  for (let index = 0; index < documents.length; index += 1) {
    const bytes = bsonOf(documents[index] as Document)
    parts[index] = bytes
    length += bytes.length
  }
  if (joined.length < length) joined = new Uint8Array(Math.max(length, joined.length * 2))
  let offset = 0
  for (const bytes of parts) {
    joined.set(bytes, offset)
    offset += bytes.length
  }
  return joined.subarray(0, offset)
}

/** Turns an error thrown by the core (`code` plus `Name: message`) into the matching client error. */
function translateError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof InvalidQueryError) return error
  const code: unknown = (error as { code?: unknown }).code
  if (code !== "CANOPY_INVALID_QUERY") return error
  const separator = error.message.indexOf(": ")
  const name = separator < 0 ? "" : error.message.slice(0, separator)
  const message = separator < 0 ? error.message : error.message.slice(separator + 2)
  return name === "UnsupportedQueryError"
    ? new UnsupportedQueryError(message, { cause: error })
    : new InvalidQueryError(message, { cause: error })
}

function calling<T>(call: () => T): T {
  try {
    return call()
  } catch (error: unknown) {
    throw translateError(error)
  }
}

/** The core's decisions in document order. A scratch view is valid until the next call. */
interface Retained {
  decide(compiled: FilterBinding, documents: readonly Document[]): Uint8Array | Uint32Array
}

/**
 * A document seen for the first time crosses as BSON and is matched in place; one seen again is decoded once
 * into a slot of the core's document cache and matched there from then on, which avoids reading its BSON on
 * every call. A slot is released once its document object is garbage collected; without
 * `FinalizationRegistry`, every document crosses as BSON.
 */
function retainedDocuments(client: ClientBinding): Retained {
  if (typeof FinalizationRegistry !== "function")
    return {
      decide: (compiled, documents) => compiled.matchConcatenated(encodeDocumentBatch(documents)),
    }
  const cache = new client.DocumentCache()
  const slots = new WeakMap<object, number>()
  const seen = new WeakSet<object>()
  const collected: number[] = []
  const registry = new FinalizationRegistry<number>((slot) => {
    collected.push(slot)
  })
  let capacity = 0
  let offset = 0
  let batch = new Uint32Array(0)
  let batchInUse = false
  function batchView(): Uint32Array {
    const memory = client.matchBatchMemory()
    if (batch.buffer !== memory || batch.length !== capacity)
      batch = new Uint32Array(memory, offset, capacity)
    return batch
  }
  return {
    decide(compiled, documents) {
      if (collected.length > 0) cache.release(Uint32Array.from(collected.splice(0)))
      const count = documents.length
      if (!batchInUse) {
        batchInUse = true
        try {
          if (capacity < count) {
            const next = Math.max(count, capacity * 2)
            offset = cache.reserveMatchBatch(next)
            capacity = next
          }
          const input = batchView()
          let index = 0
          for (; index < count; index += 1) {
            const slot = slots.get(documents[index] as Document)
            if (slot === undefined) break
            input[index] = slot
          }
          if (index === count && input.buffer === client.matchBatchMemory()) {
            cache.matchBatch(compiled, count)
            return batchView()
          }
        } finally {
          batchInUse = false
        }
      }

      const fresh: Document[] = []
      const retain: Document[] = []
      for (let index = 0; index < count; index += 1) {
        const doc = documents[index] as Document
        const slot = slots.get(doc)
        if (slot !== undefined) continue
        if (seen.has(doc)) retain.push(doc)
        else fresh.push(doc)
      }
      if (retain.length > 0) {
        const added = cache.retain(encodeDocumentBatch(retain))
        const redundant: number[] = []
        retain.forEach((doc, position) => {
          const slot = added[position]
          if (slot === undefined) return
          if (slots.has(doc)) {
            redundant.push(slot)
            return
          }
          slots.set(doc, slot)
          registry.register(doc, slot)
        })
        if (redundant.length > 0) cache.release(Uint32Array.from(redundant))
      }
      if (fresh.length === 0) {
        const found = new Uint32Array(count)
        for (let index = 0; index < count; index += 1) {
          const doc = documents[index] as Document
          found[index] = slots.get(doc) ?? 0
        }
        return cache.matchFilter(compiled, found)
      }
      const direct = compiled.matchConcatenated(encodeDocumentBatch(fresh))
      for (const doc of fresh) seen.add(doc)
      if (fresh.length === count) return direct
      const kept: number[] = []
      const keptAt: number[] = []
      for (let index = 0; index < count; index += 1) {
        const slot = slots.get(documents[index] as Document)
        if (slot === undefined) continue
        kept.push(slot)
        keptAt.push(index)
      }
      const decisions = new Uint8Array(count)
      const retained =
        kept.length > 0 ? cache.matchFilter(compiled, Uint32Array.from(kept)) : decisions
      keptAt.forEach((index, position) => {
        decisions[index] = retained[position] ?? 2
      })
      let next = 0
      for (let index = 0; index < count; index += 1) {
        if (slots.has(documents[index] as Document)) continue
        decisions[index] = direct[next] ?? 2
        next += 1
      }
      return decisions
    },
  }
}

/** Sets a field as an own property, also when its name is `__proto__`. */
function assign(doc: Document, key: string, value: unknown): void {
  if (key === "__proto__")
    Object.defineProperty(doc, key, { value, enumerable: true, writable: true, configurable: true })
  else doc[key] = value
}

/**
 * The document an update produced, from the original and what the core reports: the top level fields the
 * update touched (`c`) and, when the field names or their order changed, every field name in order (`k`).
 */
function updated(doc: Document, changes: Document | undefined): Document {
  const changed = changes?.["c"]
  if (!isDocument(changed)) throw new InvalidQueryError("The core returned no update")
  const keys = changes?.["k"]
  if (keys === undefined) {
    const out: Document = { ...doc }
    for (const key of Object.keys(changed)) assign(out, key, changed[key])
    return out
  }
  if (!Array.isArray(keys)) throw new InvalidQueryError("The core returned no field names")
  const out: Document = {}
  for (const key of keys) {
    if (typeof key !== "string") throw new InvalidQueryError("The core returned no field names")
    assign(out, key, Object.hasOwn(changed, key) ? changed[key] : doc[key])
  }
  return out
}

/**
 * Applies optimistic updates on documents kept decoded in the core: a document is decoded once, each update
 * keeps its result in a new slot and returns only the top level fields it touched, so applying another
 * update to the result decodes nothing. A slot is released once its document object is garbage collected;
 * without `FinalizationRegistry`, every update sends the whole document and decodes the whole result.
 */
function retainedUpdates(
  transforms: TransformsBinding,
): (doc: Document, update: Document) => Document {
  if (typeof FinalizationRegistry !== "function") {
    return (doc, update) => {
      const [result] = decodeDocuments(
        transforms.updateBson(bsonOf(update), bsonOf(doc), String(Date.now())),
      )
      if (result === undefined) throw new InvalidQueryError("The core returned no document")
      return result
    }
  }
  const cache = new transforms.UpdateCache()
  const slots = new WeakMap<object, number>()
  const collected: number[] = []
  const registry = new FinalizationRegistry<number>((slot) => {
    collected.push(slot)
  })
  const keep = (doc: Document, slot: number): void => {
    slots.set(doc, slot)
    registry.register(doc, slot)
  }
  return (doc, update) => {
    if (collected.length > 0) cache.release(Uint32Array.from(collected.splice(0)))
    let slot = slots.get(doc)
    if (slot === undefined) {
      slot = cache.retain(bsonOf(doc))
      keep(doc, slot)
    }
    const out = cache.update(slot, bsonOf(update), String(Date.now()))
    if (out.length < 4) throw new InvalidQueryError("The core returned no update")
    const next = new DataView(out.buffer, out.byteOffset, 4).getUint32(0, true)
    const result = updated(doc, decodeDocuments(out.subarray(4))[0])
    keep(result, next)
    return result
  }
}

function createEngine(
  client: ClientBinding,
  transforms: TransformsBinding,
  kind: "wasm" | "js",
): Engine {
  const retained = retainedDocuments(client)
  const update = retainedUpdates(transforms)
  return {
    kind,
    compileFilter(filter) {
      const compiled = calling(() => client.Filter.fromBson(encodeDocument(filter)))
      return {
        matchAll(documents) {
          const count = documents.length
          if (count === 0) return []
          const decisions = calling(() => retained.decide(compiled, documents))
          const out: (boolean | undefined)[] = new Array(count)
          for (let index = 0; index < count; index += 1) {
            const decision = decisions[index]
            out[index] = decision === MATCH ? true : decision === NO_MATCH ? false : undefined
          }
          return out
        },
        free() {
          compiled.free()
        },
      }
    },
    sortOrder(sort, documents) {
      return Array.from(calling(() => transforms.sortBson(bsonOf(sort), bsonOfAll(documents))))
    },
    project(fields, documents) {
      if (documents.length === 0) return []
      return decodeDocuments(
        calling(() => transforms.projectBson(bsonOf(fields), bsonOfAll(documents))),
      )
    },
    applyUpdate(doc, spec) {
      return calling(() => update(doc, spec))
    },
  }
}

let loading: Promise<Engine> | undefined
let loaded: Engine | undefined

/**
 * Loads the client core once and shares it: both modules are fetched and compiled in parallel. A failed
 * load is retried by the next call.
 */
export function loadEngine(): Promise<Engine> {
  loading ??= Promise.all([
    loadModule<ClientBinding>(
      () => import("../core/wasm/client/canopy_client.js"),
      () => import("../core/wasm/client/canopy_client_js.js"),
      () => new URL("../core/wasm/client/canopy_client_bg.wasm", import.meta.url),
    ),
    loadModule<TransformsBinding>(
      () => import("../core/wasm/transforms/canopy_transforms.js"),
      () => import("../core/wasm/transforms/canopy_transforms_js.js"),
      () => new URL("../core/wasm/transforms/canopy_transforms_bg.wasm", import.meta.url),
    ),
  ]).then(
    ([client, transforms]) => {
      loaded = createEngine(
        client.binding,
        transforms.binding,
        client.kind === "wasm" && transforms.kind === "wasm" ? "wasm" : "js",
      )
      return loaded
    },
    (error: unknown) => {
      loading = undefined
      throw error
    },
  )
  return loading
}

/** The client core once `loadEngine()` has settled, or `undefined` before. */
export function loadedEngine(): Engine | undefined {
  return loaded
}

/**
 * Whether the client core evaluates `filter` in process: `false` for a valid filter it leaves to the
 * server, `undefined` for one that is not a valid filter at all.
 */
export function evaluatesInProcess(engine: Engine, filter: unknown): boolean | undefined {
  if (!isDocument(filter)) return undefined
  try {
    engine.compileFilter(filter).free()
    return true
  } catch (error: unknown) {
    if (error instanceof UnsupportedQueryError) return false
    return undefined
  }
}
