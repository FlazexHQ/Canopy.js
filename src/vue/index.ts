import {
  type App,
  type InjectionKey,
  inject,
  type MaybeRefOrGetter,
  onScopeDispose,
  provide,
  type ShallowRef,
  shallowRef,
  toValue,
  watch,
} from "vue"

import type {
  CanopyClient,
  ConnectionStatus,
  DefaultSchema,
  DehydratedState,
  LiveQuery,
  MutationHandle,
  MutationResult,
  QueryState,
  QueryStatus,
  Schema,
} from "../client/index.ts"

const CANOPY: InjectionKey<CanopyClient> = Symbol("canopy")

/** Makes a client available to {@link useCanopy} and the composables below the component. */
export function provideCanopy<DB extends Schema<DB> = DefaultSchema>(
  client: CanopyClient<DB>,
): void {
  provide(CANOPY, client as unknown as CanopyClient)
}

/**
 * A Vue plugin that provides the client to the whole app: `app.use(canopyPlugin(canopy))`. With
 * `state`, the client is first hydrated with server rendered results (Nuxt: the payload `dehydrate()`
 * produced on the server).
 */
export function canopyPlugin<DB extends Schema<DB> = DefaultSchema>(
  client: CanopyClient<DB>,
  state?: DehydratedState,
): { install(app: App): void } {
  return {
    install(app) {
      if (state !== undefined) client.hydrate(state)
      app.provide(CANOPY, client as unknown as CanopyClient)
    },
  }
}

/**
 * Returns the provided client, typed by the registered schema. Code that cannot rely on it passes the
 * schema's types: `useCanopy<SchemaTypes<typeof schema>>()`.
 */
export function useCanopy<DB extends Schema<DB> = DefaultSchema>(): CanopyClient<DB> {
  const client = inject(CANOPY, undefined)
  if (client === undefined)
    throw new Error("useCanopy needs canopyPlugin(client) or provideCanopy(client) above it")
  return client as unknown as CanopyClient<DB>
}

/** The reactive state of a live query, from {@link useQuery}. */
export interface QueryRefs<T> {
  readonly data: ShallowRef<readonly T[]>
  readonly status: ShallowRef<QueryStatus>
  readonly error: ShallowRef<Error | undefined>
  /** The whole state, replaced on every change. */
  readonly state: ShallowRef<QueryState<T>>
}

/**
 * Follows a live query in `ShallowRef`s, stopped when the component (or effect scope) is disposed.
 * Pass a getter or a ref to follow a query that depends on reactive values; the subscription moves
 * when the query changes:
 *
 * ```ts
 * const { data } = useQuery(() => canopy.from("todos").find({ status: status.value }))
 * ```
 */
export function useQuery<T>(query: MaybeRefOrGetter<LiveQuery<T>>): QueryRefs<T> {
  const first = toValue(query)
  const state = shallowRef<QueryState<T>>(first.getState())
  const data = shallowRef(state.value.data)
  const status = shallowRef(state.value.status)
  const error = shallowRef(state.value.error)
  const update = (next: QueryState<T>): void => {
    state.value = next
    data.value = next.data
    status.value = next.status
    error.value = next.error
  }
  let stop: (() => void) | undefined
  const stopWatch = watch(
    () => toValue(query),
    (current) => {
      stop?.()
      stop = current.subscribe(update)
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    stopWatch()
    stop?.()
  })
  return { data, status, error, state }
}

/** The connection status as a ref: `connecting`, `live`, `fallback`, `reconnecting`, `offline` or `closed`. */
export function useCanopyStatus<DB extends Schema<DB> = DefaultSchema>(
  client: CanopyClient<DB> = useCanopy<DB>(),
): ShallowRef<ConnectionStatus> {
  const status = shallowRef(client.connectionStatus)
  const stop = client.onStatus((next) => {
    status.value = next
  })
  onScopeDispose(stop)
  return status
}

/** A mutation with its progress, from {@link useMutation}. */
export interface MutationRefs<Args extends unknown[]> {
  /** Starts the mutation; the optimistic change shows at once. Rejections are kept in `error`. */
  mutate(...args: Args): MutationHandle
  readonly pending: ShallowRef<boolean>
  readonly error: ShallowRef<Error | undefined>
  readonly result: ShallowRef<MutationResult | undefined>
}

/**
 * Wraps a mutation so templates can show its progress:
 * `const done = useMutation((id) => canopy.from("todos").update(id, { $set: { done: true } }))`.
 */
export function useMutation<Args extends unknown[]>(
  run: (...args: Args) => MutationHandle,
): MutationRefs<Args> {
  const pending = shallowRef(false)
  const error = shallowRef<Error | undefined>(undefined)
  const result = shallowRef<MutationResult | undefined>(undefined)
  let latest = 0
  return {
    pending,
    error,
    result,
    mutate(...args) {
      latest += 1
      const id = latest
      pending.value = true
      error.value = undefined
      const handle = run(...args)
      handle.then(
        (value) => {
          if (id !== latest) return
          pending.value = false
          result.value = value
        },
        (failure: unknown) => {
          if (id !== latest) return
          pending.value = false
          error.value = failure instanceof Error ? failure : new Error(String(failure))
        },
      )
      return handle
    },
  }
}
