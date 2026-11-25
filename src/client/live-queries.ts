import {
  type ClientMessage,
  type ClusterTime,
  type Document,
  decode,
  encode,
  encodeMessage,
  type SubQuery,
} from "../core/protocol/index.ts"
import type { DehydratedState, LiveQuery, Persister, Snapshot } from "./client-types.ts"
import type { Outbox } from "./outbox.ts"
import { type CachedDocument, LOADING_STATE, type QueryState, type Store } from "./store.ts"

/** A server subscription shared by every live query with the same key. */
export interface Subscription {
  readonly id: string
  readonly coll: string
  readonly query: SubQuery
  refs: number
}

/** The options of a live query, with the document types erased. */
export interface LiveQuerySpec {
  readonly sort?: Readonly<Record<string, 1 | -1>> | undefined
  readonly limit?: number | undefined
  readonly fields?: Readonly<Record<string, 0 | 1>> | undefined
}

/** Options of {@link LiveQueries}. */
export interface LiveQueriesOptions {
  readonly store: Store
  readonly outbox: Outbox
  readonly persist: Persister | undefined
  readonly cacheDocuments: boolean
  /** Sends a frame when the connection is open and welcomed; dropped otherwise. */
  readonly send: (message: ClientMessage) => void
}

/** The key identical live queries share. */
function queryKey(collection: string, query: SubQuery): string {
  return `${collection}\u0000${encodeMessage({ t: "sub", id: "k", c: collection, q: query })}`
}

/**
 * The client's live queries: identical queries share one server subscription, which is opened with the
 * first listener and closed with the last. Queries can start from server rendered results and, with
 * `cacheDocuments`, from the persisted document cache.
 */
export class LiveQueries {
  /** The open server subscriptions by id. */
  readonly subscriptions: Map<string, Subscription> = new Map()
  private readonly options: LiveQueriesOptions
  private readonly byQuery = new Map<string, Subscription>()
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly hydrated = new Map<
    string,
    { readonly state: QueryState; readonly ct: ClusterTime }
  >()
  private nextId = 1

  constructor(options: LiveQueriesOptions) {
    this.options = options
  }

  /** A live query over `collection`; it subscribes on the server only while it has listeners. */
  live<Out>(collection: string, filter: Document, spec: LiveQuerySpec): LiveQuery<Out> {
    const { store } = this.options
    const { sort, fields } = spec
    const query: SubQuery = {
      filter,
      ...(sort === undefined ? {} : { sort: sort }),
      ...(spec.limit === undefined ? {} : { limit: spec.limit }),
      ...(fields === undefined ? {} : { fields: fields }),
    }
    const key = queryKey(collection, query)
    return {
      getState: () => {
        const sub = this.byQuery.get(key)
        if (sub === undefined)
          return (this.hydrated.get(key)?.state ?? LOADING_STATE) as QueryState<Out>
        return store.state(sub.id) as QueryState<Out>
      },
      subscribe: (listener) => {
        let sub = this.byQuery.get(key)
        if (sub === undefined) {
          sub = { id: `s${this.nextId}`, coll: collection, query, refs: 0 }
          this.nextId += 1
          this.byQuery.set(key, sub)
          this.subscriptions.set(sub.id, sub)
          store.addQuery(sub.id, collection, {
            filter,
            ...(sort === undefined ? {} : { sort: sort }),
            ...(spec.limit === undefined ? {} : { limit: spec.limit }),
            ...(fields === undefined ? {} : { fields }),
          })
          this.options.send({ t: "sub", id: sub.id, c: collection, q: query })
          const seed = this.hydrated.get(key)
          if (seed !== undefined) {
            this.hydrated.delete(key)
            store.seed(
              sub.id,
              seed.state.data.map((doc) => ({ id: doc["_id"], doc, ct: seed.ct })),
            )
          }
          if (this.options.cacheDocuments) this.cache(sub, key)
        }
        sub.refs += 1
        const current = sub
        const stop = store.listen(current.id, () =>
          listener(store.state(current.id) as QueryState<Out>),
        )
        listener(store.state(current.id) as QueryState<Out>)
        return () => {
          stop()
          current.refs -= 1
          if (current.refs > 0) return
          const timer = this.saveTimers.get(current.id)
          if (timer !== undefined) clearTimeout(timer)
          this.saveTimers.delete(current.id)
          this.byQuery.delete(key)
          this.subscriptions.delete(current.id)
          store.removeQuery(current.id)
          this.options.send({ t: "unsub", id: current.id })
        }
      },
    }
  }

  /** Seeds a new query from the document cache and keeps the cache current once it is ready. */
  private cache(sub: Subscription, key: string): void {
    const { store, outbox, persist } = this.options
    if (persist === undefined) return
    const cacheKey = (): string => `${outbox.scope}\u0000${key}`
    void outbox.ready
      .then(() => persist.get("docs", cacheKey()))
      .then((text) => {
        if (text !== undefined && this.subscriptions.get(sub.id) === sub)
          store.seed(sub.id, decode(JSON.parse(text)) as CachedDocument[])
      })
      .catch(() => {})
    store.listen(sub.id, () => {
      if (store.state(sub.id).status !== "ready" || this.saveTimers.has(sub.id)) return
      this.saveTimers.set(
        sub.id,
        setTimeout(() => {
          this.saveTimers.delete(sub.id)
          if (this.subscriptions.get(sub.id) !== sub) return
          const docs = JSON.stringify(encode(store.members(sub.id)))
          void persist.set("docs", cacheKey(), docs).catch(() => {})
        }, 500),
      )
    })
  }

  /** Seeds live queries with server rendered results; see `CanopyClient.hydrate`. */
  hydrate(state: DehydratedState): void {
    for (const encoded of state.queries) {
      const snapshot = decode(encoded) as Snapshot
      this.hydrated.set(queryKey(snapshot.c, snapshot.q), {
        state: { data: snapshot.docs, status: "stale", error: undefined },
        ct: snapshot.ct,
      })
    }
  }

  /** Subscribes again to the subscriptions named (every one by default), starting a resync of each. */
  resubscribe(ids: Iterable<string> = this.subscriptions.keys()): void {
    for (const id of [...ids]) {
      const sub = this.subscriptions.get(id)
      if (sub === undefined) continue
      this.options.store.beginResync(id)
      this.options.send({ t: "sub", id, c: sub.coll, q: sub.query })
    }
  }

  /** Subscribes again to every subscription on `coll`. */
  refetch(coll: string): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.coll !== coll) continue
      this.options.store.beginResync(sub.id)
      this.options.send({ t: "sub", id: sub.id, c: sub.coll, q: sub.query })
    }
  }

  /** Cancels pending cache writes. */
  stop(): void {
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
  }
}
