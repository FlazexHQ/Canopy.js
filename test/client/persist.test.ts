import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it } from "vitest"

import type { Persister } from "../../src/client/index.ts"
import {
  type AsyncStorageLike,
  asyncStoragePersister,
  indexedDbPersister,
  memoryPersister,
} from "../../src/client/persist.ts"

class FakeAsyncStorage implements AsyncStorageLike {
  readonly map = new Map<string, string>()
  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key)
  }
  async getAllKeys(): Promise<readonly string[]> {
    return [...this.map.keys()]
  }
}

const kinds: [string, () => Persister][] = [
  ["memory", () => memoryPersister()],
  ["IndexedDB", () => indexedDbPersister({ indexedDB: new IDBFactory() })],
  ["AsyncStorage", () => asyncStoragePersister(new FakeAsyncStorage())],
]

describe.each(kinds)("%s persister", (_name, make) => {
  it("reads back what it stores and nothing it did not", async () => {
    const persister = make()
    expect(await persister.get("mutations", "a")).toBeUndefined()
    await persister.set("mutations", "a", "one")
    await persister.set("mutations", "a", "two")
    expect(await persister.get("mutations", "a")).toBe("two")
    await persister.delete("mutations", "a")
    expect(await persister.get("mutations", "a")).toBeUndefined()
    await persister.delete("mutations", "missing")
  })

  it("lists a scope in key order, which is the order of UUIDv7 mutation IDs", async () => {
    const persister = make()
    const keys = [
      "alice\u00000192f6a1-7c2e-7b1a-9d3e-000000000003",
      "alice\u00000192f6a1-7c2e-7b1a-9d3e-000000000001",
      "bob\u00000192f6a1-7c2e-7b1a-9d3e-000000000002",
      "alice\u00000192f6a1-7c2e-7b1a-9d3e-000000000002",
    ]
    for (const key of keys) await persister.set("mutations", key, `v:${key}`)
    const entries = await persister.entries("mutations")
    expect(entries.map(([key]) => key)).toEqual([...keys].sort())
    expect(entries.every(([key, value]) => value === `v:${key}`)).toBe(true)
  })

  it("keeps scopes apart", async () => {
    const persister = make()
    await persister.set("mutations", "k", "m")
    await persister.set("docs", "k", "d")
    expect(await persister.get("docs", "k")).toBe("d")
    expect(await persister.entries("docs")).toEqual([["k", "d"]])
    await persister.delete("docs", "k")
    expect(await persister.get("mutations", "k")).toBe("m")
  })
})

describe("IndexedDB persister", () => {
  it("survives a new persister over the same database, as after a reload", async () => {
    const factory = new IDBFactory()
    await indexedDbPersister({ indexedDB: factory, name: "app" }).set("mutations", "k", "v")
    expect(
      await indexedDbPersister({ indexedDB: factory, name: "app" }).get("mutations", "k"),
    ).toBe("v")
    expect(
      await indexedDbPersister({ indexedDB: factory, name: "other" }).get("mutations", "k"),
    ).toBeUndefined()
  })
})

describe("AsyncStorage persister", () => {
  it("only touches keys under its prefix", async () => {
    const storage = new FakeAsyncStorage()
    storage.map.set("unrelated", "x")
    storage.map.set("canopy:docs:old", "y")
    const persister = asyncStoragePersister(storage)
    await persister.set("mutations", "k", "v")
    expect(storage.map.get("canopy:mutations:k")).toBe("v")
    expect(await persister.entries("mutations")).toEqual([["k", "v"]])
    expect(await persister.entries("docs")).toEqual([["old", "y"]])
    expect(storage.map.get("unrelated")).toBe("x")
  })
})

describe.each(kinds)("%s persister, auth scope", (_name, make) => {
  it("keeps the auth session apart from the other scopes", async () => {
    const persister = make()
    await persister.set("auth", "session", "s")
    await persister.set("mutations", "session", "m")
    expect(await persister.get("auth", "session")).toBe("s")
    expect(await persister.entries("auth")).toEqual([["session", "s"]])
    await persister.delete("auth", "session")
    expect(await persister.get("auth", "session")).toBeUndefined()
    expect(await persister.get("mutations", "session")).toBe("m")
  })
})

describe("indexedDbPersister upgrades", () => {
  it("adds the auth store to a database created by the first version, keeping its data", async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("canopy", 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore("mutations")
        request.result.createObjectStore("docs")
      }
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction("mutations", "readwrite")
        tx.objectStore("mutations").put("kept", "m1")
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
      }
      request.onerror = () => reject(request.error)
    })
    const persister = indexedDbPersister({ indexedDB: factory })
    expect(await persister.get("mutations", "m1")).toBe("kept")
    await persister.set("auth", "session", "token")
    expect(await persister.get("auth", "session")).toBe("token")
  })
})
