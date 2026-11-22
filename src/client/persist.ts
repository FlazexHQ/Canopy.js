import type { Persister, PersistScope } from "./client-types.ts"

const SCOPES: readonly PersistScope[] = ["mutations", "docs", "auth"]

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Stores the offline queue, the document cache and the auth session in IndexedDB, one object store per scope, in the
 * database `name` (`canopy` by default). Use one name per app and environment.
 */
export function indexedDbPersister(
  options: { readonly name?: string; readonly indexedDB?: IDBFactory } = {},
): Persister {
  let opened: Promise<IDBDatabase> | undefined
  const database = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB
      const request = factory.open(options.name ?? "canopy", 2)
      request.onupgradeneeded = () => {
        for (const scope of SCOPES)
          if (!request.result.objectStoreNames.contains(scope))
            request.result.createObjectStore(scope)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return opened
  }
  const store = async (scope: PersistScope, mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await database()).transaction(scope, mode).objectStore(scope)
  return {
    get: async (scope, key) => {
      const value: unknown = await settle((await store(scope, "readonly")).get(key))
      return typeof value === "string" ? value : undefined
    },
    set: async (scope, key, value) => {
      await settle((await store(scope, "readwrite")).put(value, key))
    },
    delete: async (scope, key) => {
      await settle((await store(scope, "readwrite")).delete(key))
    },
    entries: async (scope) => {
      const objects = await store(scope, "readonly")
      const [keys, values] = await Promise.all([
        settle(objects.getAllKeys()),
        settle(objects.getAll()),
      ])
      return keys.map((key, index) => [String(key), String(values[index])] as const)
    },
  }
}

/** Keeps everything in memory: for tests, server rendering, and runtimes without storage. */
export function memoryPersister(): Persister {
  const scopes = new Map<PersistScope, Map<string, string>>()
  const of = (scope: PersistScope): Map<string, string> => {
    let map = scopes.get(scope)
    if (map === undefined) {
      map = new Map()
      scopes.set(scope, map)
    }
    return map
  }
  return {
    get: async (scope, key) => of(scope).get(key),
    set: async (scope, key, value) => {
      of(scope).set(key, value)
    },
    delete: async (scope, key) => {
      of(scope).delete(key)
    },
    entries: async (scope) => [...of(scope)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  }
}

/** The part of React Native's `AsyncStorage` the persister uses. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  getAllKeys(): Promise<readonly string[]>
}

/** Stores entries in React Native's `AsyncStorage` (or anything with its API) under `prefix`. */
export function asyncStoragePersister(storage: AsyncStorageLike, prefix = "canopy:"): Persister {
  const full = (scope: PersistScope, key: string): string => `${prefix}${scope}:${key}`
  return {
    get: async (scope, key) => (await storage.getItem(full(scope, key))) ?? undefined,
    set: (scope, key, value) => storage.setItem(full(scope, key), value),
    delete: (scope, key) => storage.removeItem(full(scope, key)),
    entries: async (scope) => {
      const start = full(scope, "")
      const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(start)).sort()
      const out: (readonly [string, string])[] = []
      for (const key of keys) {
        const value = await storage.getItem(key)
        if (value !== null) out.push([key.slice(start.length), value])
      }
      return out
    },
  }
}

/** The part of `react-native-mmkv`'s `MMKV` instance the persister uses. */
export interface MmkvLike {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  getAllKeys(): readonly string[]
}

/** Stores entries in an MMKV instance (React Native) under `prefix`; MMKV is synchronous and fast. */
export function mmkvPersister(storage: MmkvLike, prefix = "canopy:"): Persister {
  const full = (scope: PersistScope, key: string): string => `${prefix}${scope}:${key}`
  return {
    get: async (scope, key) => storage.getString(full(scope, key)),
    set: async (scope, key, value) => storage.set(full(scope, key), value),
    delete: async (scope, key) => storage.delete(full(scope, key)),
    entries: async (scope) => {
      const start = full(scope, "")
      const out: (readonly [string, string])[] = []
      for (const key of [...storage.getAllKeys()].filter((name) => name.startsWith(start)).sort()) {
        const value = storage.getString(key)
        if (value !== undefined) out.push([key.slice(start.length), value])
      }
      return out
    },
  }
}
