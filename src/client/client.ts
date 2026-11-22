import {
  type ClientMessage,
  closeReaction,
  type Document,
  decode,
  decodeServerMessage,
  ErrorCode,
  encodeMessage,
  errorFromWire,
  ObjectId,
  PROTOCOL_VERSION,
  type SequencedMessage,
  SUBPROTOCOL,
  unbatch,
  uuidv7,
  type WelcomeCapabilities,
} from "../core/protocol/index.ts"
import type {
  ClientInternals,
  ClientOptions,
  ConnectionStatus,
  DehydratedState,
  LiveQuery,
  MutationHandle,
  ReadOptions,
  ReplaceOptions,
  StaleMutation,
  TokenSource,
  WebSocketConstructor,
  WebSocketLike,
  WriteOptions,
} from "./client-types.ts"
import { LiveQueries } from "./live-queries.ts"
import { Outbox } from "./outbox.ts"
import { type AnyClient, type Collection, CollectionBuilder } from "./query-builder.ts"
import {
  type DefaultSchema,
  definitionOf,
  type SchemaConstraint,
  type SchemaOption,
  type SchemaTypes,
} from "./register.ts"
import { createStorage, type StorageApi } from "./storage.ts"
import { type Layer, Store } from "./store.ts"
import { TokenRefresher } from "./token-refresh.ts"
import { TransportLadder } from "./transport-ladder.ts"
import type {
  CollectionName,
  DocumentOf,
  Filter,
  IdOf,
  InsertOf,
  ProjectedResult,
  Projection,
  Schema,
  UpdateFilter,
} from "./types.ts"

export function asDocument(value: object): Document {
  return value as Document
}

function backoff(attempt: number, maxMs: number): number {
  return Math.random() * Math.min(maxMs, 250 * 2 ** attempt)
}

/**
 * The Canopy client: a document cache with live queries over `canopy.v1`, automatic reconnection
 * with full jitter backoff, resume by sequence number and resync reconciliation.
 */
export class CanopyClient<
  in out DB extends Schema<DB> = DefaultSchema,
  out Auth extends TokenSource | undefined = TokenSource | undefined,
