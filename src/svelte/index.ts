import { getContext, setContext } from "svelte"
import { createSubscriber } from "svelte/reactivity"

import type {
  CanopyClient,
  ConnectionStatus,
  DefaultSchema,
  LiveQuery,
  QueryState,
  QueryStatus,
  Schema,
} from "../client/index.ts"

const KEY = Symbol("canopy")

/** Makes a client available to {@link getCanopy} in the component and its children. */
export function setCanopy<DB extends Schema<DB> = DefaultSchema>(client: CanopyClient<DB>): void {
  setContext(KEY, client)
}

/**
 * Returns the client from {@link setCanopy}, typed by the registered schema. Code that cannot rely on it
 * passes the schema's types: `getCanopy<SchemaTypes<typeof schema>>()`.
 */
export function getCanopy<DB extends Schema<DB> = DefaultSchema>(): CanopyClient<DB> {
  const client = getContext<CanopyClient<DB> | undefined>(KEY)
  if (client === undefined)
    throw new Error("getCanopy needs setCanopy(client) in a parent component")
  return client
}

/** A live query for Svelte 5, from {@link createQuery}. */
export interface Query<T> {
  /** The documents. Reading it in a template, `$derived` or `$effect` keeps the query subscribed. */
  readonly data: readonly T[]
  readonly status: QueryStatus
  readonly error: Error | undefined
  /** The whole state. */
  readonly current: QueryState<T>
  /** The Svelte store contract, so `$query` works too. */
  subscribe(run: (state: QueryState<T>) => void): () => void
}

/**
 * Wraps a live query in a rune friendly object: its properties are reactive wherever they are read
 * (templates, `$derived`, `$effect`), and the subscription lives exactly as long as something reads them.
 * For a query that depends on state, derive it: `const todos = $derived(createQuery(canopy.live(...)))`.
 */
export function createQuery<T>(query: LiveQuery<T>): Query<T> {
  let state = query.getState()
  const track = createSubscriber((update) =>
    query.subscribe((next) => {
      state = next
      update()
    }),
  )
  const current = (): QueryState<T> => {
    track()
    return state
  }
  return {
    get data() {
      return current().data
    },
    get status() {
      return current().status
    },
    get error() {
      return current().error
    },
    get current() {
      return current()
    },
    subscribe: (run) =>
      query.subscribe((next) => {
        state = next
        run(next)
      }),
  }
}

/** The connection status, reactive like {@link createQuery}, with the store contract as well. */
export function canopyStatus<DB extends Schema<DB>>(
  client: CanopyClient<DB>,
): {
  readonly current: ConnectionStatus
  subscribe(run: (status: ConnectionStatus) => void): () => void
} {
  const track = createSubscriber((update) => client.onStatus(() => update()))
  return {
    get current() {
      track()
      return client.connectionStatus
    },
    subscribe(run) {
      run(client.connectionStatus)
      return client.onStatus(run)
    },
  }
}
