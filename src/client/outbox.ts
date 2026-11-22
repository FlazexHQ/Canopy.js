import {
  type AckMessage,
  CanopyError,
  type ClusterTime,
  type Document,
  decode,
  ErrorCode,
  encode,
  encodeMessage,
  errorFromWire,
  type MutationOp,
  type MutMessage,
  uuidv7,
  ZERO_CT,
} from "../core/protocol/index.ts"
import type {
  ClientOptions,
  MutationHandle,
  MutationResult,
  Persister,
  StaleMutation,
} from "./client-types.ts"
import type { Layer, Store } from "./store.ts"
import { subjectOf } from "./token-refresh.ts"

/** A mutation waiting for its `ack`. */
export interface PendingMutation {
  readonly message: MutMessage
  readonly ids: readonly unknown[]
  /** Settles with the persister key once the mutation is stored. */
  readonly persisted?: Promise<string>
  sent: boolean
  readonly resolve: (result: MutationResult) => void
  readonly reject: (error: Error) => void
}

interface PersistedMutation {
  readonly m: MutMessage
  readonly ids: readonly unknown[]
  readonly layers: readonly Layer[]
  readonly at: number
}

const HOUR = 3_600_000
const MUTATIONS_UNAVAILABLE =
  "This realtime endpoint does not support mutations. Write through your own API or Canopy REST."

/** Options of an {@link Outbox}. */
export interface OutboxOptions {
  readonly store: Store
  readonly client: Pick<ClientOptions, "auth" | "persist" | "mutationTtlMs" | "maxInFlight">
  /** Whether the client was closed, so new mutations are refused at once. */
  readonly closed: () => boolean
  /** Mutation support from the latest handshake, if advertised. */
  readonly mutationsSupported: () => boolean | undefined
  /** A writer for the connection when it is open and welcomed, else `undefined`. */
  readonly channel: () => ((text: string) => void) | undefined
}

/**
 * The queue of optimistic mutations: sent in order with at most `maxInFlight` unacknowledged, settled by
 * their `ack`, persisted per subject when a persister is given, and restored (or marked stale) on start.
 */
export class Outbox {
  /** The mutations not yet acknowledged, oldest first. */
  readonly queue: PendingMutation[] = []
  private readonly options: OutboxOptions
  private inFlight = 0
  private readonly errorListeners = new Set<(error: Error, mutationId: string) => void>()
  private readonly staleListeners = new Set<(mutations: readonly StaleMutation[]) => void>()
  private stale: StaleMutation[] = []
  /** Resolves once persisted mutations are back in the queue; nothing is sent before. */
  private restoring: Promise<void> | undefined
  private currentScope = "anon"

  constructor(options: OutboxOptions) {
    this.options = options
    const persist = options.client.persist
    if (persist !== undefined) this.track(this.restore(persist))
  }

  /** The subject whose mutations and cached documents are persisted. */
  get scope(): string {
    return this.currentScope
  }

  /** Settles once the persisted state of the current subject is restored. */
  get ready(): Promise<void> {
    return this.restoring ?? Promise.resolve()
  }

  /** Takes the subject of the token a new connection uses, unless a restore decides it. */
  adoptToken(token: string | null | undefined): void {
    if (this.restoring === undefined) this.currentScope = subjectOf(token)
  }

  /** Holds back sending (and persisting) mutations until `work` settles. */
  private track(work: Promise<void>): void {
    const restoring: Promise<void> = work
      .catch(() => {})
      .finally(() => {
        if (this.restoring !== restoring) return
        this.restoring = undefined
        this.pump()
      })
    this.restoring = restoring
  }

  private async subject(): Promise<string> {
    return subjectOf(await this.options.client.auth?.getToken())
  }

  /**
   * Called when the signed in user may have changed. When the subject did change, the previous user's
   * queue is not sent as the new one: it stays persisted for their return, and the new user's is restored.
   */
  reidentify(): void {
    const previous = this.currentScope
    const before = this.restoring
    const persist = this.options.client.persist
    this.track(
      (async () => {
        await before
        if ((await this.subject()) === previous) return
        this.abandon(ErrorCode.Unauthorized, "The user changed")
        this.stale = []
        for (const listener of this.staleListeners) listener(this.stale)
        if (persist === undefined) this.currentScope = await this.subject()
        else await this.restore(persist)
      })(),
    )
  }

