import {
  type ClusterTime,
  canonicalString,
  compareCt,
  type Document,
  ZERO_CT,
} from "../core/protocol/index.ts"
import {
  type DocumentFilter,
  type Engine,
  loadEngine,
  loadedEngine,
  UnsupportedQueryError,
} from "./engine.ts"

/** The cache key of a document: `collection/canonical(_id)`. */
export function cacheKey(coll: string, id: unknown): string {
  return `${coll}/${canonicalString(id)}`
}

/** The status of a live query. */
export type QueryStatus = "loading" | "ready" | "stale" | "error"

/** What a live query exposes. `data` keeps object identity for unchanged documents. */
export interface QueryState<T = Document> {
  readonly data: readonly T[]
  readonly status: QueryStatus
  readonly error: Error | undefined
}

/** The state of a query that has no data yet. One shared frozen value, so snapshots stay referentially stable. */
export const LOADING_STATE: QueryState<never> = Object.freeze({
  data: Object.freeze([]),
  status: "loading",
  error: undefined,
})

/** An optimistic change, applied on top of server state until its mutation is confirmed or rolled back. */
export type Layer =
  | { readonly kind: "insert"; readonly coll: string; readonly id: unknown; readonly doc: Document }
  | {
      readonly kind: "update"
      readonly coll: string
      readonly id: unknown
      readonly update: Document
    }
  | {
      readonly kind: "replace"
      readonly coll: string
      readonly id: unknown
      readonly doc: Document
      readonly upsert: boolean
    }
  | { readonly kind: "delete"; readonly coll: string; readonly id: unknown }
  | {
      readonly kind: "updateMany"
      readonly coll: string
      readonly filter: Document
      readonly update: Document
    }
  | { readonly kind: "deleteMany"; readonly coll: string; readonly filter: Document }

/**
 * A filter as the store holds it: `undefined` until the client core compiles it, `null` when the core
 * cannot evaluate it (or it is invalid), so the server decides.
 */
type Matcher = DocumentFilter | null | undefined

interface LayerEntry {
  readonly mid: string
  readonly layer: Layer
  readonly key: string | undefined
  matcher: Matcher
  /** Set once acknowledged without an echo: the layer waits for server state at this time. */
  awaiting: { readonly ct: ClusterTime; readonly keys: Set<string> } | undefined
}

interface DocEntry {
  readonly coll: string
  readonly id: unknown
  readonly key: string
  server: Document | undefined
  ct: ClusterTime
  tombstone: boolean
  readonly subs: Set<string>
  /** Confirmed by an ack without echo: predicted until the server's own message reaches `ct`. */
  provisional: { readonly ct: ClusterTime; readonly until: number } | undefined
  view:
    | {
        readonly source: Document | undefined
        readonly version: number
        readonly doc: Document | undefined
        readonly touched: boolean
      }
    | undefined
  removedAt: number | undefined
}

interface QueryEntry {
  readonly id: string
  readonly coll: string
  readonly sort: Readonly<Record<string, unknown>>
  /** Whether the sort names fields; without any, the order is by `_id` alone, which never changes. */
  readonly sorted: boolean
  /** The filter to predict membership with, or `undefined` when a function projects the query. */
  readonly filter: Document | undefined
  matcher: Matcher
  readonly limit: number | undefined
  readonly fields: Readonly<Record<string, unknown>> | undefined
  readonly project: ((doc: Document) => Document) | undefined
  readonly projected: Map<string, { readonly source: Document; readonly doc: Document }>
  status: QueryStatus
  error: Error | undefined
  unconfirmed: Set<string> | undefined
  state: QueryState
  dirty: boolean
  /** The position of each member in the server's snapshot, which comes in the order of the query. */
  readonly arrival: Map<string, number>
  /**
   * Whether `arrival` still gives the order of the members: true until a change could have moved one
   * (a member added after the snapshot, a changed document under a sort, or a resync). Before the client
   * core loads, a query renders in snapshot order only while this holds.
   */
  ordered: boolean
  /** Whether the snapshot being received started with no members, so its order is the query's order. */
  numbering: boolean
}

