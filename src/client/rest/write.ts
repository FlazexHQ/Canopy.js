import {
  type CanopyError,
  type ClusterTime,
  canonicalString,
  type Document,
  isClusterTime,
  isDocument,
  ProtocolError,
} from "../../core/protocol/index.ts"
import type {
  CollectionName,
  DocumentOf,
  Filter,
  IdOf,
  InsertOf,
  Leaf,
  UpdateFilter,
} from "../types.ts"
import { idSegment, problemError, type RestTransport, send } from "./request.ts"

type MergeValue<V> = V extends Leaf | readonly unknown[] ? V : V extends object ? MergePatch<V> : V

/**
 * A JSON merge patch (RFC 7386) of a document type: the named fields are set, subdocuments are merged field
 * by field, arrays are replaced whole, and `null` removes a field, so only optional fields accept it. `_id`
 * cannot change.
 */
export type MergePatch<T> = {
  readonly [K in Exclude<keyof T, "_id">]?:
    MergeValue<Exclude<T[K], undefined>> | (Record<never, never> extends Pick<T, K> ? null : never)
}

/** Options of {@link RestWriter.patch}. */
export interface PatchOptions<Doc> {
  /** Applies the patch only while the document also matches this filter; otherwise `ConflictError`. */
  readonly where?: Filter<Doc>
  /**
   * Makes the request safe to retry: the server applies a key once and answers a repeat with the stored
   * result and `replayed: true`, for example after a response was lost. 8 to 128 letters, digits, hyphens
   * or underscores.
   */
  readonly idempotencyKey?: string
  readonly signal?: AbortSignal
}

/** The result of a write over REST. */
export interface RestWrite<T> {
  /** The document after the write, as the caller may read it, or `null` when it may not. */
  readonly data: T | null
  /** The cluster time of the write. */
  readonly ct: ClusterTime
  /** Whether the server answered an idempotency key it had already applied, without writing again. */
  readonly replayed: boolean
}

/** The write methods of a REST collection. */
export interface RestWriter<Doc = Document> {
  /**
   * Applies a JSON merge patch to one document (`PATCH` with `application/merge-patch+json`). Rejects with
   * `NotFoundError` when the document does not exist or the caller may not update it.
   */
  patch(id: IdOf<Doc>, patch: MergePatch<Doc>, options?: PatchOptions<Doc>): Promise<RestWrite<Doc>>
}

/** A batch operation that inserts one document into collection `C`. */
export interface BatchInsert<C extends string, Insert> {
  readonly op: "insert"
  readonly c: C
  readonly doc: Insert
}

/** A batch operation that updates one document of collection `C` by `_id`. */
export interface BatchUpdate<C extends string, Doc> {
  readonly op: "update"
  readonly c: C
  readonly id: IdOf<Doc>
  readonly update: UpdateFilter<Doc>
  /** Applies only while the document also matches this filter; otherwise `ConflictError`. */
  readonly where?: Filter<Doc>
}

/** A batch operation that replaces one document of collection `C` by `_id`. */
export interface BatchReplace<C extends string, Doc, Insert> {
  readonly op: "replace"
  readonly c: C
  readonly id: IdOf<Doc>
  readonly doc: Insert
  readonly where?: Filter<Doc>
  /** Inserts the document when no document has the `_id`. */
  readonly upsert?: boolean
}

/** A batch operation that deletes one document of collection `C` by `_id`. */
export interface BatchDelete<C extends string, Doc> {
  readonly op: "delete"
  readonly c: C
  readonly id: IdOf<Doc>
  readonly where?: Filter<Doc>
}

/** One operation of {@link RestBatchWriter.batch}, on any collection of the schema. */
export type BatchOperation<DB> = {
  readonly [C in CollectionName<DB>]:
    | BatchInsert<C, InsertOf<DB, C>>
    | BatchUpdate<C, DocumentOf<DB, C>>
    | BatchReplace<C, DocumentOf<DB, C>, InsertOf<DB, C>>
    | BatchDelete<C, DocumentOf<DB, C>>
}[CollectionName<DB>]

/** Options of {@link RestBatchWriter.batch}. */
export interface BatchOptions {
  /**
   * `true` runs every operation in one transaction: all apply or none does, and the first failure rejects.
   * `false` runs them one by one and reports each outcome.
   */
  readonly atomic: boolean
  /**
   * Makes the batch safe to retry. An atomic batch sends it as `Idempotency-Key`; otherwise operation `i`
   * uses `<key>-<i>`, so a retry replays the operations that already applied and runs the others. Keys are
   * 8 to 128 letters, digits, hyphens or underscores, suffix included.
   */
  readonly idempotencyKey?: string
  readonly signal?: AbortSignal
}

/** What one operation of a batch wrote. */
export interface BatchResult {
  /** The written document as the caller may read it, `null` for a delete or when it may not be read. */
  readonly data: Document | null
  /** How many documents the operation matched, for updates, replaces and deletes. */
  readonly matched?: number
  /** Whether a replace with `upsert` inserted the document. */
  readonly upserted?: boolean
}