  /** Drops every queued mutation's optimistic layer and rejects its promise. */
  abandon(code: ErrorCode, reason: string): void {
    this.inFlight = 0
    for (const pending of this.queue.splice(0)) {
      this.options.store.dropLayer(pending.message.id)
      pending.reject(new CanopyError(code, `${reason} before the server confirmed the mutation`))
    }
  }

  /** Brings persisted mutations back: recent ones are queued again, older ones become stale. */
  private async restore(persist: Persister): Promise<void> {
    this.currentScope = subjectOf(await this.options.client.auth?.getToken())
    const prefix = `${this.currentScope}\u0000`
    const cutoff = Date.now() - ((this.options.client.mutationTtlMs ?? 24 * HOUR) - 4 * HOUR)
    const restored: PendingMutation[] = []
    for (const [key, value] of await persist.entries("mutations")) {
      if (!key.startsWith(prefix)) continue
      const record = decode(JSON.parse(value)) as PersistedMutation
      if (record.at < cutoff) {
        this.stale.push(this.staleMutation(persist, key, record))
        continue
      }
      for (const layer of record.layers) this.options.store.addLayer(record.m.id, layer)
      restored.push({
        message: record.m,
        ids: record.ids,
        persisted: Promise.resolve(key),
        sent: false,
        resolve: () => {},
        reject: () => {},
      })
    }
    this.queue.unshift(...restored)
    if (this.stale.length > 0) for (const listener of this.staleListeners) listener(this.stale)
  }

  private staleMutation(persist: Persister, key: string, record: PersistedMutation): StaleMutation {
    const forget = (): void => {
      const before = this.stale.length
      this.stale = this.stale.filter((entry) => entry.mutationId !== record.m.id)
      void persist.delete("mutations", key).catch(() => {})
      if (this.stale.length !== before)
        for (const listener of this.staleListeners) listener(this.stale)
    }
    return {
      mutationId: record.m.id,
      collection: record.m.c,
      op: record.m.op,
      args: record.m.args,
      createdAt: record.at,
      retry: () => {
        if (this.options.mutationsSupported() !== false) forget()
        return this.mutate(record.m.c, record.m.op, record.m.args, record.layers, record.ids)
      },
      discard: forget,
    }
  }

  /** The persisted mutations that were too old to replay and are not retried or discarded yet. */
  get staleMutations(): readonly StaleMutation[] {
    return this.stale
  }

  /** Calls `listener` with the stale mutations: at once when some are known, then on every change. */
  onStaleMutations(listener: (mutations: readonly StaleMutation[]) => void): () => void {
    this.staleListeners.add(listener)
    if (this.restoring === undefined && this.stale.length > 0) listener(this.stale)
    return () => this.staleListeners.delete(listener)
  }