/** A document of the document cache, with the cluster time of its server state. */
export interface CachedDocument {
  readonly id: unknown
  readonly doc: Document
  readonly ct: ClusterTime
}

/** How a live query is evaluated locally. */
export interface QuerySpec {
  readonly filter?: Document
  readonly sort?: Readonly<Record<string, 1 | -1>>
  readonly limit?: number
  /** A MongoDB projection, applied by the client core to the changed members in one call. */
  readonly fields?: Readonly<Record<string, 0 | 1>>
  readonly project?: (doc: Document) => Document
}

const TOMBSTONE_MS = 60_000
const PROVISIONAL_MS = 5000

/** Applies MongoDB update operators to a copy of a document. */
export type Updater = (doc: Document, update: Document) => Document

/** Lets the browser paint first, with a timer for tabs where animation frames are paused. */
function afterPaint(task: () => void): void {
  const host = globalThis as { requestAnimationFrame?: (callback: () => void) => unknown }
  if (typeof host.requestAnimationFrame !== "function") {
    setTimeout(task, 0)
    return
  }
  let ran = false
  const run = (): void => {
    if (ran) return
    ran = true
    task()
  }
  const timer = setTimeout(run, 100)
  host.requestAnimationFrame(() => {
    if (ran) return
    clearTimeout(timer)
    setTimeout(run, 0)
  })
}

