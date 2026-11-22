import type { Document } from "../core/protocol/index.ts"
import { asDocument, type CanopyClient } from "./client.ts"
import type {
  LiveQuery,
  LiveQueryOptions,
  MutationHandle,
  ReplaceOptions,
  WriteOptions,
} from "./client-types.ts"
import type { QueryState } from "./store.ts"
import type {
  ConsistentProjection,
  Filter,
  IdOf,
  ProjectedResult,
  Projection,
  Sort,
  UntypedSchema,
  UpdateFilter,
} from "./types.ts"

export type AnyClient = CanopyClient<UntypedSchema>

/**
 * An immutable description of a live read: `todos.find({ done: false }).sort({ at: -1 }).limit(20)`. Each
 * method returns a new query; the server subscription opens when the query is first read or subscribed to.
 * A query has no write methods: writes belong to the collection, with an explicit filter or `where`.
 */
export interface Query<Doc = Document, Out = Doc> extends LiveQuery<Out> {
  /** Sets the filter. A second `find` replaces the first; it does not combine with it. */
  find(filter: Filter<Doc>): Query<Doc, Out>
  sort(sort: Sort<Doc>): Query<Doc, Out>
  limit(limit: number): Query<Doc, Out>
  /** Narrows the returned fields. The result type follows a literal projection. */
  fields<const F extends Projection<Doc>>(
    fields: F & ConsistentProjection<F>,
  ): Query<Doc, ProjectedResult<Doc, F>>
}

/**
 * One collection, from `client.from("todos")`: its writes, and live reads that start with `find`, `sort`,
 * `fields` or `limit` (or read the whole collection). Documents stay plain objects.
 */
export interface Collection<Doc = Document, Insert = Doc> extends Query<Doc, Doc> {
  /** The collection's name. */
  readonly name: string
  /** Inserts a document; its `_id` (given or generated) is on the handle at once. */
  insert(doc: Insert): MutationHandle<IdOf<Doc>>
  /** Inserts several documents in one mutation. */
  insertMany(docs: readonly Insert[]): MutationHandle
  /** Updates one document; `where` makes it a compare and set. */
  update(id: IdOf<Doc>, update: UpdateFilter<Doc>, options?: WriteOptions<Doc>): MutationHandle
  /** Replaces one document. */
  replace(id: IdOf<Doc>, doc: Insert, options?: ReplaceOptions<Doc>): MutationHandle
  /** Deletes one document. */
  delete(id: IdOf<Doc>, options?: WriteOptions<Doc>): MutationHandle
  /** Updates every visible document matching `filter`. */
  updateMany(filter: Filter<Doc>, update: UpdateFilter<Doc>): MutationHandle
  /** Deletes every visible document matching `filter`. */
  deleteMany(filter: Filter<Doc>): MutationHandle
}

/**
 * The runtime of {@link Query}: an immutable live read. `Doc` is the collection's document type and `Out`
 * the documents the query returns (narrowed by `fields`). It has no write methods, so a write can never take
 * its scope from a read: writes belong to {@link CollectionBuilder}.
 */
export class QueryBuilder<in out Doc = Document, out Out = Doc> implements LiveQuery<Out> {
  protected readonly client: AnyClient
  protected readonly collection: string
  private readonly filter: Document
  private readonly options: LiveQueryOptions<Doc>
  private cached: LiveQuery<Out> | undefined

  constructor(
    client: AnyClient,
    collection: string,
    filter: Document,
    options: LiveQueryOptions<Doc>,
  ) {
    this.client = client
    this.collection = collection
    this.filter = filter
    this.options = options
  }

  private with<Next = Out>(
    filter: Document,
    options: LiveQueryOptions<Doc>,
  ): QueryBuilder<Doc, Next> {
    return new QueryBuilder<Doc, Next>(this.client, this.collection, filter, options)
  }

  /** Sets the filter. A second `find` replaces the first; it does not combine with it. */
  find(filter: Filter<Doc>): QueryBuilder<Doc, Out> {
    return this.with(asDocument(filter), this.options)
  }

  sort(sort: Sort<Doc>): QueryBuilder<Doc, Out> {
    return this.with(this.filter, { ...this.options, sort })
  }

  limit(limit: number): QueryBuilder<Doc, Out> {
    return this.with(this.filter, { ...this.options, limit })
  }

  /** Narrows the returned fields. The result type follows a literal projection. */
  fields<const F extends Projection<Doc>>(
    fields: F & ConsistentProjection<F>,
  ): QueryBuilder<Doc, ProjectedResult<Doc, F>> {
    return this.with<ProjectedResult<Doc, F>>(this.filter, {
      ...this.options,
      fields: fields as Projection<Doc>,
    })
  }

  private live(): LiveQuery<Out> {
    this.cached ??= this.client.live(
      this.collection,
      this.filter,
      this.options as LiveQueryOptions,
    ) as unknown as LiveQuery<Out>
    return this.cached
  }

  getState(): QueryState<Out> {
    return this.live().getState()
  }

  subscribe(listener: (state: QueryState<Out>) => void): () => void {
    return this.live().subscribe(listener)
  }
}

/**
 * The runtime of {@link Collection}: the whole collection as a live read, plus its writes. `find`, `sort`,
 * `fields` and `limit` return a read-only {@link QueryBuilder}.
 */
export class CollectionBuilder<in out Doc = Document, in out Insert = Doc> extends QueryBuilder<
  Doc,
  Doc
> {
  constructor(client: AnyClient, collection: string) {
    super(client, collection, {}, {})
  }

  /** The collection's name. */
  get name(): string {
    return this.collection
  }

  /** Inserts a document; its `_id` (given or generated) is on the handle at once. */
  insert(doc: Insert): MutationHandle<IdOf<Doc>> {
    return this.client.insert(this.collection, asDocument(doc as object)) as MutationHandle<
      IdOf<Doc>
    >
  }

  /** Inserts several documents in one mutation. */
  insertMany(docs: readonly Insert[]): MutationHandle {
    return this.client.insertMany(
      this.collection,
      docs.map((doc) => asDocument(doc as object)),
    )
  }

  /** Updates one document; `where` makes it a compare and set. */
  update(id: IdOf<Doc>, update: UpdateFilter<Doc>, options?: WriteOptions<Doc>): MutationHandle {
    return this.client.update(
      this.collection,
      id,
      asDocument(update),
      options as WriteOptions | undefined,
    )
  }

  /** Replaces one document. */
  replace(id: IdOf<Doc>, doc: Insert, options?: ReplaceOptions<Doc>): MutationHandle {
    return this.client.replace(
      this.collection,
      id,
      asDocument(doc as object),
      options as ReplaceOptions | undefined,
    )
  }

  /** Deletes one document. */
  delete(id: IdOf<Doc>, options?: WriteOptions<Doc>): MutationHandle {
    return this.client.delete(this.collection, id, options as WriteOptions | undefined)
  }

  /** Updates every visible document matching `filter`. */
  updateMany(filter: Filter<Doc>, update: UpdateFilter<Doc>): MutationHandle {
    return this.client.updateMany(this.collection, asDocument(filter), asDocument(update))
  }

  /** Deletes every visible document matching `filter`. */
  deleteMany(filter: Filter<Doc>): MutationHandle {
    return this.client.deleteMany(this.collection, asDocument(filter))
  }
}
