import {
  type ClusterTime,
  type Document,
  isClusterTime,
  isDocument,
  ProtocolError,
  ValidationError,
} from "../../core/protocol/index.ts"
import type {
  ConsistentProjection,
  Filter,
  IdOf,
  Path,
  PathValue,
  ProjectedResult,
  Projection,
  Sort,
} from "../types.ts"
import { idSegment, type RestTransport, send } from "./request.ts"
import { type PatchOptions, patchDocument, type RestWrite, type RestWriter } from "./write.ts"

/** How a count is computed: `exact` counts matching documents, `estimated` may use collection metadata. */
export type CountMode = "exact" | "estimated"

/** One page of a REST query. */
export interface RestPage<T> {
  readonly data: readonly T[]
  readonly page: {
    readonly limit: number
    /** The cursor of the next page, for `page({ after })`, or `null` on the last page. Opaque. */
    readonly next: string | null
    /** The number of matching documents, when the page asked for a count. */
    readonly total?: number
  }
  /** The cluster time the page was read at. */
  readonly ct: ClusterTime
}

/** A single document read by ID. */
export interface RestDocument<T> {
  readonly data: T
  readonly ct: ClusterTime
}

/** The result of a count. */
export interface RestCount {
  readonly data: { readonly count: number; readonly exact: boolean }
  readonly ct: ClusterTime
}

/** Values read at one cluster time, from `distinct` or `aggregate`. */
export interface RestValues<T> {
  readonly data: readonly T[]
  readonly ct: ClusterTime
}

/** One problem a {@link OutputDecoder} found. */
export interface DecodeIssue {
  readonly message: string
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[]
}

/**
 * A Standard Schema decoder supplied by the caller. An aggregation pipeline can change document shape,
 * so the decoder checks the output before the SDK returns it with a type.
 */
export interface OutputDecoder<T> {
  readonly "~standard": {
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: T; readonly issues?: undefined }
      | { readonly issues: readonly DecodeIssue[] }
      | Promise<
          | { readonly value: T; readonly issues?: undefined }
          | { readonly issues: readonly DecodeIssue[] }
        >
  }
}

/** The values `distinct` returns for a field: the elements of an array field, each value once. */
export type DistinctValue<V> = Exclude<V extends readonly (infer E)[] ? E : V, undefined>

/** Options of {@link RestCollection.aggregate}. */
export interface AggregateOptions<T = unknown> {
  /** Checks each output document; without it the documents are `unknown`. */
  readonly decode?: OutputDecoder<T>
  readonly signal?: AbortSignal
}

/** Options of {@link RestQuery.page}. */
export interface PageOptions {
  /** The cursor from the previous page's `page.next`. */
  readonly after?: string
  /** Also count the matching documents into `page.total`. */
  readonly count?: CountMode
  readonly signal?: AbortSignal
}

/** Options of {@link RestCollection.findById}. */
export interface FindByIdOptions<F> {
  readonly fields?: F & ConsistentProjection<F>
  readonly signal?: AbortSignal
}

/** Options of {@link RestCollection.count}. */
export interface CountOptions {
  /** Defaults to `exact`. */
  readonly mode?: CountMode
  readonly signal?: AbortSignal
}

/**
 * An immutable description of a REST read: building it sends nothing; `page()` runs it. Each method returns
 * a new query, and a second `find` replaces the filter.
 */
export interface RestQuery<Doc = Document, Out = Doc> {
  find(filter: Filter<Doc>): RestQuery<Doc, Out>
  sort(sort: Sort<Doc>): RestQuery<Doc, Out>
  limit(limit: number): RestQuery<Doc, Out>
  /** Narrows the returned fields. The result type follows a literal projection. */
  fields<const F extends Projection<Doc>>(
    fields: F & ConsistentProjection<F>,
  ): RestQuery<Doc, ProjectedResult<Doc, F>>
  /** Reads one page, or the page after the cursor `after`. */
  page(options?: PageOptions): Promise<RestPage<Out>>
}