/** The result of an atomic batch: every operation applied, at one cluster time. */
export interface RestAtomicBatch {
  readonly results: readonly BatchResult[]
  readonly ct: ClusterTime
  readonly replayed: boolean
}

/** The outcome of one operation of a batch that is not atomic. */
export type BatchOutcome =
  | (BatchResult & { readonly ok: true; readonly ct: ClusterTime; readonly replayed: boolean })
  | { readonly ok: false; readonly error: CanopyError }

/** The result of a batch that is not atomic: one outcome per operation, in order. */
export interface RestBatchOutcomes {
  readonly results: readonly BatchOutcome[]
}

/** Batches of writes over REST, across collections. */
export interface RestBatchWriter<DB> {
  /**
   * Sends several writes in one request to `_batch`. With `atomic: true` they apply together or not at all;
   * with `atomic: false` each applies on its own and its outcome is reported.
   */
  batch(
    operations: readonly BatchOperation<DB>[],
    options: BatchOptions & { readonly atomic: true },
  ): Promise<RestAtomicBatch>
  batch(
    operations: readonly BatchOperation<DB>[],
    options: BatchOptions & { readonly atomic: false },
  ): Promise<RestBatchOutcomes>
}

function protocol(message: string): ProtocolError {
  return new ProtocolError(`Unexpected response: ${message}`)
}

function envelope(value: unknown): Record<string, unknown> {
  if (!isDocument(value)) throw protocol("the body is not a document")
  return value
}

function clusterTime(body: Record<string, unknown>): ClusterTime {
  const ct = body["ct"]
  if (!isClusterTime(ct)) throw protocol("ct is not a cluster time")
  return ct
}

function replayedOf(body: Record<string, unknown>): boolean {
  const replayed = body["replayed"]
  if (typeof replayed !== "boolean") throw protocol("replayed is not a boolean")
  return replayed
}

function dataOf(body: Record<string, unknown>): Document | null {
  const data = body["data"] ?? null
  if (data !== null && !isDocument(data)) throw protocol("data is not a document")
  return data
}

function resultOf(body: Record<string, unknown>): BatchResult {
  const matched = body["matched"]
  if (matched !== undefined && (typeof matched !== "number" || !Number.isSafeInteger(matched)))
    throw protocol("matched is not a count")
  const upserted = body["upserted"]
  if (upserted !== undefined && typeof upserted !== "boolean")
    throw protocol("upserted is not a boolean")
  return {
    data: dataOf(body),
    ...(matched === undefined ? {} : { matched }),
    ...(upserted === undefined ? {} : { upserted }),
  }
}

/** Sends a merge patch of one document. */
export async function patchDocument(
  transport: RestTransport,
  path: string,
  id: unknown,
  patch: object,
  options: PatchOptions<Document>,
): Promise<RestWrite<Document>> {
  const where =
    options.where === undefined
      ? ""
      : `?where=${encodeURIComponent(canonicalString(options.where))}`
  const body = envelope(
    await send(transport, {
      method: "PATCH",
      path: `${path}/${idSegment(id)}${where}`,
      body: patch,
      headers: {
        "content-type": "application/merge-patch+json",
        ...(options.idempotencyKey === undefined
          ? {}
          : { "idempotency-key": options.idempotencyKey }),
      },
      signal: options.signal,
    }),
  )
  return { data: dataOf(body), ct: clusterTime(body), replayed: replayedOf(body) }
}

/** Sends a batch to `_batch` and validates its result. */
export async function sendBatch(
  transport: RestTransport,
  operations: readonly object[],
  options: BatchOptions,
): Promise<RestAtomicBatch | RestBatchOutcomes> {
  const key = options.idempotencyKey
  const ops =
    options.atomic || key === undefined
      ? operations
      : operations.map((operation, index) => ({ ...operation, mid: `${key}-${index}` }))
  const body = envelope(
    await send(transport, {
      method: "POST",
      path: "/rest/v1/_batch",
      body: { atomic: options.atomic, ops },
      headers: options.atomic && key !== undefined ? { "idempotency-key": key } : {},
      signal: options.signal,
    }),
  )
  const data = body["data"]
  if (!Array.isArray(data) || data.length !== operations.length)
    throw protocol("data does not have one result per operation")
  if (options.atomic)
    return {
      results: data.map((entry) => resultOf(envelope(entry))),
      ct: clusterTime(body),
      replayed: replayedOf(body),
    }
  return {
    results: data.map((entry): BatchOutcome => {
      const outcome = envelope(entry)
      const status = outcome["status"]
      if (typeof status !== "number") throw protocol("an outcome has no status")
      if (status >= 400) return { ok: false, error: problemError(outcome["error"], status) }
      return {
        ok: true,
        ...resultOf(outcome),
        ct: clusterTime(outcome),
        replayed: replayedOf(outcome),
      }
    }),
  }
}
