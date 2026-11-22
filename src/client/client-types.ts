import type {
  ClusterTime,
  Document,
  MutationOp,
  MutMessage,
  SubQuery,
} from "../core/protocol/index.ts"
import type { SchemaDefinitionLike } from "./register.ts"
import type { QueryState } from "./store.ts"
import type { ConsistentProjection, Filter, Projection, Sort } from "./types.ts"

/**
 * The connection status an application sees. `fallback` means connected through a transport below
 * WebSocket (SSE, long-polling or REST polling).
 */
export type ConnectionStatus =
  "connecting" | "live" | "fallback" | "reconnecting" | "offline" | "closed"

/** The minimal WebSocket surface the client needs; the global `WebSocket` satisfies it. */
export interface WebSocketLike {
  readonly readyState: number
  readonly protocol: string
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** A WebSocket constructor. */
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike

/**
 * A transport below WebSocket on the fallback ladder. It behaves like a WebSocket that speaks
 * `canopy.v1`, so the client treats every rung the same way.
 */
export interface FallbackTransport {
  /** Opens a connection; `url` is the HTTP(S) base URL of Canopy. */
  connect(url: string, fetchImpl: typeof fetch): WebSocketLike
  /** Whether data is polled, so queries stay `stale` while it is in use. */
  readonly polling?: boolean
}

/** Where a {@link Persister} keeps an entry. */
export type PersistScope = "mutations" | "docs" | "auth"

/**
 * Durable string storage for the offline queue and the document cache, such as `indexedDbPersister()`
 * from `canopy.js/persist`. Data is stored as written: the SDK does not encrypt it, so supply an
 * encrypting persister when the device is not trusted.
 */
export interface Persister {
  get(scope: PersistScope, key: string): Promise<string | undefined>
  set(scope: PersistScope, key: string, value: string): Promise<void>
  delete(scope: PersistScope, key: string): Promise<void>
  /** Every entry of a scope, ordered by key. */
  entries(scope: PersistScope): Promise<readonly (readonly [string, string])[]>
}

/**
 * A persisted mutation too old to replay safely: the server may have forgotten its idempotency record,
 * so sending it again could apply it twice. The application decides.
 */
export interface StaleMutation {
  readonly mutationId: string
  readonly collection: string
  readonly op: MutationOp
  readonly args: Document
  readonly createdAt: number
  /** Sends it again as a new mutation, with a new ID. */
  retry(): MutationHandle
  /** Forgets it. */
  discard(): void
}

/** The fallback ladder, usually `() => import("canopy.js/fallback")` so it loads only when needed. */
export type FallbackSource =
  | { readonly transports: readonly FallbackTransport[] }
  | (() => Promise<{ readonly transports: readonly FallbackTransport[] }>)

/** Supplies access tokens; the client asks again at 80 % of each token's lifetime. */
export interface TokenSource {
  readonly getToken: () => string | null | undefined | Promise<string | null | undefined>
  /** Fetches a new token, skipping any cache; used after the server closed the socket with 4001. */
  readonly refresh?: () => string | null | undefined | Promise<string | null | undefined>
  /** Called when the user changes, so the client reconnects as the new user instead of resuming. */
  readonly onChange?: (listener: () => void) => () => void
}

/** Options for {@link createClient}. */
export interface ClientOptions {
  /** The Canopy base URL, for example `https://api.example.com`. The socket connects to `/realtime/v1`. */
  readonly url: string
  readonly publishableKey: string
  /**
   * Where user tokens come from: `createAuth()` from `canopy.js/auth` for built in auth, or your own
   * identity provider. `getToken` returns the current access token, or `null` for anon.
   */
  readonly auth?: TokenSource
  /** Overrides the global `WebSocket`, for runtimes without one. */
  readonly WebSocket?: WebSocketConstructor
  /** Maximum reconnect delay in milliseconds. Defaults to 30 s. */
  readonly maxBackoffMs?: number
  /** The SDK identifier sent in `hello`. */
  readonly sdk?: string
  /**
   * How optimistic inserts without `_id` get one, per collection: an ObjectId (the default), a UUIDv7, or
   * `string` when the caller always supplies it.
   */
  readonly idTypes?: Readonly<Record<string, "objectId" | "uuid" | "string">>
  /**
   * The app's schema from `defineSchema()` in `canopy.schema.ts`. Inserts take their defaults and the `_id`
   * generator from it (overriding `idTypes` for its collections), so an optimistic ID always has the type
   * the schema declares.
   */
  readonly schema?: SchemaDefinitionLike
  /** Mutations sent before their acks arrive. Defaults to 32. */
  readonly maxInFlight?: number
  /**
   * Transports to fall back to when WebSockets fail: after two failed handshakes within 10 s the client
   * moves one rung down, and while below WebSocket it probes WebSocket again every `probeIntervalMs`.
   */
  readonly fallback?: FallbackSource
  /** Overrides the global `fetch` for the fallback transports. */
  readonly fetch?: typeof fetch
  /** Interval of WebSocket probes while on a fallback transport. Defaults to 60 s. */
  readonly probeIntervalMs?: number
  /**
   * Keeps pending mutations across reloads: they replay in order, with their original IDs, once the
   * client connects. Entries are kept per user (the token's `sub`).
   */
  readonly persist?: Persister
  /** Also persists the server state of live queries, shown `stale` at startup until the server answers. */
  readonly cacheDocuments?: boolean
  /**
   * The server's idempotency window (`CANOPY_MUTATION_TTL`), 24 h by default. Persisted mutations older
   * than this minus 4 h are not replayed but reported through `onStaleMutations`.
   */
  readonly mutationTtlMs?: number
  /**
   * Reacts to `online`, `offline`, visibility and focus events where they exist (`true`, the default),
   * to none (`false`), or to a source of its own, such as `reactNativeLifecycle()` from
   * `canopy.js/react-native`.
   */
  readonly lifecycle?: boolean | LifecycleSource
  /**
   * Shares one connection between the tabs of an origin, such as `leaderTab()` from
   * `canopy.js/leader-tab`: one tab holds the socket and the others go through it.
   */
  readonly shared?: SharedConnection
}

/** What a {@link LifecycleSource} reports: the network came back or went away, or the app is in front again. */
export interface LifecycleEvents {
  online(): void
  offline(): void
  wake(): void
}

/** Calls the events as the platform reports them; returns a function that stops listening. */
export type LifecycleSource = (events: LifecycleEvents) => () => void

/** Opens the client's realtime connection in place of a WebSocket of its own. */
export interface SharedConnection {
  connect(url: string, protocol: string, WebSocketImpl: WebSocketConstructor): WebSocketLike
}

/** The server rendered result of one live query, from `canopy.js/server`. */
export interface Snapshot<T = Document> {
  readonly c: string
  readonly q: SubQuery
  readonly docs: readonly T[]
  readonly ct: ClusterTime
}

/** Snapshots as plain JSON (canonical Extended JSON), to pass from server to browser. */
export interface DehydratedState {
  readonly canopy: 1
  readonly queries: readonly unknown[]
}

/** The client's state for `canopy.js/devtools`. Not a stable API. */
export interface ClientInternals {
  readonly sid: string | undefined
  readonly rung: number
  readonly subscriptions: ReadonlyMap<string, { readonly coll: string; readonly query: SubQuery }>
  readonly outbox: readonly { readonly message: MutMessage; readonly sent: boolean }[]
  /** Calls `listener` with every frame sent (`out`) and received (`in`). */
  tap(listener: (direction: "in" | "out", text: string) => void): () => void
  /** Rolls a pending mutation back as if the server had refused it. */
  discard(mutationId: string): void
}

/** The confirmed outcome of a mutation. */
export interface MutationResult {
  readonly ct: ClusterTime
  /** Whether the change events had already been delivered when the ack arrived. */
  readonly echo: boolean
  readonly replayed: boolean
  readonly matched: number
  readonly modified: number
  readonly insertedIds: readonly unknown[]
}

/**
 * A mutation in flight. The optimistic change is already visible; the handle settles when the server
 * acknowledges it, and rejects with a typed error (`PolicyViolationError`, `ConflictError`,
 * `ForbiddenError`, `ValidationError`, `RateLimitError` or another `CanopyError`) when it is rolled back.
 */
export interface MutationHandle<Id = unknown> extends Promise<MutationResult> {
  /** The mutation ID, which is also the idempotency key. */
  readonly mutationId: string
  /** For inserts: the `_id` of the (first) document, usable right away, typed from the collection's documents. */
  readonly id: Id
}

/** Options of single document writes. */
export interface WriteOptions<Doc = Document> {
  /** A compare and set precondition: the write is rolled back with `ConflictError` when it fails. */
  readonly where?: Filter<Doc>
}

/** Options of `replace`. */
export interface ReplaceOptions<Doc = Document> extends WriteOptions<Doc> {
  /** Inserts the document when no visible document has the `_id`. */
  readonly upsert?: boolean
}

/** A live query description. */
export interface LiveQueryOptions<Doc = Document> {
  readonly sort?: Sort<Doc>
  readonly limit?: number
  readonly fields?: Projection<Doc>
}

/**
 * The options of a read whose projection is inferred: a literal `fields` narrows the result type, and one
 * that mixes inclusion and exclusion does not compile.
 */
export interface ReadOptions<Doc = Document, F = never> {
  readonly sort?: Sort<Doc>
  readonly limit?: number
  readonly fields?: F & ConsistentProjection<F>
}

/** A live query: a value that stays current. */
export interface LiveQuery<T = Document> {
  /** The current state. Stable between changes, so it is safe for `useSyncExternalStore`. */
  getState(): QueryState<T>
  /** Calls `listener` on every change. Returns a function that stops the subscription. */
  subscribe(listener: (state: QueryState<T>) => void): () => void
}
