import { type CompiledFilter, compileFilter } from "../matcher/index.ts"
import {
  type BsonLibrary,
  CanopyError,
  canonicalString,
  ErrorCode,
  isDocument,
  toBsonLibrary,
} from "../protocol/index.ts"
import type { ContextDefinitions, ContextLookup, RequestContext } from "./model.ts"
import { resolveClause } from "./variables.ts"

/** One lookup query, built from a declaration and the subject's claims. */
export interface ContextQuery {
  /** The source collection in the app database. */
  readonly from: string
  /** The `where` clause with its `$auth` variables substituted. */
  readonly filter: Readonly<Record<string, unknown>>
  /** The dotted path whose values make up the result. */
  readonly select: string
  /** The most documents to read: `max + 1`, so an oversized result is detected. */
  readonly limit: number
  /** Aborted when the lookup times out. */
  readonly signal: AbortSignal
}

/**
 * Reads the documents of a lookup with service privileges. Each returned document needs its `_id` and the
 * selected path. The MongoDB implementations live in the server packages.
 */
export type ContextReader = (query: ContextQuery) => Promise<readonly Record<string, unknown>[]>

/** Why a lookup produced no value. Its variable then counts as missing, so the policy does not match. */
export type ContextIssueKind = "unresolvable" | "max" | "timeout" | "error"

/** Reported for every lookup that fails closed. */
export interface ContextIssue {
  readonly name: string
  readonly kind: ContextIssueKind
  readonly error?: unknown
}

/** A change to a document of a source collection, as seen on the change stream. */
export interface ContextChange {
  readonly coll: string
  readonly id: unknown
  /** `null` when there is none (insert), `undefined` when unknown. */
  readonly pre?: Readonly<Record<string, unknown>> | null | undefined
  /** `null` when the document is gone (delete), `undefined` when unknown. */
  readonly post?: Readonly<Record<string, unknown>> | null | undefined
}

/** Options for {@link ContextResolver}. */
export interface ContextResolverOptions {
  readonly reader: ContextReader
  /** How long one lookup may take before it fails closed. Defaults to 1000 ms. */
  readonly timeoutMs?: number
  /** Cached results that no live subscription holds are evicted beyond this count. Defaults to 10000. */
  readonly maxEntries?: number
  /** How often expired entries are swept. Defaults to 5000 ms. */
  readonly sweepIntervalMs?: number
  /** The clock, in milliseconds. */
  readonly now?: () => number
  /** Called when a lookup fails closed. Must not throw. */
  readonly onIssue?: (issue: ContextIssue) => void
}

/** The lookups resolved for one request. */
export interface ResolvedContext {
  /** Values by lookup name. A name without a value counts as missing. */
  readonly ctx: Readonly<Record<string, unknown>>
  /** The cache entry of each name, for {@link ContextResolver.retain} and invalidation. */
  readonly keys: ReadonlyMap<string, string>
  /**
   * Names whose lookup failed for a transient reason (an error or a timeout). Their results are not cached,
   * so nothing invalidates them: callers that hold a context for long, such as realtime, retry them later.
   */
  readonly failed: ReadonlySet<string>
}

interface Entry {
  readonly key: string
  readonly from: string
  /** `undefined` when the `where` clause cannot run in memory: every change of the source then invalidates. */
  readonly matcher: CompiledFilter | undefined
  readonly ids: ReadonlySet<string>
  /** The selected values, or `undefined` when the result was larger than `max`. */
  readonly value: readonly unknown[] | undefined
  readonly expiresAt: number
}

interface Pending {
  readonly key: string
  readonly from: string
  readonly matcher: CompiledFilter | undefined
  stale: boolean
}

type Outcome =
  | { readonly kind: "value"; readonly value: readonly unknown[] }
  | { readonly kind: "issue"; readonly issue: ContextIssueKind; readonly error?: unknown }

const TTL = /^(\d+)([smhd])$/
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}
const STALE_RETRIES = 3
const TIMED_OUT = new CanopyError(ErrorCode.Timeout, "The context lookup timed out")

