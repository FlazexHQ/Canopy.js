import {
  type Accessor,
  createComputed,
  createContext,
  createSignal,
  type JSX,
  onCleanup,
  useContext,
} from "solid-js"

import type {
  CanopyClient,
  ConnectionStatus,
  DefaultSchema,
  LiveQuery,
  QueryState,
  QueryStatus,
  Schema,
} from "../client/index.ts"

/** The context the client is provided through, usually by {@link CanopyProvider}. */
export const CanopyContext = createContext<CanopyClient | undefined>(undefined)

/** Props of {@link CanopyProvider}. */
export interface CanopyProviderProps<DB extends Schema<DB>> {
  readonly client: CanopyClient<DB>
  readonly children?: JSX.Element
}

/** Provides a client, typed or not, to {@link useCanopy} in the components below it. */
export function CanopyProvider<DB extends Schema<DB>>(props: CanopyProviderProps<DB>): JSX.Element {
  return CanopyContext.Provider({
    value: props.client as unknown as CanopyClient,
    get children() {
      return props.children
    },
  })
}

/**
 * Returns the client from {@link CanopyContext}, typed by the registered schema. Code that cannot rely on it
 * passes the schema's types: `useCanopy<SchemaTypes<typeof schema>>()`.
 */
export function useCanopy<DB extends Schema<DB> = DefaultSchema>(): CanopyClient<DB> {
  const client = useContext(CanopyContext)
  if (client === undefined) throw new Error("useCanopy needs <CanopyProvider client={client}>")
  return client as unknown as CanopyClient<DB>
}

/** A live query as signals, from {@link createQuery}. */
export interface QuerySignals<T> {
  readonly data: Accessor<readonly T[]>
  readonly status: Accessor<QueryStatus>
  readonly error: Accessor<Error | undefined>
  /** The whole state. */
  readonly state: Accessor<QueryState<T>>
}

/**
 * Follows a live query with signals, for as long as the owning component or root lives. Pass an
 * accessor to follow a query that depends on other signals; the subscription moves when it changes:
 *
 * ```ts
 * const todos = createQuery(() => canopy.from("todos").find({ status: status() }))
 * ```
 */
export function createQuery<T>(query: LiveQuery<T> | Accessor<LiveQuery<T>>): QuerySignals<T> {
  const read = typeof query === "function" ? query : () => query
  const [state, setState] = createSignal<QueryState<T>>(read().getState(), { equals: false })
  createComputed(() => {
    const current = read()
    const stop = current.subscribe((next) => setState(() => next))
    onCleanup(stop)
  })
  return {
    state,
    data: () => state().data,
    status: () => state().status,
    error: () => state().error,
  }
}

/** The connection status as a signal. */
export function createCanopyStatus<DB extends Schema<DB> = DefaultSchema>(
  client: CanopyClient<DB> = useCanopy<DB>(),
): Accessor<ConnectionStatus> {
  const [status, setStatus] = createSignal(client.connectionStatus)
  onCleanup(client.onStatus((next) => setStatus(() => next)))
  return status
}