> {
  readonly store: Store = new Store()
  /**
   * Settles once the update engine is loaded. It is a separate chunk, fetched right after the client is
   * created; update layers made before it arrives show once it has.
   */
  readonly updateEngine: Promise<void>
  /** File storage at `/storage/v1`, as the signed in user: `client.storage.from("avatars")`. */
  readonly storage: StorageApi
  private readonly options: ClientOptions
  private readonly socketUrl: string
  private readonly httpUrl: string
  private readonly outbox: Outbox
  private readonly queries: LiveQueries
  private readonly refresher: TokenRefresher
  private readonly ladder: TransportLadder
  private socket: WebSocketLike | undefined
  private status: ConnectionStatus = "connecting"
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>()
  private sid: string | undefined
  private lastSeq = 0
  private welcomed = false
  private advertisedCapabilities: WelcomeCapabilities | undefined
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private lastInbound = 0
  private heartbeatMs = 25_000
  private closed = false
  private lastAttemptAt = 0
  private stopLifecycle: (() => void) | undefined
  private stopAuth: (() => void) | undefined
  private readonly taps = new Set<(direction: "in" | "out", text: string) => void>()

  constructor(options: ClientOptions) {
    this.options = options
    this.httpUrl = options.url.replace(/\/$/, "")
    const base = new URL(options.url)
    base.protocol =
      base.protocol === "https:" ? "wss:" : base.protocol === "http:" ? "ws:" : base.protocol
    base.pathname = `${base.pathname.replace(/\/$/, "")}/realtime/v1`
    this.socketUrl = base.toString()
    this.storage = createStorage({
      url: options.url,
      publishableKey: options.publishableKey,
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    this.store.onRefetch = (coll) => this.queries.refetch(coll)
    this.updateEngine = import("../core/matcher/update-lite.ts").then(
      (engine) => this.store.useUpdater((doc, update) => engine.applyUpdate(doc, update)),
      () => {},
    )
    this.outbox = new Outbox({
      store: this.store,
      client: options,
      closed: () => this.closed,
      mutationsSupported: () => this.advertisedCapabilities?.mutations,
      channel: () => {
        const socket = this.socket
        if (socket === undefined || !this.welcomed || socket.readyState !== 1) return undefined
        return (text) => this.write(socket, text)
      },
    })
    this.queries = new LiveQueries({
      store: this.store,
      outbox: this.outbox,
      persist: options.persist,
      cacheDocuments: options.cacheDocuments === true,
      send: (message) => this.send(message),
    })
    this.refresher = new TokenRefresher(options.auth, (token) => this.send({ t: "auth", token }))
    this.ladder = new TransportLadder({
      fallback: options.fallback,
      webSocket: () => this.webSocket(),
      socketUrl: this.socketUrl,
      probeIntervalMs: options.probeIntervalMs ?? 60_000,
      closed: () => this.closed,
      onReachable: () => this.ascend(),
    })
    this.watchLifecycle()
    this.stopAuth = options.auth?.onChange?.(() => this.reidentify())
    this.connect()
  }

  /**
   * The token source passed as `auth`, with its own type: the `createAuth()` handle keeps its sign in
   * methods, and another provider's token source is returned as given.
   */
  get auth(): Auth {
    return this.options.auth as Auth
  }

  /** Starts a fresh session as the current user: the server refuses `auth` frames that switch subject. */
  private reidentify(): void {
    this.outbox.reidentify()
    this.sid = undefined
    const socket = this.socket
    if (socket !== undefined) {
      this.detach()
      socket.close(1000)
    }
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.attempt = 0
    this.connect()
  }

  /** The persisted mutations that were too old to replay and are not retried or discarded yet. */
  get staleMutations(): readonly StaleMutation[] {
    return this.outbox.staleMutations
  }

  /**
   * Calls `listener` with the persisted mutations that are too old to replay (at once when some are
   * already known), and again whenever one is retried or discarded.
   */
  onStaleMutations(listener: (mutations: readonly StaleMutation[]) => void): () => void {
    return this.outbox.onStaleMutations(listener)
  }

  private watchLifecycle(): void {
    const target = globalThis as {
      addEventListener?: (type: string, listener: () => void) => void
      removeEventListener?: (type: string, listener: () => void) => void
      document?: { readonly visibilityState?: string }
    }
    const add = target.addEventListener
    const remove = target.removeEventListener
    const source = this.options.lifecycle
    const online = (): void => this.reconnectNow()
    const offline = (): void => {
      const socket = this.socket
      if (socket !== undefined) {
        this.detach()
        socket.close(4000, "offline")
      }
      if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      if (!this.closed) this.setStatus("offline")
    }
    const wake = (): void => {
      if (target.document?.visibilityState === "hidden") return
      if (this.status === "reconnecting" && Date.now() - this.lastAttemptAt > 5000)
        this.reconnectNow()
    }
    if (typeof source === "function") {
      this.stopLifecycle = source({ online, offline, wake })
      return
    }
    if (source === false || add === undefined || remove === undefined) return
    const events: [string, () => void][] = [
      ["online", online],
      ["offline", offline],
      ["visibilitychange", wake],
      ["focus", wake],
    ]
    for (const [type, listener] of events) add.call(globalThis, type, listener)
    this.stopLifecycle = () => {
      for (const [type, listener] of events) remove.call(globalThis, type, listener)
    }
  }

  private static offline(): boolean {
    return (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false
  }

  /** Calls `listener` whenever a mutation is rolled back. */
  onMutationError(listener: (error: Error, mutationId: string) => void): () => void {
    return this.outbox.onMutationError(listener)
  }

  /** Features advertised in the latest welcome, or undefined when the endpoint has not advertised them. */
  get capabilities(): WelcomeCapabilities | undefined {
    return this.advertisedCapabilities
  }

  /** The number of mutations not yet acknowledged. */
  get pendingMutations(): number {
    return this.outbox.queue.length
  }

  private newId(collection: string): unknown {
    const type = this.options.idTypes?.[collection] ?? "objectId"
    if (type === "uuid") return decode({ $uuid: uuidv7() })
    if (type === "string")
      throw new TypeError(`Documents of ${collection} need an _id; its id type is string`)
    return new ObjectId()
  }

  /**
   * The document an insert stores. With a schema, the collection's definition fills in defaults and
   * generates the `_id` its builder declares; otherwise `idTypes` picks the generator.
   */
  private prepare(collection: string, doc: object): Document {
    const definition = definitionOf(this.options.schema, collection)
    if (definition !== undefined) return asDocument(definition.prepare(doc))
    const given = asDocument(doc)["_id"]
    return { ...asDocument(doc), _id: given === undefined ? this.newId(collection) : given }
  }

  /**
   * Inserts a document. The optimistic copy, with its defaults and a client generated `_id`, is visible at
   * once.
   */
  insert<C extends CollectionName<DB>>(
    collection: C,
    doc: InsertOf<DB, C>,
  ): MutationHandle<IdOf<DocumentOf<DB, C>>> {
    const full = this.prepare(collection, doc)
    const id = full["_id"]
    return this.outbox.mutate(
      collection,
      "insert",
      { doc: full },
      [{ kind: "insert", coll: collection, id, doc: full }],
      [id],
    ) as MutationHandle<IdOf<DocumentOf<DB, C>>>
  }

  /** Inserts several documents in one mutation. */
  insertMany<C extends CollectionName<DB>>(
    collection: C,
    docs: readonly InsertOf<DB, C>[],
  ): MutationHandle {
    const full = docs.map((doc) => this.prepare(collection, doc))
    return this.outbox.mutate(
      collection,
      "insertMany",
      { docs: full },
      full.map((doc): Layer => ({ kind: "insert", coll: collection, id: doc["_id"], doc })),
      full.map((doc) => doc["_id"]),
    )
  }

  /** Updates one document with update operators. */
  update<C extends CollectionName<DB>>(
    collection: C,
    id: IdOf<DocumentOf<DB, C>>,
    changes: UpdateFilter<DocumentOf<DB, C>>,
    options: WriteOptions<DocumentOf<DB, C>> = {},
  ): MutationHandle {
    const update = asDocument(changes)
    return this.outbox.mutate(
      collection,
      "update",
      { id, update, ...(options.where === undefined ? {} : { where: asDocument(options.where) }) },
      [{ kind: "update", coll: collection, id, update }],
      [id],
    )
  }

  /** Replaces one document. With `upsert`, a missing document is inserted. */
  replace<C extends CollectionName<DB>>(
    collection: C,
    id: IdOf<DocumentOf<DB, C>>,
    replacement: InsertOf<DB, C>,
    options: ReplaceOptions<DocumentOf<DB, C>> = {},
  ): MutationHandle {
    const definition = definitionOf(this.options.schema, collection)
    const doc =
      definition === undefined
        ? asDocument(replacement)
        : withoutId(definition.prepare({ ...replacement, _id: id }), replacement)
    return this.outbox.mutate(
      collection,
      "replace",
      {
        id,
        doc,
        ...(options.where === undefined ? {} : { where: asDocument(options.where) }),
        ...(options.upsert === undefined ? {} : { upsert: options.upsert }),
      },
      [{ kind: "replace", coll: collection, id, doc, upsert: options.upsert === true }],
      [id],
    )
  }

  /** Deletes one document. */
  delete<C extends CollectionName<DB>>(
    collection: C,
    id: IdOf<DocumentOf<DB, C>>,
    options: WriteOptions<DocumentOf<DB, C>> = {},
  ): MutationHandle {
    return this.outbox.mutate(
      collection,
      "delete",
      { id, ...(options.where === undefined ? {} : { where: asDocument(options.where) }) },
      [{ kind: "delete", coll: collection, id }],
      [id],
    )
  }

  /** Updates every visible document matching `filter`. The optimistic change covers cached documents. */
  updateMany<C extends CollectionName<DB>>(
    collection: C,
    where: Filter<DocumentOf<DB, C>>,
    changes: UpdateFilter<DocumentOf<DB, C>>,
  ): MutationHandle {
    const filter = asDocument(where)
    const update = asDocument(changes)
    return this.outbox.mutate(
      collection,
      "updateMany",
      { filter, update, bulk: true },
      [{ kind: "updateMany", coll: collection, filter, update }],
      [],
    )
  }

  /** Deletes every visible document matching `filter`. */
  deleteMany<C extends CollectionName<DB>>(
    collection: C,
    where: Filter<DocumentOf<DB, C>>,
  ): MutationHandle {
    const filter = asDocument(where)
    return this.outbox.mutate(
      collection,
      "deleteMany",
      { filter, bulk: true },
      [{ kind: "deleteMany", coll: collection, filter }],
      [],
    )
  }

  /** The current connection status. */
  get connectionStatus(): ConnectionStatus {
    return this.status
  }

  /** Calls `listener` whenever the connection status changes. */
  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }

  /**
   * A collection: its writes (`insert`, `update`, `updateMany` and the rest), and live reads that start with
   * `find`, `sort`, `fields` or `limit`. A read query has no write methods, so the scope of a write is
   * always its own filter or ID.
   */
  from<C extends CollectionName<DB>>(
    collection: C,
  ): Collection<DocumentOf<DB, C>, InsertOf<DB, C>> {
    return new CollectionBuilder(this as unknown as AnyClient, collection) as unknown as Collection<
      DocumentOf<DB, C>,
      InsertOf<DB, C>
    >
  }

  /**
   * Returns a live query; identical queries share one server subscription. A literal `fields` projection
   * narrows the documents' type, as `from(c).fields(...)` does.
   */
  live<C extends CollectionName<DB>, const F extends Projection<DocumentOf<DB, C>> = never>(
    collection: C,
    where: Filter<DocumentOf<DB, C>>,
    options: ReadOptions<DocumentOf<DB, C>, F> = {},
  ): LiveQuery<ProjectedResult<DocumentOf<DB, C>, F>> {
    return this.queries.live(collection, asDocument(where), {
      sort: options.sort as Readonly<Record<string, 1 | -1>> | undefined,
      limit: options.limit,
      fields: options.fields as Readonly<Record<string, 0 | 1>> | undefined,
    })
  }

  private send(message: ClientMessage): void {
    if (this.socket !== undefined && this.welcomed && this.socket.readyState === 1)
      this.write(this.socket, encodeMessage(message))
  }

  private write(socket: WebSocketLike, text: string): void {
    for (const tap of this.taps) tap("out", text)
    socket.send(text)
  }

  /**
   * Seeds live queries with server rendered results (`dehydrate()` from `canopy.js/server`). A
   * hydrated query shows its documents at once, as `stale`, and becomes `ready` when the server confirms
   * it; events older than the snapshot are ignored.
   */
  hydrate(state: DehydratedState): void {
    this.queries.hydrate(state)
  }

  /** The client's internals, for `canopy.js/devtools`. Not a stable API. */
  devtools(): ClientInternals {
    return {
      sid: this.sid,
      rung: this.ladder.rung,
      subscriptions: this.queries.subscriptions,
      outbox: this.outbox.queue,
      tap: (listener) => {
        this.taps.add(listener)
        return () => this.taps.delete(listener)
      },
      discard: (mutationId) =>
        this.outbox.acknowledge({
          t: "ack",
          m: mutationId,
          ok: false,
          seq: 0,
          err: { code: ErrorCode.Conflict, msg: "Discarded in devtools" },
        }),
    }
  }

  private webSocket(): WebSocketConstructor | undefined {
    return this.options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
  }

  private connect(): void {
    if (this.closed) return
    const WebSocketImpl = this.webSocket()
    if (this.ladder.rung === 0 && WebSocketImpl === undefined) {
      if (this.options.fallback === undefined)
        throw new TypeError("No WebSocket implementation is available; pass one in options")
      void this.descend()
      return
    }
    if (CanopyClient.offline()) {
      this.setStatus("offline")
      return
    }
    this.lastAttemptAt = Date.now()
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting")
    const transport = this.ladder.transport
    let socket: WebSocketLike
    if (transport !== undefined)
      socket = transport.connect(
        this.httpUrl,
        this.options.fetch ?? globalThis.fetch.bind(globalThis),
      )
    else if (WebSocketImpl === undefined) return
    else
      socket =
        this.options.shared?.connect(this.socketUrl, SUBPROTOCOL, WebSocketImpl) ??
        new WebSocketImpl(this.socketUrl, SUBPROTOCOL)
    this.socket = socket
    this.welcomed = false
    socket.onopen = () => {
      this.hello(socket).catch(() => socket.close(4500, "token source failed"))
    }
    socket.onmessage = (event) => {
      if (typeof event.data === "string") this.receive(event.data)
    }
    socket.onclose = (event) => this.onClose(socket, event.code)
    socket.onerror = () => {}
  }

  private async hello(socket: WebSocketLike): Promise<void> {
    const token = (await this.refresher.token()) ?? undefined
    if (this.socket !== socket || socket.readyState !== 1) return
    this.outbox.adoptToken(token)
    const message: ClientMessage = {
      t: "hello",
      v: PROTOCOL_VERSION,
      key: this.options.publishableKey,
      ...(token === undefined ? {} : { token }),
      ...(this.sid === undefined ? {} : { resume: { sid: this.sid, seq: this.lastSeq } }),
      caps: ["batch", "diff"],
      sdk: this.options.sdk ?? "canopy-js/0.1.0",
    }
    this.write(socket, encodeMessage(message))
    this.refresher.schedule(token)
  }

  /** Feeds one server frame to the client. Public for transports and conformance tests. */
  receive(text: string): void {
    for (const tap of this.taps) tap("in", text)
    this.lastInbound = Date.now()
    const message = decodeServerMessage(text)
    if (message === undefined) return
    for (const part of unbatch(message)) {
      if (part.t === "pong") continue
      this.handle(part)
    }
  }

  private handle(message: SequencedMessage): void {
    if (message.t === "welcome") {
      this.welcomed = true
      this.advertisedCapabilities =
        message.capabilities === undefined ? undefined : Object.freeze(message.capabilities)
      this.attempt = 0
      this.heartbeatMs = message.hb
      this.startHeartbeat()
      const resumed = message.resumed && message.sid === this.sid
      this.sid = message.sid
      if (!resumed) {
        this.lastSeq = 0
        this.queries.resubscribe()
      } else this.store.resumed()
      this.outbox.resend()
      this.setStatus(this.ladder.rung === 0 ? "live" : "fallback")
      this.outbox.pump()
      return
    }
    if (message.seq <= this.lastSeq) return
    this.lastSeq = message.seq
    switch (message.t) {
      case "added":
        this.store.added(message.c, message.id, message.d, message.ct, message.s)
        return
      case "changed":
        this.store.changed(message.c, message.id, message.ct, {
          ...(message.set === undefined ? {} : { set: message.set }),
          ...(message.unset === undefined ? {} : { unset: message.unset }),
          ...(message.replace === true && message.d !== undefined ? { replace: message.d } : {}),
        })
        return
      case "removed":
        this.store.removed(message.c, message.id, message.ct, message.s)
        return
      case "ready":
        this.store.ready(message.s)
        if (this.ladder.transport?.polling === true) this.store.markStale()
        return
      case "ack":
        this.outbox.acknowledge(message)
        return
      case "nosub": {
        if (message.err !== undefined) this.store.fail(message.s, errorFromWire(message.err))
        return
      }
      case "resync":
        this.queries.resubscribe(message.s)
        return
      case "reconnect": {
        const socket = this.socket
        this.detach()
        socket?.close(1000, "server asked to reconnect")
        this.scheduleReconnect(message.retryAfterMs)
        return
      }
      default:
        return
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.lastInbound = Date.now()
    const heartbeat = this.heartbeatMs
    const interval = heartbeat >= 100 && heartbeat <= 300_000 ? heartbeat : 25_000
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastInbound > 2 * interval) {
        this.socket?.close(4000, "heartbeat timeout")
        return
      }
      this.send({ t: "ping", ts: Date.now() })
    }, interval)
  }

  private detach(): void {
    this.socket = undefined
    this.welcomed = false
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (!this.closed) this.store.markStale()
  }

  /** Moves one rung down the transport ladder, loading the fallback transports on first use. */
  private async descend(): Promise<void> {
    if (this.options.fallback === undefined) return
    if (await this.ladder.descend()) this.attempt = 0
    this.scheduleReconnect(0)
  }

  /** Moves back to WebSocket after a successful probe; the session resumes there. */
  private ascend(): void {
    if (this.closed || !this.ladder.ascend()) return
    const socket = this.socket
    this.detach()
    socket?.close(1000, "moving to WebSocket")
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.attempt = 0
    this.connect()
  }

  private onClose(socket: WebSocketLike, code: number): void {
    if (this.socket !== socket) return
    const welcomed = this.welcomed
    this.detach()
    if (this.closed) {
      this.setStatus("closed")
      return
    }
    const reaction = closeReaction(code)
    if (!reaction.reconnect) {
      this.setStatus("closed")
      return
    }
    if (!reaction.resume) this.sid = undefined
    if (reaction.refreshToken) this.refresher.markStale()
    if (!welcomed && code === 1006 && this.options.fallback !== undefined) {
      if (this.ladder.failed(Date.now())) {
        void this.descend()
        return
      }
    }
    this.scheduleReconnect(reaction.minDelayMs)
  }

  private scheduleReconnect(minDelayMs: number): void {
    if (this.reconnectTimer !== undefined || this.closed) return
    if (CanopyClient.offline()) {
      this.setStatus("offline")
      return
    }
    this.setStatus("reconnecting")
    const delay = Math.max(
      Math.min(300_000, minDelayMs),
      backoff(this.attempt, this.options.maxBackoffMs ?? 30_000),
    )
    this.attempt += 1
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined
        this.connect()
      },
      delay >= 0 && delay <= 2_147_483_647 ? delay : 30_000,
    )
  }

  /** Reconnects now, for example on `online` or when the page becomes visible. */
  reconnectNow(): void {
    if (this.socket !== undefined || this.closed) return
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.connect()
  }

  /** Closes the connection for good (`bye`). */
  close(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.refresher.stop()
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.ladder.stop()
    this.queries.stop()
    this.stopLifecycle?.()
    this.stopAuth?.()
    if (this.socket !== undefined && this.socket.readyState === 1)
      this.write(this.socket, encodeMessage({ t: "bye" }))
    this.socket?.close(1000, "bye")
    this.store.dispose()
    this.outbox.abandon(ErrorCode.Unavailable, "The client was closed")
    this.setStatus("closed")
  }
}