/** Converts a lookup `ttl` such as `30s`, `5m`, `1h` or `1d` to milliseconds. */
export function ttlMs(ttl: string): number {
  const match = TTL.exec(ttl)
  if (match === null) throw new TypeError(`Invalid ttl ${ttl}`)
  return Number(match[1]) * (UNIT_MS[match[2] ?? "s"] ?? 1000)
}

/**
 * The values of `path` in a document, following arrays the way MongoDB does: arrays met on the way are
 * traversed, and an array at the end contributes its elements. `null` and missing values are skipped.
 */
export function selectValues(doc: unknown, path: string): unknown[] {
  const out: unknown[] = []
  const visit = (value: unknown, segments: readonly string[]): void => {
    if (value === undefined || value === null) return
    if (segments.length === 0) {
      if (Array.isArray(value)) {
        for (const item of value) if (item !== undefined && item !== null) out.push(item)
      } else {
        out.push(value)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, segments)
      return
    }
    const [head, ...rest] = segments
    if (head === undefined || !isDocument(value) || !Object.hasOwn(value, head)) return
    visit(value[head], rest)
  }
  visit(doc, path.split("."))
  return out
}

/** The names of the context lookups a clause refers to. */
export function contextNames(clause: unknown): string[] {
  const out = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isDocument(value)) return
    if (typeof value["$ctx"] === "string") {
      out.add(value["$ctx"])
      return
    }
    for (const key of Object.keys(value)) visit(value[key])
  }
  visit(clause)
  return [...out]
}

function compile(filter: Readonly<Record<string, unknown>>): CompiledFilter | undefined {
  try {
    return compileFilter(filter)
  } catch {
    return undefined
  }
}

function touches(
  target: { readonly matcher: CompiledFilter | undefined },
  change: ContextChange,
): boolean {
  if (target.matcher === undefined) return true
  if (change.post === undefined && change.pre === undefined) return true
  for (const image of [change.pre, change.post]) {
    if (image !== undefined && image !== null && target.matcher.matches(image)) return true
  }
  return false
}

/**
 * Resolves declared context lookups (`$ctx`) for request contexts, with service privileges, and caches
 * the results.
 *
 * A result is cached per lookup declaration and substituted `where` clause, so subjects with the same
 * claims share it and a claim change never reuses another subject's result. Every failure is closed: a
 * result with more than `max` documents, an error or a timeout leaves the name without a value, which
 * makes the policies using it non matching.
 *
 * Changes to source collections invalidate cached results through {@link invalidate}: an entry is dropped
 * when the changed document's pre or post image matches its `where` clause, or when the document was part
 * of the cached result (this covers deletes and updates without pre images). A lookup that is still
 * running when a relevant change arrives is read again rather than cached. Entries also expire after
 * their `ttl`; expiry of an entry a subscription holds is reported like an invalidation.
 */
export class ContextResolver {
  private readonly reader: ContextReader
  private readonly timeoutMs: number
  private readonly maxEntries: number
  private readonly sweepIntervalMs: number
  private readonly now: () => number
  private readonly onIssue: ((issue: ContextIssue) => void) | undefined
  private readonly entries = new Map<string, Entry>()
  private readonly bySource = new Map<string, Set<string>>()
  private readonly running = new Map<string, Promise<Outcome>>()
  private readonly pending = new Set<Pending>()
  private readonly retained = new Map<string, number>()
  private readonly listeners = new Set<(keys: ReadonlySet<string>) => void>()
  private sweeper: ReturnType<typeof setInterval> | undefined

  constructor(options: ContextResolverOptions) {
    this.reader = options.reader
    this.timeoutMs = options.timeoutMs ?? 1000
    this.maxEntries = options.maxEntries ?? 10_000
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000
    this.now = options.now ?? Date.now
    this.onIssue = options.onIssue
  }

  /** The number of cached results. */
  get size(): number {
    return this.entries.size
  }

