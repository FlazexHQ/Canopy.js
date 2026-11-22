"use client"

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"

import type { AuthUser } from "../client/auth.ts"
import type {
  CanopyClient,
  CollectionName,
  ConnectionStatus,
  DefaultSchema,
  DehydratedState,
  Document,
  DocumentOf,
  Filter,
  IdOf,
  InsertOf,
  LiveQuery,
  LiveQueryOptions,
  MutationHandle,
  ProjectedResult,
  Projection,
  QueryState,
  ReadOptions,
  ReplaceOptions,
  Schema,
  StaleMutation,
  TokenSource,
  UntypedSchema,
  UpdateFilter,
  WriteOptions,
} from "../client/index.ts"

const ClientContext = createContext<CanopyClient | undefined>(undefined)

/** Props of {@link CanopyProvider}. */
export interface CanopyProviderProps<DB extends Schema<DB> = DefaultSchema> {
  readonly client: CanopyClient<DB>
  readonly children?: ReactNode
}

/** Makes a client, typed or not, available to the hooks below it. */
export function CanopyProvider<DB extends Schema<DB> = DefaultSchema>({
  client,
  children,
}: CanopyProviderProps<DB>): ReactNode {
  return createElement(
    ClientContext.Provider,
    { value: client as unknown as CanopyClient },
    children,
  )
}

/**
 * Returns the client from the nearest {@link CanopyProvider}, typed by the registered schema. Code that
 * cannot rely on it passes the schema's types: `useCanopy<SchemaTypes<typeof schema>>()`.
 */
export function useCanopy<DB extends Schema<DB> = DefaultSchema>(): CanopyClient<DB> {
  const client = useContext(ClientContext)
  if (client === undefined) throw new Error("useCanopy must be used inside <CanopyProvider>")
  return client as unknown as CanopyClient<DB>
}

/** Subscribes a component to a live query. Identical queries share one subscription. */
export function useQuery<T>(query: LiveQuery<T>): QueryState<T> {
  const subscribe = useCallback((notify: () => void) => query.subscribe(() => notify()), [query])
  const read = useCallback(() => query.getState(), [query])
  return useSyncExternalStore(subscribe, read, read)
}

/** The state of one document, from {@link useDocument}. */
export interface DocumentState<T> {
  /** The document, or `undefined` while loading and when it does not exist or is not readable. */
  readonly data: T | undefined
  readonly status: QueryState<T>["status"]
  readonly error: Error | undefined
}

/**
 * Follows one document by `_id`: `useDocument("todos", id)`. Identical calls share one subscription, and
 * optimistic writes to the document show at once.
 */
export function useDocument<
  DB extends Schema<DB> = DefaultSchema,
  C extends CollectionName<DB> = CollectionName<DB>,
>(collection: C, id: IdOf<DocumentOf<DB, C>>): DocumentState<DocumentOf<DB, C>> {
  const client = useCanopy() as CanopyClient
  const state = useQuery(documentQuery(client, collection, id)) as QueryState<DocumentOf<DB, C>>
  return useMemo(() => ({ data: state.data[0], status: state.status, error: state.error }), [state])
}

const documentQueries = new WeakMap<CanopyClient, Map<string, LiveQuery<Document>>>()

/** One live query per client and document, so components following the same document share it. */
function documentQuery(client: CanopyClient, collection: string, id: unknown): LiveQuery<Document> {
  let queries = documentQueries.get(client)
  if (queries === undefined) {
    queries = new Map()
    documentQueries.set(client, queries)
  }
  const tag = (id as { readonly _bsontype?: unknown } | null)?._bsontype ?? typeof id
  const key = stableKey([collection, tag, id])
  let query = queries.get(key)
  if (query === undefined) {
    query = client.live(collection, { _id: id }, { limit: 1 })
    queries.set(key, query)
  }
  return query
}

/**
 * The signed in user of built in auth (`createAuth()` from `canopy.js/auth` passed as `auth`), or
 * `undefined` when signed out. Updates on sign in, sign out and user changes.
 */
export function useSession(): AuthUser | undefined {
  const client = useCanopy()
  const auth = client.auth as (TokenSource & { readonly user?: AuthUser }) | undefined
  const subscribe = useCallback(
    (notify: () => void) => auth?.onChange?.(() => notify()) ?? (() => {}),
    [auth],
  )
  const read = useCallback(() => auth?.user, [auth])
  return useSyncExternalStore(subscribe, read, read)
}

/** Props of {@link Hydrate}. */
export interface HydrateProps {
  /** What `dehydrate()` from `canopy.js/server` returned on the server. */
  readonly state: DehydratedState
  readonly children?: ReactNode
}

/**
 * Seeds the client with server rendered results before its children render, so live queries with the
 * same filter and options start with the server's documents (shown `stale` until the socket confirms
 * them) instead of loading. Use it in a Client Component under {@link CanopyProvider}, with the state a
 * Server Component read through `createServerClient()`.
 */
export function Hydrate({ state, children }: HydrateProps): ReactNode {
  const client = useCanopy()
  useState(() => {
    client.hydrate(state)
    return true
  })
  return children ?? null
}