  /** Calls `listener` whenever a mutation is rolled back. */
  onMutationError(listener: (error: Error, mutationId: string) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /** Applies the optimistic layers, queues (and persists) the mutation, and sends what may be sent. */
  mutate(
    collection: string,
    op: MutationOp,
    args: Document,
    layers: readonly Layer[],
    ids: readonly unknown[],
  ): MutationHandle {
    const mutationId = uuidv7()
    let resolve: (result: MutationResult) => void = () => {}
    let reject: (error: Error) => void = () => {}
    const promise = new Promise<MutationResult>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    promise.catch(() => {})
    if (this.options.closed()) {
      reject(new CanopyError(ErrorCode.Unavailable, "The client is closed"))
    } else if (this.options.mutationsSupported() === false) {
      reject(new CanopyError(ErrorCode.Unavailable, MUTATIONS_UNAVAILABLE))
    } else {
      for (const layer of layers) this.options.store.addLayer(mutationId, layer)
      const message: MutMessage = { t: "mut", id: mutationId, c: collection, op, args }
      const persist = this.options.client.persist
      const record: PersistedMutation = { m: message, ids, layers, at: Date.now() }
      const persisted =
        persist === undefined
          ? undefined
          : this.ready.then(async () => {
              const key = `${this.currentScope}\u0000${mutationId}`
              await persist
                .set("mutations", key, JSON.stringify(encode(record)))
                .catch((error: unknown) =>
                  console.warn(
                    "Canopy could not store a queued mutation; it is lost if the page closes before it is sent",
                    error,
                  ),
                )
              return key
            })
      this.queue.push({
        message,
        ids,
        ...(persisted === undefined ? {} : { persisted }),
        sent: false,
        resolve,
        reject,
      })
      this.pump()
    }
    return Object.assign(promise, { mutationId, id: ids[0] })
  }

  /** Marks every queued mutation unsent, for a new session that has seen none of them. */
  resend(): void {
    this.inFlight = 0
    for (const pending of this.queue) pending.sent = false
  }

  /** Sends queued mutations in order, keeping at most `maxInFlight` unacknowledged. */
  pump(): void {
    if (this.restoring !== undefined) return
    if (this.options.mutationsSupported() === false) {
      this.inFlight = 0
      for (const pending of this.queue.splice(0)) {
        this.forgetPersisted(pending)
        this.reject(pending, new CanopyError(ErrorCode.Unavailable, MUTATIONS_UNAVAILABLE))
      }
      return
    }
    const write = this.options.channel()
    if (write === undefined) return
    const max = this.options.client.maxInFlight ?? 32
    for (const pending of this.queue) {
      if (this.inFlight >= max) break
      if (pending.sent) continue
      pending.sent = true
      this.inFlight += 1
      write(encodeMessage(pending.message))
    }
  }

  /** Settles the mutation an `ack` names: rolls it back on failure, confirms its documents otherwise. */
  acknowledge(ack: AckMessage): void {
    const { store } = this.options
    const index = this.queue.findIndex((pending) => pending.message.id === ack.m)
    if (index < 0) return
    const [pending] = this.queue.splice(index, 1)
    if (pending === undefined) return
    if (pending.sent) this.inFlight = Math.max(0, this.inFlight - 1)
    this.forgetPersisted(pending)
    const { message } = pending
    if (!ack.ok) {
      this.reject(
        pending,
        errorFromWire(ack.err ?? { code: ErrorCode.Internal, msg: "The mutation failed" }),
      )
      this.pump()
      return
    }
    const ct = ack.ct ?? ZERO_CT
    if (ack.echo === true) store.dropLayer(message.id)
    else this.settleWithoutEcho(pending, ct, ack.res?.docs)
    pending.resolve({
      ct,
      echo: ack.echo === true,
      replayed: ack.replayed === true,
      matched: ack.res?.matched ?? 0,
      modified: ack.res?.modified ?? 0,
      insertedIds: ack.res?.insertedIds ?? [],
    })
    this.pump()
  }

  private forgetPersisted(pending: PendingMutation): void {
    const persist = this.options.client.persist
    if (persist !== undefined)
      void pending.persisted?.then((key) => persist.delete("mutations", key)).catch(() => {})
  }

  private reject(pending: PendingMutation, error: Error): void {
    const id = pending.message.id
    this.options.store.dropLayer(id)
    pending.reject(error)
    for (const listener of this.errorListeners) listener(error, id)
  }

  /**
   * Without an echo, post images in the ack become server state and the layer is dropped. Without them
   * (bulk writes, unreadable results) the layer stays until the server state catches up with the ack.
   */
  private settleWithoutEcho(
    pending: PendingMutation,
    ct: ClusterTime,
    docs: readonly Document[] | undefined,
  ): void {
    const { store } = this.options
    const { message } = pending
    const single = message.op !== "updateMany" && message.op !== "deleteMany"
    if (message.op === "delete") {
      for (const id of pending.ids) store.confirm(message.c, id, null, ct)
      store.dropLayer(message.id)
      return
    }
    const confirmed = new Set<unknown>()
    for (const doc of docs ?? []) {
      store.confirm(message.c, doc["_id"], doc, ct)
      confirmed.add(doc["_id"])
    }
    if (single && docs !== undefined && docs.length >= pending.ids.length) {
      store.dropLayer(message.id)
      return
    }
    store.awaitServer(message.id, ct)
  }
}