  /** Whether any cached or running lookup reads from `coll`, so its changes need full images. */
  watches(coll: string): boolean {
    if ((this.bySource.get(coll)?.size ?? 0) > 0) return true
    for (const pending of this.pending) if (pending.from === coll) return true
    return false
  }

  /**
   * Resolves the named lookups for a request context. Names that are not declared, and lookups that fail,
   * are left without a value. Never rejects.
   */
  async resolve(
    contexts: ContextDefinitions,
    names: Iterable<string>,
    request: RequestContext,
  ): Promise<ResolvedContext> {
    const ctx: Record<string, unknown> = {}
    const keys = new Map<string, string>()
    const failed = new Set<string>()
    await Promise.all(
      [...new Set(names)].map(async (name) => {
        const lookup = Object.hasOwn(contexts, name) ? contexts[name] : undefined
        if (lookup === undefined) return
        const where = resolveClause(lookup.where, { ...request, ctx: {} })
        if (!where.ok) {
          this.onIssue?.({ name, kind: "unresolvable" })
          return
        }
        const key = canonicalString({ lookup, where: where.filter })
        keys.set(name, key)
        const outcome = await this.lookup(key, lookup, where.filter)
        if (outcome.kind === "value") {
          ctx[name] = outcome.value
          return
        }
        if (outcome.issue === "error" || outcome.issue === "timeout") failed.add(name)
        this.onIssue?.({
          name,
          kind: outcome.issue,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        })
      }),
    )
    return { ctx, keys, failed }
  }

  private async lookup(
    key: string,
    lookup: ContextLookup,
    filter: Record<string, unknown>,
  ): Promise<Outcome> {
    const cached = this.entries.get(key)
    if (cached !== undefined && cached.expiresAt > this.now()) return this.outcomeOf(cached)
    const running = this.running.get(key)
    if (running !== undefined) return running
    const promise = this.load(key, lookup, filter).finally(() => this.running.delete(key))
    this.running.set(key, promise)
    return promise
  }

  private outcomeOf(entry: Entry): Outcome {
    return entry.value === undefined
      ? { kind: "issue", issue: "max" }
      : { kind: "value", value: entry.value }
  }

  private async load(
    key: string,
    lookup: ContextLookup,
    filter: Record<string, unknown>,
  ): Promise<Outcome> {
    const matcher = compile(filter)
    for (let attempt = 0; ; attempt += 1) {
      const pending: Pending = { key, from: lookup.from, matcher, stale: false }
      this.pending.add(pending)
      let docs: readonly Record<string, unknown>[]
      try {
        docs = await this.read(lookup, filter)
      } catch (error: unknown) {
        return error === TIMED_OUT
          ? { kind: "issue", issue: "timeout" }
          : { kind: "issue", issue: "error", error }
      } finally {
        this.pending.delete(pending)
      }
      const overMax = docs.length > lookup.max
      const values = new Map<string, unknown>()
      const ids = new Set<string>()
      if (!overMax) {
        for (const doc of docs) {
          ids.add(canonicalString(doc["_id"]))
          for (const value of selectValues(doc, lookup.select))
            values.set(canonicalString(value), value)
        }
      }
      const value = overMax ? undefined : [...values.values()]
      if (pending.stale && attempt + 1 < STALE_RETRIES) continue
      if (!pending.stale) {
        this.store({
          key,
          from: lookup.from,
          matcher,
          ids,
          value,
          expiresAt: this.now() + ttlMs(lookup.ttl),
        })
      }
      return value === undefined ? { kind: "issue", issue: "max" } : { kind: "value", value }
    }
  }

  private async read(
    lookup: ContextLookup,
    filter: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(TIMED_OUT)
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([
        this.reader({
          from: lookup.from,
          filter,
          select: lookup.select,
          limit: lookup.max + 1,
          signal: controller.signal,
        }),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private store(entry: Entry): void {
    this.remove(entry.key)
    this.entries.set(entry.key, entry)
    const keys = this.bySource.get(entry.from) ?? new Set()
    keys.add(entry.key)
    this.bySource.set(entry.from, keys)
    this.evict()
    this.startSweeper()
  }

  private remove(key: string): Entry | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    const keys = this.bySource.get(entry.from)
    keys?.delete(key)
    if (keys !== undefined && keys.size === 0) this.bySource.delete(entry.from)
    return entry
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) return
      if (!this.retained.has(key)) this.remove(key)
    }
  }