/** Whether a compiled filter matches a document; `false` when there is none or it cannot decide. */
function matches(matcher: Matcher, doc: Document): boolean {
  return matcher ? matcher.matchAll([doc])[0] === true : false
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * The normalized document cache with optimistic layers. Server state only moves forward: a message older
 * than the cached state is ignored, and ties are applied because `set` values are absolute. The view of a
 * document is its server state with every pending layer folded on top, oldest first, so a concurrent
 * change from someone else rebases under the pending ones. A live query trusts the server's membership,
 * except for documents touched by pending layers, whose membership it predicts with the matcher when the
 * filter allows it.
 *
 * Filters, sorts, projections and updates run in the Rust client core, loaded once per page after the first
 * live query has painted, or as soon as something needs it (an optimistic change, a projected query). Until
 * it has loaded, a query renders the server's members as stale in the order of its snapshot, which the
 * server sends sorted. A query that needs the core for its next state (an optimistic change, a change that may move a
 * member, a projection) keeps its previous state and renders once the core arrives.
 */
export class Store {
  private readonly docs = new Map<string, DocEntry>()
  private readonly queries = new Map<string, QueryEntry>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly layers: LayerEntry[] = []
  private version = 0
  private scheduled = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly now: () => number
  private updater: Updater | undefined
  private engine: Engine | undefined
  private loading: Promise<void> | undefined
  private coreError: Error | undefined
  private painted = false

  /** Called when a layer acknowledged without echo times out, so the affected queries can be refetched. */
  onRefetch: ((coll: string) => void) | undefined

  /**
   * `updater` folds update layers in place of the client core, which otherwise applies them once it has
   * loaded; until then update layers leave documents as the server has them.
   */
  constructor(now: () => number = Date.now, updater?: Updater) {
    this.now = now
    this.updater = updater
    this.engine = loadedEngine()
  }

  /**
   * Loads the client core unless it is loaded or loading, and settles once it is installed. A failed load
   * settles too: it fails the queries waiting for the core, and only another call of this method tries again.
   */
  loadCore(): Promise<void> {
    if (this.engine !== undefined) return Promise.resolve()
    this.loading ??= loadEngine().then(
      (engine) => this.useEngine(engine),
      (error: unknown) => {
        this.loading = undefined
        this.coreError = asError(error)
        this.engineFailed(this.coreError)
      },
    )
    return this.loading
  }

  /** Starts loading the client core for something that needs it, unless a load has already failed. */
  private needCore(): void {
    if (this.engine === undefined && this.coreError === undefined) void this.loadCore()
  }

  /** Installs an updater that folds update layers in place of the client core, and re-renders every query. */
  useUpdater(updater: Updater): void {
    this.updater = updater
    this.version += 1
    for (const query of this.queries.values()) query.dirty = true
    this.schedule()
  }

  /** Installs the client core: compiles the pending filters and renders every query. */
  private useEngine(engine: Engine): void {
    if (this.engine !== undefined) return
    this.engine = engine
    for (const layer of this.layers) this.compileLayer(layer)
    for (const query of this.queries.values()) {
      try {
        this.prepare(query, engine)
      } catch (error: unknown) {
        query.status = "error"
        query.error = asError(error)
      }
      query.dirty = true
    }
    this.version += 1
    this.schedule()
  }

  /** The client core could not load: every query waiting for it ends with that error. */
  private engineFailed(error: Error): void {
    for (const [id, query] of this.queries) {
      if (query.dirty) this.fail(id, error)
      else if (query.status === "ready") this.touch([id])
    }
  }

  /** Compiles the filter of a query and checks its sort, throwing for an invalid one. */
  private prepare(query: QueryEntry, engine: Engine): void {
    engine.sortOrder(query.sort, [])
    if (query.filter === undefined) {
      query.matcher = null
      return
    }
    try {
      query.matcher = engine.compileFilter(query.filter)
    } catch (error: unknown) {
      query.matcher = null
      if (!(error instanceof UnsupportedQueryError)) throw error
    }
  }

  private compileLayer(entry: LayerEntry): void {
    const { engine } = this
    const { layer } = entry
    if (engine === undefined || (layer.kind !== "updateMany" && layer.kind !== "deleteMany")) return
    try {
      entry.matcher = engine.compileFilter(layer.filter)
    } catch {
      entry.matcher = null
    }
  }

  private release(entry: LayerEntry): void {
    entry.matcher?.free()
    entry.matcher = null
  }

  private applyLayer(doc: Document, update: Document): Document {
    const updater = this.updater ?? this.engine?.applyUpdate
    if (updater === undefined) return doc
    try {
      return updater(doc, update)
    } catch {
      return doc
    }
  }

  /** Registers a live query. Throws for an invalid filter or sort once the client core has loaded. */
  addQuery(id: string, coll: string, query: QuerySpec = {}): void {
    const entry: QueryEntry = {
      id,
      coll,
      sort: query.sort ?? {},
      sorted: Object.keys(query.sort ?? {}).length > 0,
      filter: query.project === undefined ? (query.filter ?? {}) : undefined,
      matcher: undefined,
      limit: query.limit,
      fields: query.fields,
      project: query.project,
      projected: new Map(),
      status: "loading",
      error: undefined,
      unconfirmed: undefined,
      state: { data: [], status: "loading", error: undefined },
      dirty: true,
      arrival: new Map(),
      ordered: true,
      numbering: true,
    }
    if (this.engine !== undefined) this.prepare(entry, this.engine)
    else if (entry.fields !== undefined) this.needCore()
    this.queries.get(id)?.matcher?.free()
    this.queries.set(id, entry)
  }

  /** Removes a live query and its memberships. */
  removeQuery(id: string): void {
    this.queries.get(id)?.matcher?.free()
    this.queries.delete(id)
    for (const entry of [...this.docs.values()]) {
      entry.subs.delete(id)
      this.collect(entry)
    }
  }

  /** Subscribes to state changes of one query. */
  listen(id: string, listener: () => void): () => void {
    const set = this.listeners.get(id) ?? new Set()
    set.add(listener)
    this.listeners.set(id, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  /** The view of a document: server state with pending layers applied, or `undefined`. */
  view(coll: string, id: unknown): Document | undefined {
    const entry = this.docs.get(cacheKey(coll, id))
    return entry === undefined ? undefined : this.fold(entry).doc
  }

  /** The confirmed server state of a document, if any. */
  serverState(coll: string, id: unknown): Document | undefined {
    const entry = this.docs.get(cacheKey(coll, id))
    return entry === undefined || entry.tombstone ? undefined : entry.server
  }

  /** The cached view of a document, if any. */
  get(coll: string, id: unknown): Document | undefined {
    return this.view(coll, id)
  }

  /** Number of cached documents. */
  get size(): number {
    return this.docs.size
  }

  /** Number of pending optimistic layers. */
  get pendingLayers(): number {
    return this.layers.length
  }

  private fold(entry: DocEntry): { doc: Document | undefined; touched: boolean } {
    const source = entry.tombstone ? undefined : entry.server
    const cached = entry.view
    if (cached !== undefined && cached.source === source && cached.version === this.version)
      return cached
    let { doc, touched } = this.compute(entry, this.layers.length)
    if (
      touched &&
      doc !== undefined &&
      cached?.doc !== undefined &&
      canonicalString(cached.doc) === canonicalString(doc)
    )
      doc = cached.doc
    const view = { source, version: this.version, doc, touched }
    entry.view = view
    return view
  }

  /** Folds the first `count` layers over the server state of a document. */
  private compute(entry: DocEntry, count: number): { doc: Document | undefined; touched: boolean } {
    let doc = entry.tombstone ? undefined : entry.server
    let touched = false
    for (const { layer, key, matcher } of this.layers.slice(0, count)) {
      if (layer.coll !== entry.coll) continue
      switch (layer.kind) {
        case "insert":
          if (key === entry.key) {
            touched = true
            doc = layer.doc
          }
          break
        case "update":
          if (key === entry.key) {
            touched = true
            if (doc !== undefined) doc = this.applyLayer(doc, layer.update)
          }
          break
        case "replace":
          if (key === entry.key) {
            touched = true
            if (doc !== undefined || layer.upsert) doc = { ...layer.doc, _id: entry.id }
          }
          break
        case "delete":
          if (key === entry.key) {
            touched = true
            doc = undefined
          }
          break
        case "updateMany":
          if (doc !== undefined && matches(matcher, doc)) {
            touched = true
            doc = this.applyLayer(doc, layer.update)
          }
          break
        case "deleteMany":
          if (doc !== undefined && matches(matcher, doc)) {
            touched = true
            doc = undefined
          }
          break
      }
    }
    return { doc, touched }
  }

  /** Whether the layer at `index` changes a document, given the layers before it. */
  private touches(entry: DocEntry, index: number): boolean {
    const target = this.layers[index]
    if (target === undefined || target.layer.coll !== entry.coll) return false
    if (target.key !== undefined) return target.key === entry.key
    const { doc } = this.compute(entry, index)
    return doc !== undefined && matches(target.matcher, doc)
  }

  /** The current state of a query. */
  state(id: string): QueryState {
    const query = this.queries.get(id)
    if (query === undefined) return LOADING_STATE
    if (this.engine === undefined) {
      const loaded = loadedEngine()
      if (loaded !== undefined) this.useEngine(loaded)
    }
    const waitingForCore = query.status === "ready" && this.engine === undefined
    const error = waitingForCore ? this.coreError : query.error
    const status = waitingForCore ? (error === undefined ? "stale" : "error") : query.status
    if (query.dirty) {
      const members = this.render(query)
      if (members !== undefined) {
        query.dirty = false
        const previous = query.state.data
        const same =
          previous.length === members.length &&
          previous.every((doc, index) => doc === members[index])
        query.state = {
          data: same ? previous : members,
          status,
          error,
        }
        if (!this.painted && status !== "loading") {
          this.painted = true
          afterPaint(() => this.needCore())
        }
        return query.state
      }
      this.needCore()
    }
    if (status === "error" && query.state.error !== error)
      query.state = { data: query.state.data, status, error }
    return query.state
  }

  /**
   * The members of a query in order, or `undefined` when they need the client core and it has not loaded:
   * the query has a projection, a member may have moved since the snapshot, or a document is predicted
   * (touched by a pending layer, or confirmed by an ack the server's own message has not caught up with).
   */
  private render(query: QueryEntry): Document[] | undefined {
    const { engine } = this
    if (engine === undefined && (query.fields !== undefined || !query.ordered)) return undefined
    const now = this.now()
    const candidates: { readonly key: string; readonly doc: Document; member: boolean }[] = []
    const predicted: number[] = []
    for (const entry of this.docs.values()) {
      if (entry.coll !== query.coll) continue
      const { doc, touched } = this.fold(entry)
      if (doc === undefined) continue
      if (touched || (entry.provisional !== undefined && entry.provisional.until > now)) {
        if (engine === undefined) return undefined
        if (query.matcher) predicted.push(candidates.length)
      }
      candidates.push({ key: entry.key, doc, member: entry.subs.has(query.id) })
    }
    if (engine === undefined) {
      const arrival: number[] = []
      const members: { readonly key: string; readonly doc: Document }[] = []
      for (const candidate of candidates) {
        if (!candidate.member) continue
        const position = query.arrival.get(candidate.key)
        if (position === undefined) return undefined
        arrival.push(position)
        members.push(candidate)
      }
      const order = members.map((_, index) => index)
      order.sort((a, b) => (arrival[a] ?? 0) - (arrival[b] ?? 0))
      return this.limit(
        query,
        this.projectAll(
          query,
          order.flatMap((index) => members[index] ?? []),
          undefined,
        ),
      )
    }
    if (query.matcher && predicted.length > 0) {
      const decisions = query.matcher.matchAll(
        predicted.flatMap((index): Document[] => {
          const candidate = candidates[index]
          return candidate === undefined ? [] : [candidate.doc]
        }),
      )
      predicted.forEach((index, position) => {
        const candidate = candidates[index]
        const decision = decisions[position]
        if (candidate !== undefined && decision !== undefined) candidate.member = decision
      })
    }
    let members = this.projectAll(
      query,
      candidates.filter((candidate) => candidate.member),
      engine,
    )
    if (members.length > 1) {
      const sorted = members
      members = engine.sortOrder(query.sort, sorted).flatMap((index): Document[] => {
        const doc = sorted[index]
        return doc === undefined ? [] : [doc]
      })
    }
    return this.limit(query, members)
  }

  private limit(query: QueryEntry, members: Document[]): Document[] {
    return query.limit !== undefined && query.limit > 0 ? members.slice(0, query.limit) : members
  }

  /**
   * Projects the members of a query, reusing the previous result of every document that did not change
   * and projecting the others in one call to the client core.
   */
  private projectAll(
    query: QueryEntry,
    members: readonly { readonly key: string; readonly doc: Document }[],
    engine: Engine | undefined,
  ): Document[] {
    const { fields, project } = query
    if (fields === undefined && project === undefined) return members.map(({ doc }) => doc)
    const misses = members.filter(({ key, doc }) => query.projected.get(key)?.source !== doc)
    const sources = misses.map(({ doc }) => doc)
    const projected =
      fields === undefined || engine === undefined
        ? sources.map((doc) => (project === undefined ? doc : project(doc)))
        : engine.project(fields, sources)
    misses.forEach(({ key, doc }, index) => {
      const out = projected[index] ?? doc
      const memo = query.projected.get(key)
      const kept =
        memo !== undefined && canonicalString(memo.doc) === canonicalString(out) ? memo.doc : out
      query.projected.set(key, { source: doc, doc: kept })
    })
    return members.map(({ key, doc }) => query.projected.get(key)?.doc ?? doc)
  }

  private touchColl(coll: string): void {
    for (const query of this.queries.values()) if (query.coll === coll) query.dirty = true
    this.schedule()
  }

  private touch(ids: Iterable<string>): void {
    for (const id of ids) {
      const query = this.queries.get(id)
      if (query !== undefined) query.dirty = true
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      for (const [id, query] of this.queries) {
        if (!query.dirty) continue
        const before = query.state
        const after = this.state(id)
        if (before === after) continue
        for (const listener of this.listeners.get(id) ?? []) listener()
      }
    })
  }

  private entry(coll: string, id: unknown): DocEntry {
    const key = cacheKey(coll, id)
    let entry = this.docs.get(key)
    if (entry === undefined) {
      entry = {
        coll,
        id,
        key,
        server: undefined,
        ct: ZERO_CT,
        tombstone: false,
        subs: new Set(),
        provisional: undefined,
        view: undefined,
        removedAt: undefined,
      }
      this.docs.set(key, entry)
    }
    return entry
  }

  /** Drops an entry nothing refers to any more. Tombstones are kept for a while to stop stale messages. */
  private collect(entry: DocEntry): void {
    if (entry.subs.size > 0 || entry.provisional !== undefined) return
    if (
      this.layers.some(
        (layer) =>
          layer.layer.coll === entry.coll && (layer.key === entry.key || layer.key === undefined),
      )
    )
      return
    if (
      entry.tombstone &&
      entry.removedAt !== undefined &&
      this.now() - entry.removedAt < TOMBSTONE_MS
    )
      return
    this.docs.delete(entry.key)
  }

  /** Server state reached a document: settles provisional state and layers waiting for it. */
  private serverMoved(entry: DocEntry): void {
    if (entry.provisional !== undefined && compareCt(entry.ct, entry.provisional.ct) >= 0)
      entry.provisional = undefined
    let dropped = false
    for (const layer of [...this.layers]) {
      if (layer.awaiting === undefined || layer.layer.coll !== entry.coll) continue
      if (compareCt(entry.ct, layer.awaiting.ct) >= 0) layer.awaiting.keys.delete(entry.key)
      if (layer.awaiting.keys.size === 0) {
        this.layers.splice(this.layers.indexOf(layer), 1)
        this.release(layer)
        dropped = true
      }
    }
    if (dropped) {
      this.version += 1
      this.touchColl(entry.coll)
    }
  }

  /** Applies `added`: the document enters subscriptions, with its content when `d` is present. */
  added(
    coll: string,
    id: unknown,
    doc: Document | undefined,
    ct: ClusterTime,
    subs: readonly string[],
  ): void {
    const entry = this.entry(coll, id)
    if (doc !== undefined && compareCt(ct, entry.ct) >= 0) {
      if (
        entry.server === undefined ||
        entry.tombstone ||
        canonicalString(entry.server) !== canonicalString(doc)
      )
        entry.server = doc
      entry.tombstone = false
      entry.removedAt = undefined
      entry.ct = ct
    }
    const affected = new Set(entry.subs)
    for (const sub of subs) {
      entry.subs.add(sub)
      affected.add(sub)
      const query = this.queries.get(sub)
      if (query === undefined) continue
      if (query.numbering && !query.arrival.has(entry.key))
        query.arrival.set(entry.key, query.arrival.size)
      else query.ordered = false
      query.unconfirmed?.delete(entry.key)
    }
    this.serverMoved(entry)
    this.touchColl(coll)
    this.touch(affected)
  }

  /** Applies `changed`: a document level update, once for every subscription that holds it. */
  changed(
    coll: string,
    id: unknown,
    ct: ClusterTime,
    change: { set?: Document; unset?: readonly string[]; replace?: Document },
  ): void {
    const entry = this.docs.get(cacheKey(coll, id))
    if (entry === undefined || compareCt(ct, entry.ct) < 0) return
    const next: Document =
      change.replace === undefined
        ? { ...(entry.server ?? {}), ...(change.set ?? {}) }
        : { ...change.replace }
    if (change.replace === undefined) for (const field of change.unset ?? []) delete next[field]
    entry.ct = ct
    entry.tombstone = false
    if (entry.server === undefined || canonicalString(entry.server) !== canonicalString(next))
      entry.server = next
    for (const query of this.queries.values())
      if (query.coll === coll && query.sorted) query.ordered = false
    this.serverMoved(entry)
    this.touchColl(coll)
  }

  /** Applies `removed`: the document leaves subscriptions. */
  removed(coll: string, id: unknown, ct: ClusterTime, subs: readonly string[]): void {
    const entry = this.docs.get(cacheKey(coll, id))
    if (entry === undefined) return
    if (compareCt(ct, entry.ct) > 0) entry.ct = ct
    for (const sub of subs) entry.subs.delete(sub)
    this.serverMoved(entry)
    this.touchColl(coll)
    this.touch(subs)
    this.collect(entry)
  }

  /** Adds an optimistic layer for mutation `mid` and re-renders the affected queries at once. */
  addLayer(mid: string, layer: Layer): void {
    let key: string | undefined
    if (layer.kind !== "updateMany" && layer.kind !== "deleteMany") {
      key = cacheKey(layer.coll, layer.id)
      this.entry(layer.coll, layer.id)
    }
    const entry: LayerEntry = { mid, layer, key, matcher: undefined, awaiting: undefined }
    this.compileLayer(entry)
    this.layers.push(entry)
    this.needCore()
    this.version += 1
    this.touchColl(layer.coll)
  }

  /** Drops the layer of a mutation: it was confirmed by its echo, or rolled back. */
  dropLayer(mid: string): void {
    const removed = this.layers.filter((layer) => layer.mid === mid)
    if (removed.length === 0) return
    for (const layer of removed) {
      this.layers.splice(this.layers.indexOf(layer), 1)
      this.release(layer)
    }
    this.version += 1
    const colls = new Set(removed.map((layer) => layer.layer.coll))
    for (const coll of colls) this.touchColl(coll)
    for (const entry of [...this.docs.values()]) if (colls.has(entry.coll)) this.collect(entry)
  }

  /** Whether a mutation still has a layer. */
  hasLayer(mid: string): boolean {
    return this.layers.some((layer) => layer.mid === mid)
  }

  /**
   * Records server state from an ack without echo: `doc` (or `null` for a deleted document) at `ct`. The
   * document stays predicted for a few seconds, until the server's own message catches up.
   */
  confirm(coll: string, id: unknown, doc: Document | null, ct: ClusterTime): void {
    const entry = this.entry(coll, id)
    if (compareCt(ct, entry.ct) >= 0) {
      entry.ct = ct
      if (doc === null) {
        entry.tombstone = true
        entry.removedAt = this.now()
      } else {
        entry.tombstone = false
        if (entry.server === undefined || canonicalString(entry.server) !== canonicalString(doc))
          entry.server = doc
      }
    }
    entry.provisional = { ct, until: this.now() + PROVISIONAL_MS }
    this.arm(PROVISIONAL_MS)
    this.touchColl(coll)
  }

  /**
   * Keeps the layer of a mutation acknowledged without echo or documents until every cached document it
   * touched has server state at `ct` or later. After `timeoutMs` it is dropped and the queries of its
   * collection are refetched.
   */
  awaitServer(mid: string, ct: ClusterTime, timeoutMs: number = PROVISIONAL_MS): void {
    const owned = this.layers.filter((entry) => entry.mid === mid)
    const [layer] = owned
    if (layer === undefined) return
    const keys = new Set<string>()
    for (const own of owned) {
      const index = this.layers.indexOf(own)
      for (const entry of this.docs.values()) {
        if (compareCt(entry.ct, ct) < 0 && this.touches(entry, index)) keys.add(entry.key)
      }
    }
    if (keys.size === 0) {
      this.dropLayer(mid)
      return
    }
    for (const own of owned) own.awaiting = { ct, keys }
    setTimeout(() => {
      if (!this.hasLayer(mid)) return
      this.dropLayer(mid)
      this.onRefetch?.(layer.layer.coll)
    }, timeoutMs)
  }

  private arm(delay: number): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const now = this.now()
      let pending = false
      for (const entry of [...this.docs.values()]) {
        if (entry.provisional === undefined) continue
        if (entry.provisional.until <= now) {
          entry.provisional = undefined
          this.touchColl(entry.coll)
          this.collect(entry)
        } else pending = true
      }
      if (pending) this.arm(1000)
    }, delay)
  }

  /** Marks the query ready, dropping members a resync did not confirm. */
  ready(id: string): void {
    const query = this.queries.get(id)
    if (query === undefined) return
    const unconfirmed = query.unconfirmed
    query.unconfirmed = undefined
    if (unconfirmed !== undefined) {
      for (const key of unconfirmed) {
        const entry = this.docs.get(key)
        if (entry === undefined) continue
        entry.subs.delete(id)
        this.collect(entry)
      }
    }
    query.status = "ready"
    query.error = undefined
    query.numbering = false
    this.touch([id])
  }

  /**
   * Starts a resync of a query: every current member becomes unconfirmed; the cache stays in place, so the UI
   * changes only where data really changed.
   */
  beginResync(id: string): void {
    const query = this.queries.get(id)
    if (query === undefined) return
    const unconfirmed = new Set<string>()
    for (const [key, entry] of this.docs) if (entry.subs.has(id)) unconfirmed.add(key)
    query.unconfirmed = unconfirmed
    if (unconfirmed.size === 0) {
      query.arrival.clear()
      query.ordered = true
      query.numbering = true
    } else {
      query.ordered = false
      query.numbering = false
    }
    if (query.status === "ready") query.status = "stale"
    this.touch([id])
  }

  /** Ends a query with an error. */
  fail(id: string, error: Error): void {
    const query = this.queries.get(id)
    if (query === undefined) return
    query.status = "error"
    query.error = error
    this.touch([id])
  }

  /**
   * Shows cached documents for a query that has no server data yet. They stay `stale` and unconfirmed, so
   * the first snapshot keeps what the server still sends and drops the rest.
   */
  seed(id: string, docs: readonly CachedDocument[]): void {
    const query = this.queries.get(id)
    if (query === undefined || query.status !== "loading" || docs.length === 0) return
    const known = new Set<string>()
    for (const [key, entry] of this.docs) if (entry.subs.has(id)) known.add(key)
    for (const item of docs) this.added(query.coll, item.id, item.doc, item.ct, [id])
    query.numbering = false
    query.unconfirmed = new Set(
      docs.map((item) => cacheKey(query.coll, item.id)).filter((key) => !known.has(key)),
    )
    query.status = "stale"
    this.touch([id])
  }

  /** The server state of a query's members, for the document cache. */
  members(id: string): CachedDocument[] {
    const out: CachedDocument[] = []
    for (const entry of this.docs.values())
      if (entry.subs.has(id) && entry.server !== undefined && !entry.tombstone)
        out.push({ id: entry.id, doc: entry.server, ct: entry.ct })
    return out
  }

  /** Marks queries that went stale with the connection ready again, after a resume replayed what was missed. */
  resumed(): void {
    for (const query of this.queries.values()) {
      if (query.status === "stale" && query.unconfirmed === undefined) {
        query.status = "ready"
        query.dirty = true
      }
    }
    this.schedule()
  }

  /** Marks every query stale, for example while the connection is down. */
  markStale(): void {
    for (const query of this.queries.values()) {
      if (query.status === "ready") {
        query.status = "stale"
        query.dirty = true
      }
    }
    this.schedule()
  }

  /** Stops timers. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
