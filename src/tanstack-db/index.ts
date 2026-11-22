import type { CollectionConfig, SyncConfig } from "@tanstack/db"

import type {
  CanopyClient,
  CollectionName,
  DefaultSchema,
  Document,
  DocumentOf,
  Filter,
  LiveQueryOptions,
  MutationHandle,
  Schema,
  UntypedSchema,
} from "../client/index.ts"

/** Options of {@link canopyCollectionOptions}. */
export interface CanopyCollectionOptions<
  DB extends Schema<DB> = DefaultSchema,
  C extends CollectionName<DB> = CollectionName<DB>,
> {
  readonly client: CanopyClient<DB>
  /** The Canopy collection. */
  readonly collection: C
  /** Which documents the TanStack DB collection holds; DLS still decides what the user sees. */
  readonly filter?: Filter<DocumentOf<DB, C>>
  readonly sort?: LiveQueryOptions<DocumentOf<DB, C>>["sort"]
  readonly limit?: number
  /** The TanStack DB collection id. Defaults to `canopy:<collection>`. */
  readonly id?: string
  /** The TanStack DB key of a document. Defaults to {@link documentKey} of `_id`. */
  readonly getKey?: (doc: DocumentOf<DB, C>) => string
}

/**
 * A string key for an `_id`: ObjectIds give their hex, other objects their JSON, and strings and
 * numbers their text.
 */
export function documentKey(id: unknown): string {
  if (typeof id === "object" && id !== null) return JSON.stringify(id)
  return String(id)
}

type Fields = Record<string, unknown>

/**
 * Exposes a Canopy collection as a TanStack DB collection: `createCollection(canopyCollectionOptions({
 * client, collection: "todos" }))`. Documents sync from a Canopy live query (a realtime subscription, with DLS
 * applied by the server), so changes made anywhere show up; inserts, updates and deletes made through
 * TanStack DB run as Canopy mutations, which keep their idempotent mutation IDs and roll the TanStack DB
 * transaction back with Canopy's typed error when the server refuses them.
 */
export function canopyCollectionOptions<
  DB extends Schema<DB> = DefaultSchema,
  C extends CollectionName<DB> = CollectionName<DB>,
>(options: CanopyCollectionOptions<DB, C>): CollectionConfig<DocumentOf<DB, C> & object, string> {
  type Doc = DocumentOf<DB, C> & object
  const client = options.client as unknown as CanopyClient<UntypedSchema>
  const name = options.collection as string
  const keyOf = (doc: Doc): string => options.getKey?.(doc) ?? documentKey((doc as Fields)["_id"])

  const sync: SyncConfig<Doc, string>["sync"] = ({ begin, write, commit, markReady, fail }) => {
    const live = client.live(name, (options.filter ?? {}) as Filter<Document>, {
      ...(options.sort === undefined
        ? {}
        : { sort: options.sort as NonNullable<LiveQueryOptions["sort"]> }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })
    let known = new Map<string, Doc>()
    let ready = false
    let last: readonly Document[] | undefined
    const stop = live.subscribe((state) => {
      if (state.status === "error") {
        if (!ready) fail(state.error)
        return
      }
      if (state.status === "loading" || state.data === last) return
      last = state.data
      const next = new Map<string, Doc>()
      for (const doc of state.data) next.set(keyOf(doc as Doc), doc as Doc)
      begin()
      for (const key of known.keys()) if (!next.has(key)) write({ type: "delete", key })
      for (const [key, doc] of next) {
        const before = known.get(key)
        if (before === undefined) write({ type: "insert", value: doc })
        else if (before !== doc) write({ type: "update", value: doc, previousValue: before })
      }
      commit()
      known = next
      if (!ready && state.status === "ready") {
        ready = true
        markReady()
      }
    })
    return () => stop()
  }

  const settle = async (handles: readonly MutationHandle[]): Promise<void> => {
    await Promise.all(handles)
  }

  return {
    id: options.id ?? `canopy:${name}`,
    getKey: keyOf,
    sync: { sync, rowUpdateMode: "full" },
    onInsert: ({ transaction }) =>
      settle(
        transaction.mutations.map((mutation) => client.insert(name, mutation.modified as Document)),
      ),
    onUpdate: ({ transaction }) =>
      settle(
        transaction.mutations.map((mutation) => {
          const set: Fields = {}
          const unset: Record<string, ""> = {}
          for (const [field, value] of Object.entries(mutation.changes as Fields)) {
            if (field === "_id") continue
            if (value === undefined) unset[field] = ""
            else set[field] = value
          }
          return client.update(name, (mutation.original as Fields)["_id"], {
            ...(Object.keys(set).length === 0 ? {} : { $set: set }),
            ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }),
          })
        }),
      ),
    onDelete: ({ transaction }) =>
      settle(
        transaction.mutations.map((mutation) =>
          client.delete(name, (mutation.original as Fields)["_id"]),
        ),
      ),
  }
}
