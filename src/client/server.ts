import { type Document, type SubQuery, toCanonical } from "../core/protocol/index.ts"
import type { DehydratedState, ReadOptions, Snapshot } from "./client-types.ts"
import type { DefaultSchema } from "./register.ts"
import { restCollection } from "./rest/read.ts"
import { responseError } from "./rest/request.ts"
import type {
  CollectionName,
  DocumentOf,
  Filter,
  ProjectedResult,
  Projection,
  Schema,
  Sort,
} from "./types.ts"

/** Where a server request gets the user's access token. */
export type ServerToken = string | null | undefined | (() => Promise<string | null | undefined>)

/** The cookies of the incoming request, as Next.js `cookies()`, Nuxt and SvelteKit expose them. */
export interface CookieSource {
  getAll(): readonly { readonly name: string; readonly value: string }[]
}

/** Options of {@link createServerClient}. */
export interface ServerClientOptions {
  /** The Canopy base URL. */
  readonly url: string
  readonly publishableKey: string
  /** The user's access token, for BYO auth. Leave it out (with no cookies) to read as `anon`. */
  readonly token?: ServerToken
  /**
   * The incoming request's cookies, for built in auth on the same site: they are sent to
   * `/auth/v1/token` to mint an access token for the request.
   */
  readonly cookies?: CookieSource | string
  readonly fetch?: typeof fetch
}

/** A client for server rendering: one-off DLS reads whose results hydrate the browser's live queries. */
export interface ServerClient<DB extends Schema<DB> = DefaultSchema> {
  /**
   * Reads a query's current result as the request's user. Pass the same filter and options to
   * `live()` or `useQuery()` in the browser, so the hydrated result seeds that live query. A literal
   * `fields` projection narrows the snapshot's documents, as it does for `live()`.
   */
  find<C extends CollectionName<DB>, const F extends Projection<DocumentOf<DB, C>> = never>(
    collection: C,
    filter?: Filter<DocumentOf<DB, C>>,
    options?: ReadOptions<DocumentOf<DB, C>, F>,
  ): Promise<Snapshot<ProjectedResult<DocumentOf<DB, C>, F>>>
  /** The access token used for the request's reads, minted once from the cookies when needed. */
  token(): Promise<string | undefined>
}

function cookieHeader(cookies: CookieSource | string): string {
  if (typeof cookies === "string") return cookies
  return cookies
    .getAll()
    .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
    .join("; ")
}

/**
 * Creates a client for Server Components, Nuxt server routes and SvelteKit `load`: it reads through the
 * REST API with the user's token, so DLS applies exactly as in the browser, and returns snapshots with
 * their cluster time. Pass them through {@link dehydrate} to the page and `client.hydrate()` there.
 */
export function createServerClient<DB extends Schema<DB> = DefaultSchema>(
  options: ServerClientOptions,
): ServerClient<DB> {
  const base = options.url.replace(/\/$/, "")
  const http = options.fetch ?? globalThis.fetch.bind(globalThis)
  let minted: Promise<string | undefined> | undefined
  const token = (): Promise<string | undefined> => {
    minted ??= (async () => {
      const given = options.token
      if (typeof given === "function") return (await given()) ?? undefined
      if (typeof given === "string") return given
      if (options.cookies === undefined) return undefined
      const response = await http(`${base}/auth/v1/token`, {
        headers: { cookie: cookieHeader(options.cookies) },
      })
      if (response.status === 401) {
        await response.body?.cancel()
        return undefined
      }
      if (!response.ok) throw await responseError(response)
      const body = (await response.json()) as { access_token?: unknown }
      return typeof body.access_token === "string" ? body.access_token : undefined
    })()
    return minted
  }
  const transport = {
    base,
    publishableKey: options.publishableKey,
    fetch: http,
    token,
    timeoutMs: undefined,
  }
  return {
    token,
    async find(
      collection: string,
      filter: object = {},
      query: ReadOptions<Document, unknown> = {},
    ) {
      const q: SubQuery = {
        filter: filter as Document,
        ...(query.sort === undefined ? {} : { sort: query.sort as Document }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.fields === undefined ? {} : { fields: query.fields as Document }),
      } as SubQuery
      let reader = restCollection(transport, collection).find(filter as Document)
      if (query.sort !== undefined) reader = reader.sort(query.sort as Sort<Document>)
      if (query.limit !== undefined) reader = reader.limit(query.limit)
      if (query.fields !== undefined) reader = reader.fields(query.fields as Projection<Document>)
      const page = await reader.page()
      return { c: collection, q, docs: page.data, ct: page.ct }
    },
  } as unknown as ServerClient<DB>
}

/** Turns snapshots into plain JSON for the page; `client.hydrate()` reads it back in the browser. */
export function dehydrate(snapshots: readonly Snapshot<unknown>[]): DehydratedState {
  return { canopy: 1, queries: snapshots.map((snapshot) => toCanonical(snapshot)) }
}