function withoutId(doc: Record<string, unknown>, original: object): Document {
  if ("_id" in original) return asDocument(doc)
  const { _id: _omitted, ...rest } = doc
  return rest
}

/**
 * Creates a client and starts connecting. Pass the schema from your `canopy.schema.ts` (`defineSchema()`) to
 * type every query and write and to generate IDs and defaults from the same definition:
 * `createClient({ url, publishableKey, schema })`. Once the schema is registered through `Register`, the
 * option is required.
 */
export function createClient<
  S extends SchemaConstraint,
  A extends TokenSource | undefined = TokenSource | undefined,
>(
  options: ClientOptions & { readonly schema: S; readonly auth?: A },
): CanopyClient<SchemaTypes<S>, A>
/**
 * Creates a client and starts connecting, typed by the registered schema, untyped, or with an explicit
 * database type such as a `Database` interface from `canopy gen types`.
 */
export function createClient<
  DB extends Schema<DB> = DefaultSchema,
  A extends TokenSource | undefined = TokenSource | undefined,
>(options: ClientOptions & SchemaOption & { readonly auth?: A }): CanopyClient<DB, A>
export function createClient<DB extends Schema<DB>, A extends TokenSource | undefined>(
  options: ClientOptions,
): CanopyClient<DB, A> {
  return new CanopyClient<DB, A>(options)
}
