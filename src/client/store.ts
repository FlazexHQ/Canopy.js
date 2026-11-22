import {
  type CompiledFilter,
  type CompiledSort,
  compileFilter,
  compileSortKeys,
  UnsupportedQueryError,
} from "../core/matcher/lite.ts"
import {
  type ClusterTime,
  canonicalString,
  compareCt,
  type Document,
  ZERO_CT,
} from "../core/protocol/index.ts"

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

interface LayerEntry {
  readonly mid: string
  readonly layer: Layer
  readonly key: string | undefined
  readonly matcher: CompiledFilter | undefined
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
  readonly order: CompiledSort
  readonly matcher: CompiledFilter | undefined
  readonly limit: number | undefined
  readonly project: ((doc: Document) => Document) | undefined
  readonly projected: Map<string, { readonly source: Document; readonly doc: Document }>
  status: QueryStatus
  error: Error | undefined
  unconfirmed: Set<string> | undefined
  state: QueryState
  dirty: boolean
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
  readonly project?: (doc: Document) => Document
}

const TOMBSTONE_MS = 60_000
const PROVISIONAL_MS = 5000

/** Applies MongoDB update operators to a copy of a document. */
export type Updater = (doc: Document, update: Document) => Document

/**
 * The normalized document cache with optimistic layers. Server state only moves forward: a message older
 * than the cached state is ignored, and ties are applied because `set` values are absolute. The view of a
 * document is its server state with every pending layer folded on top, oldest first, so a concurrent
 * change from someone else rebases under the pending ones. A live query trusts the server's membership,
 * except for documents touched by pending layers, whose membership it predicts with the matcher when the
 * filter allows it.
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

  /** Called when a layer acknowledged without echo times out, so the affected queries can be refetched. */
  onRefetch: ((coll: string) => void) | undefined

  /**
   * `updater` folds update layers. The client loads it lazily, to keep the update engine out of the entry
   * chunk; until then update layers leave documents as the server has them.
   */
  constructor(now: () => number = Date.now, updater?: Updater) {
    this.now = now
    this.updater = updater
  }

  /** Installs the update engine and re-renders every query, so pending update layers show. */
  useUpdater(updater: Updater): void {
    this.updater = updater
    this.version += 1
    for (const query of this.queries.values()) query.dirty = true
    this.schedule()
  }

  private applyLayer(doc: Document, update: Document): Document {
    if (this.updater === undefined) return doc
    try {
      return this.updater(doc, update)
    } catch {
      return doc
    }
  }

  /** Registers a live query. */
  addQuery(id: string, coll: string, query: QuerySpec = {}): void {
    let matcher: CompiledFilter | undefined
    if (query.project === undefined) {
      try {
        matcher = compileFilter(query.filter ?? {})
      } catch (error: unknown) {
        if (!(error instanceof UnsupportedQueryError)) throw error
      }
    }
    this.queries.set(id, {
      id,
      coll,
      order: compileSortKeys(query.sort ?? {}),
      matcher,
      limit: query.limit,
      project: query.project,
      projected: new Map(),
      status: "loading",
      error: undefined,
      unconfirmed: undefined,
      state: { data: [], status: "loading", error: undefined },
      dirty: true,
    })
  }

  /** Removes a live query and its memberships. */
  removeQuery(id: string): void {
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
          if (doc !== undefined && matcher?.matches(doc) === true) {
            touched = true
            doc = this.applyLayer(doc, layer.update)
          }
          break
        case "deleteMany":
          if (doc !== undefined && matcher?.matches(doc) === true) {
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
    return doc !== undefined && target.matcher?.matches(doc) === true
  }

  /** The current state of a query. */
  state(id: string): QueryState {
    const query = this.queries.get(id)
    if (query === undefined) return LOADING_STATE
    if (query.dirty) {
      query.dirty = false
      const now = this.now()
      let members: Document[] = []
      for (const entry of this.docs.values()) {
        if (entry.coll !== query.coll) continue
        const { doc, touched } = this.fold(entry)
        if (doc === undefined) continue
        const predicted =
          (touched || (entry.provisional !== undefined && entry.provisional.until > now)) &&
          query.matcher !== undefined
        const member = predicted ? query.matcher?.matches(doc) === true : entry.subs.has(id)
        if (!member) continue
        members.push(this.projectFor(query, entry.key, doc))
      }
      query.order.sort(members)
      if (query.limit !== undefined && query.limit > 0) members = members.slice(0, query.limit)
      const previous = query.state.data
      const same =
        previous.length === members.length && previous.every((doc, index) => doc === members[index])
      query.state = {
        data: same ? previous : members,
        status: query.status,
        error: query.error,
      }
    }
    return query.state
  }

  private projectFor(query: QueryEntry, key: string, doc: Document): Document {
    if (query.project === undefined) return doc
    const memo = query.projected.get(key)
    if (memo !== undefined && memo.source === doc) return memo.doc
    const out = query.project(doc)
    const kept =
      memo !== undefined && canonicalString(memo.doc) === canonicalString(out) ? memo.doc : out
    query.projected.set(key, { source: doc, doc: kept })
    return kept
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
      this.queries.get(sub)?.unconfirmed?.delete(entry.key)
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
    let matcher: CompiledFilter | undefined
    if (layer.kind === "updateMany" || layer.kind === "deleteMany") {
      try {
        matcher = compileFilter(layer.filter)
      } catch {
        matcher = undefined
      }
    } else {
      key = cacheKey(layer.coll, layer.id)
      this.entry(layer.coll, layer.id)
    }
    this.layers.push({ mid, layer, key, matcher, awaiting: undefined })
    this.version += 1
    this.touchColl(layer.coll)
  }

  /** Drops the layer of a mutation: it was confirmed by its echo, or rolled back. */
  dropLayer(mid: string): void {
    const removed = this.layers.filter((layer) => layer.mid === mid)
    if (removed.length === 0) return
    for (const layer of removed) this.layers.splice(this.layers.indexOf(layer), 1)
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