/** The connection status: `connecting`, `live`, `fallback`, `reconnecting`, `offline` or `closed`. */
export function useCanopyStatus(): ConnectionStatus {
  const client = useCanopy()
  const subscribe = useCallback((notify: () => void) => client.onStatus(() => notify()), [client])
  const read = useCallback(() => client.connectionStatus, [client])
  return useSyncExternalStore(subscribe, read, read)
}

/** The latest rolled back mutation, from {@link useMutationError}. */
export interface MutationFailure {
  /** The error of the latest mutation that was rolled back, or `undefined`. */
  readonly error: Error | undefined
  readonly mutationId: string | undefined
  /** Forgets the error, for example once a toast was dismissed. */
  clear(): void
}

/**
 * The latest mutation the server rejected, so a component can explain the rollback. Mutations that are
 * not awaited never raise unhandled rejections; their failures arrive here.
 */
export function useMutationError(): MutationFailure {
  const client = useCanopy()
  const [failure, setFailure] = useState<{ error: Error; mutationId: string }>()
  useEffect(
    () => client.onMutationError((error, mutationId) => setFailure({ error, mutationId })),
    [client],
  )
  const clear = useCallback(() => setFailure(undefined), [])
  return { error: failure?.error, mutationId: failure?.mutationId, clear }
}

/**
 * Persisted mutations too old to replay safely. Each has `retry()` and `discard()`; the list updates
 * as they are handled.
 */
export function useStaleMutations(): readonly StaleMutation[] {
  const client = useCanopy()
  const subscribe = useCallback(
    (notify: () => void) => client.onStaleMutations(() => notify()),
    [client],
  )
  const read = useCallback(() => client.staleMutations, [client])
  return useSyncExternalStore(subscribe, read, read)
}

function stableKey(value: unknown): string {
  return JSON.stringify(value) ?? ""
}

/** Hooks and optimistic mutations for one collection. */
export interface CollectionHooks<Doc = Document, Insert = Doc> {
  /** A live query; a literal `fields` projection narrows the documents' type. */
  useQuery<const F extends Projection<Doc> = never>(
    filter?: Filter<Doc>,
    options?: ReadOptions<Doc, F>,
  ): QueryState<ProjectedResult<Doc, F>>
  insert(doc: Insert): MutationHandle<IdOf<Doc>>
  insertMany(docs: readonly Insert[]): MutationHandle
  update(id: IdOf<Doc>, update: UpdateFilter<Doc>, options?: WriteOptions<Doc>): MutationHandle
  replace(id: IdOf<Doc>, doc: Insert, options?: ReplaceOptions<Doc>): MutationHandle
  delete(id: IdOf<Doc>, options?: WriteOptions<Doc>): MutationHandle
  updateMany(filter: Filter<Doc>, update: UpdateFilter<Doc>): MutationHandle
  deleteMany(filter: Filter<Doc>): MutationHandle
}

/** Collection hooks keyed by collection name. */
export type ReactDb<DB extends Schema<DB> = DefaultSchema> = {
  readonly [C in CollectionName<DB>]: CollectionHooks<DocumentOf<DB, C>, InsertOf<DB, C>>
}

/**
 * Builds typed hooks per collection from a client: `db.todos.useQuery({ done: false }, { sort: { createdAt: -1 } })`.
 * The types come from the client, which a registered `canopy.schema.ts` types; an untyped client can be
 * typed here instead, with `createReactDb<SchemaTypes<typeof schema>>(client)`. The filter and options are
 * compared by value, so inline objects do not resubscribe on every render.
 */
export function createReactDb<DB extends Schema<DB> = DefaultSchema>(
  client: CanopyClient<DB> | CanopyClient<UntypedSchema>,
): ReactDb<DB> {
  const untyped = client as unknown as CanopyClient<UntypedSchema>
  const cache = new Map<string, CollectionHooks>()
  const live = untyped.live.bind(untyped) as (
    collection: string,
    filter: Filter<Document>,
    options: LiveQueryOptions,
  ) => LiveQuery<Document>
  const queries = new Map<string, LiveQuery<Document>>()
  return new Proxy({} as ReactDb<DB>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined
      let hooks = cache.get(name)
      if (hooks === undefined) {
        hooks = {
          useQuery(filter = {}, options = {}) {
            const key = stableKey([name, filter, options])
            let query = queries.get(key)
            if (query === undefined) {
              query = live(name, filter, options as LiveQueryOptions)
              queries.set(key, query)
            }
            return useQuery(query) as QueryState<never>
          },
          insert: (doc) => untyped.insert(name, doc),
          insertMany: (docs) => untyped.insertMany(name, docs),
          update: (id, update, options) => untyped.update(name, id, update, options),
          replace: (id, doc, options) => untyped.replace(name, id, doc, options),
          delete: (id, options) => untyped.delete(name, id, options),
          updateMany: (filter, update) => untyped.updateMany(name, filter, update),
          deleteMany: (filter) => untyped.deleteMany(name, filter),
        }
        cache.set(name, hooks)
      }
      return hooks
    },
  })
}