/** One collection over REST: its queries, reads by ID, counts and merge patches. */
export interface RestCollection<Doc = Document> extends RestQuery<Doc, Doc>, RestWriter<Doc> {
  readonly name: string
  /**
   * Reads one document by `_id`. Rejects with `NotFoundError` when it does not exist or the caller may not
   * read it.
   */
  findById<const F extends Projection<Doc> = never>(
    id: IdOf<Doc>,
    options?: FindByIdOptions<F>,
  ): Promise<RestDocument<ProjectedResult<Doc, F>>>
  /** Counts the documents matching `filter` that the caller may read. */
  count(filter?: Filter<Doc>, options?: CountOptions): Promise<RestCount>
  /** The distinct values of `field` among the documents matching `filter` that the caller may read. */
  distinct<P extends Path<Doc>>(
    field: P,
    filter?: Filter<Doc>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RestValues<DistinctValue<PathValue<Doc, P>>>>
  /**
   * Runs an aggregation pipeline under the caller's policies. The output is `unknown`, since a pipeline can
   * change the documents' shape, unless `decode` checks it: a document it rejects fails the call with a
   * `ValidationError`.
   */
  aggregate(
    pipeline: readonly Document[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<RestValues<unknown>>
  aggregate<T>(
    pipeline: readonly Document[],
    options: AggregateOptions<T> & { readonly decode: OutputDecoder<T> },
  ): Promise<RestValues<T>>
}

interface QuerySpec {
  readonly filter: Document
  readonly sort?: Readonly<Record<string, 1 | -1>>
  readonly limit?: number
  readonly fields?: Readonly<Record<string, 0 | 1>>
}

function protocol(message: string): ProtocolError {
  return new ProtocolError(`Unexpected response: ${message}`)
}

function clusterTime(body: Record<string, unknown>): ClusterTime {
  const ct = body["ct"]
  if (!isClusterTime(ct)) throw protocol("ct is not a cluster time")
  return ct
}

function documents(value: unknown): Document[] {
  if (!Array.isArray(value) || !value.every(isDocument))
    throw protocol("data is not a list of documents")
  return value
}

function envelope(value: unknown): Record<string, unknown> {
  if (!isDocument(value)) throw protocol("the body is not a document")
  return value
}

/** Validates a `_query` response. */
function readPage(value: unknown): RestPage<Document> {
  const body = envelope(value)
  const page = body["page"]
  if (!isDocument(page)) throw protocol("page is missing")
  const { limit, next, total } = page
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
    throw protocol("page.limit is not a count")
  if (next !== null && typeof next !== "string") throw protocol("page.next is not a cursor")
  if (
    total !== undefined &&
    (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
  )
    throw protocol("page.total is not a count")
  return {
    data: documents(body["data"]),
    page: { limit, next, ...(total === undefined ? {} : { total }) },
    ct: clusterTime(body),
  }
}

/** Validates a `_count` response. */
function readCount(value: unknown): RestCount {
  const body = envelope(value)
  const data = body["data"]
  if (!isDocument(data)) throw protocol("data is missing")
  const { count, exact } = data
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw protocol("data.count is not a count")
  if (typeof exact !== "boolean") throw protocol("data.exact is not a boolean")
  return { data: { count, exact }, ct: clusterTime(body) }
}

function readValues(value: unknown): RestValues<unknown> {
  const body = envelope(value)
  const data = body["data"]
  if (!Array.isArray(data)) throw protocol("data is not a list")
  return { data, ct: clusterTime(body) }
}

function issuePath(issue: DecodeIssue): string {
  return (issue.path ?? [])
    .map((part) => String(typeof part === "object" ? part.key : part))
    .join(".")
}

async function decodeAll<T>(values: readonly unknown[], decoder: OutputDecoder<T>): Promise<T[]> {
  const out: T[] = []
  for (const [index, value] of values.entries()) {
    const result = await decoder["~standard"].validate(value)
    if (result.issues !== undefined) {
      const [first] = result.issues
      const where = first === undefined ? "" : issuePath(first)
      throw new ValidationError(
        `Output document ${index} does not match: ${first?.message ?? "invalid"}${where === "" ? "" : ` at ${where}`}`,
        {
          details: {
            index,
            issues: result.issues.map((issue) => ({
              message: issue.message,
              path: issuePath(issue),
            })),
          },
        },
      )
    }
    out.push(result.value)
  }
  return out
}

/** Validates a read by ID. */
function readDocument(value: unknown): RestDocument<Document> {
  const body = envelope(value)
  const data = body["data"]
  if (!isDocument(data)) throw protocol("data is not a document")
  return { data, ct: clusterTime(body) }
}

function fieldsParam(fields: Readonly<Record<string, 0 | 1>>): string {
  return Object.entries(fields)
    .map(([path, flag]) => (flag === 0 ? `-${path}` : path))
    .join(",")
}

function collectionPath(collection: string): string {
  return `/rest/v1/${encodeURIComponent(collection)}`
}

/** The runtime of {@link RestQuery} and {@link RestCollection}. */
class RestReader {
  readonly name: string
  private readonly transport: RestTransport
  private readonly spec: QuerySpec

  constructor(transport: RestTransport, collection: string, spec: QuerySpec) {
    this.transport = transport
    this.name = collection
    this.spec = spec
  }

  private with(spec: Partial<QuerySpec>): RestReader {
    return new RestReader(this.transport, this.name, { ...this.spec, ...spec })
  }

  find(filter: object): RestReader {
    return this.with({ filter: filter as Document })
  }

  sort(sort: object): RestReader {
    return this.with({ sort: sort as Record<string, 1 | -1> })
  }

  limit(limit: number): RestReader {
    return this.with({ limit })
  }

  fields(fields: object): RestReader {
    return this.with({ fields: fields as Record<string, 0 | 1> })
  }

  async page(options: PageOptions = {}): Promise<RestPage<Document>> {
    const body = {
      ...this.spec,
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.count === undefined ? {} : { count: options.count }),
    }
    return readPage(
      await send(this.transport, {
        method: "POST",
        path: `${collectionPath(this.name)}/_query`,
        body,
        signal: options.signal,
      }),
    )
  }

  patch(
    id: unknown,
    patch: object,
    options: PatchOptions<Document> = {},
  ): Promise<RestWrite<Document>> {
    return patchDocument(this.transport, collectionPath(this.name), id, patch, options)
  }

  async findById(
    id: unknown,
    options: { readonly fields?: object; readonly signal?: AbortSignal } = {},
  ): Promise<RestDocument<Document>> {
    const query =
      options.fields === undefined
        ? ""
        : `?fields=${encodeURIComponent(fieldsParam(options.fields as Record<string, 0 | 1>))}`
    return readDocument(
      await send(this.transport, {
        method: "GET",
        path: `${collectionPath(this.name)}/${idSegment(id)}${query}`,
        signal: options.signal,
      }),
    )
  }

  async distinct(
    field: string,
    filter: object = {},
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<RestValues<unknown>> {
    return readValues(
      await send(this.transport, {
        method: "POST",
        path: `${collectionPath(this.name)}/_distinct`,
        body: { field, filter },
        signal: options.signal,
      }),
    )
  }

  async aggregate(
    pipeline: readonly Document[],
    options: AggregateOptions<unknown> = {},
  ): Promise<RestValues<unknown>> {
    const result = readValues(
      await send(this.transport, {
        method: "POST",
        path: `${collectionPath(this.name)}/_aggregate`,
        body: { pipeline },
        signal: options.signal,
      }),
    )
    if (options.decode === undefined) return result
    return { data: await decodeAll(result.data, options.decode), ct: result.ct }
  }

  async count(filter: object = {}, options: CountOptions = {}): Promise<RestCount> {
    const mode = options.mode ?? "exact"
    return readCount(
      await send(this.transport, {
        method: "POST",
        path: `${collectionPath(this.name)}/_count`,
        body: { filter },
        headers: { prefer: `count=${mode}` },
        signal: options.signal,
      }),
    )
  }
}

/** A collection reader with no filter yet. */
export function restCollection(transport: RestTransport, collection: string): RestCollection {
  return new RestReader(transport, collection, { filter: {} }) as unknown as RestCollection
}
