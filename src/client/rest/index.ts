import type { TokenSource } from "../client-types.ts"
import type { DefaultSchema, SchemaConstraint, SchemaOption, SchemaTypes } from "../register.ts"
import type { CollectionName, DocumentOf, Schema } from "../types.ts"
import { type RestCollection, restCollection } from "./read.ts"
import { type RestToken, type RestTransport, tokenGetter } from "./request.ts"
import { type RestBatchWriter, sendBatch } from "./write.ts"

export type {
  AggregateOptions,
  CountMode,
  CountOptions,
  DecodeIssue,
  DistinctValue,
  FindByIdOptions,
  OutputDecoder,
  PageOptions,
  RestCollection,
  RestCount,
  RestDocument,
  RestPage,
  RestQuery,
  RestValues,
} from "./read.ts"
export type { RestToken } from "./request.ts"
export type {
  BatchDelete,
  BatchInsert,
  BatchOperation,
  BatchOptions,
  BatchOutcome,
  BatchReplace,
  BatchResult,
  BatchUpdate,
  MergePatch,
  PatchOptions,
  RestAtomicBatch,
  RestBatchOutcomes,
  RestBatchWriter,
  RestWrite,
  RestWriter,
} from "./write.ts"

/** Options of {@link createRestClient}. */
export interface RestClientOptions {
  /** The Canopy base URL, for example `https://api.example.com`. */
  readonly url: string
  readonly publishableKey: string
  /**
   * Where each request's access token comes from, such as the `createAuth()` handle. It is asked before
   * every request, so a refreshed token is used at once.
   */
  readonly auth?: Pick<TokenSource, "getToken">
  /** A token, or a function returning one, for BYO auth on a server. Takes precedence over `auth`. */
  readonly token?: RestToken
  /** Overrides the global `fetch`. */
  readonly fetch?: typeof fetch
  /** Rejects a request that takes longer than this many milliseconds with `CANOPY_TIMEOUT`. */
  readonly timeoutMs?: number
}

/**
 * A stateless client of the Data API: one-off reads, merge patches and batches with the caller's identity,
 * under the same Document Level Security as live queries, without a WebSocket or a document cache. Optimistic
 * writes with outbox replay stay on the realtime client.
 */
export interface RestClient<DB extends Schema<DB> = DefaultSchema> extends RestBatchWriter<DB> {
  /** One collection: `rest.from("todos").find({ done: false }).limit(20).page()`. */
  from<C extends CollectionName<DB>>(collection: C): RestCollection<DocumentOf<DB, C>>
}

function transportOf(options: RestClientOptions): RestTransport {
  return {
    base: options.url.replace(/\/$/, ""),
    publishableKey: options.publishableKey,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    token: tokenGetter(options.token, options.auth),
    timeoutMs: options.timeoutMs,
  }
}

/**
 * Creates a REST client. Pass the schema from `canopy.schema.ts` to type its collections; once a schema is
 * registered through `Register`, the option is required.
 */
export function createRestClient<S extends SchemaConstraint>(
  options: RestClientOptions & { readonly schema: S },
): RestClient<SchemaTypes<S>>
export function createRestClient<DB extends Schema<DB> = DefaultSchema>(
  options: RestClientOptions & SchemaOption,
): RestClient<DB>
export function createRestClient(options: RestClientOptions): object {
  const transport = transportOf(options)
  return {
    from: (collection: string) => restCollection(transport, collection),
    batch: (operations: readonly object[], batchOptions: Parameters<typeof sendBatch>[2]) =>
      sendBatch(transport, operations, batchOptions),
  }
}