  private startSweeper(): void {
    if (this.sweeper !== undefined) return
    this.sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs)
    const timer = this.sweeper as unknown as { unref?: () => void }
    timer.unref?.()
  }

  /** Drops expired entries and reports the ones a subscription holds. */
  sweep(): void {
    const now = this.now()
    const expired = new Set<string>()
    for (const entry of [...this.entries.values()]) {
      if (entry.expiresAt > now) continue
      this.remove(entry.key)
      if (this.retained.has(entry.key)) expired.add(entry.key)
    }
    this.notify(expired)
  }

  /**
   * Applies a change of a source collection: drops every cached result it may affect, marks running
   * lookups it may affect as stale, and reports the dropped keys to {@link onInvalidate} listeners.
   */
  invalidate(change: ContextChange): void {
    for (const pending of this.pending) {
      if (pending.from === change.coll && touches(pending, change)) pending.stale = true
    }
    const keys = this.bySource.get(change.coll)
    if (keys === undefined) return
    const id = canonicalString(change.id)
    const dropped = new Set<string>()
    for (const key of [...keys]) {
      const entry = this.entries.get(key)
      if (entry === undefined) continue
      if (entry.value === undefined || entry.ids.has(id) || touches(entry, change)) {
        this.remove(key)
        dropped.add(key)
      }
    }
    this.notify(dropped)
  }

  /** Drops every cached result and reports the retained ones, for example after a stream restart. */
  invalidateAll(): void {
    for (const pending of this.pending) pending.stale = true
    const dropped = new Set<string>()
    for (const key of [...this.entries.keys()]) {
      this.remove(key)
      if (this.retained.has(key)) dropped.add(key)
    }
    this.notify(dropped)
  }

  private notify(keys: ReadonlySet<string>): void {
    if (keys.size === 0) return
    for (const listener of this.listeners) listener(keys)
  }

  /** Subscribes to invalidations. Returns the unsubscribe function. */
  onInvalidate(listener: (keys: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Marks entries as held by a live subscription: they are never evicted, and their expiry is reported. */
  retain(keys: Iterable<string>): void {
    for (const key of keys) this.retained.set(key, (this.retained.get(key) ?? 0) + 1)
  }

  /** Releases entries taken with {@link retain}. */
  release(keys: Iterable<string>): void {
    for (const key of keys) {
      const count = (this.retained.get(key) ?? 0) - 1
      if (count <= 0) this.retained.delete(key)
      else this.retained.set(key, count)
    }
  }

  /** Stops the expiry sweep. */
  close(): void {
    if (this.sweeper !== undefined) clearInterval(this.sweeper)
    this.sweeper = undefined
  }
}

/** The part of a MongoDB driver `Db` that {@link driverContextReader} uses. */
export interface ContextDatabase {
  collection(name: string): {
    find(
      filter: Record<string, unknown>,
      options: Record<string, unknown>,
    ): { toArray(): Promise<readonly unknown[]> }
  }
}

/**
 * Reads context lookups from the app database with the caller's own (service) privileges, through a
 * MongoDB driver `Db`. `bson` is the driver's BSON library (`import { BSON } from "mongodb"`). Values keep
 * their exact BSON types, so a lookup of ObjectIds matches ObjectIds.
 */
export function driverContextReader(db: ContextDatabase, bson: BsonLibrary): ContextReader {
  return async (query) =>
    (await db
      .collection(query.from)
      .find(toBsonLibrary(query.filter, bson) as Record<string, unknown>, {
        promoteValues: false,
        bsonRegExp: true,
        projection: { _id: 1, [query.select]: 1 },
        limit: query.limit,
        signal: query.signal,
      })
      .toArray()) as Record<string, unknown>[]
}
