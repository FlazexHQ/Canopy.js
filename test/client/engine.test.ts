import { InvalidQueryError } from "canopy.js/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { loadEngine } from "../../src/client/engine.ts"
import { freshGraph } from "../support/fresh.ts"

const owned = ["client", "react", "vue", "svelte", "solid", "tanstack-db", "devtools"]
const sources = import.meta.glob<string>(
  "../../src/{client,react,vue,svelte,solid,tanstack-db,devtools}/**/*.{ts,tsx,svelte}",
  { query: "?raw", import: "default", eager: true },
)

const flush = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await Promise.resolve()
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the client core", () => {
  it("renders the first snapshot in server order without loading the core", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    expect(engine.loadedEngine()).toBeUndefined()
    const store = new fresh.Store()
    store.addQuery("other", "todos", {})
    store.added("todos", 2, { _id: 2, rank: 1, done: false }, "1", ["other"])
    store.addQuery("q", "todos", { filter: { done: false }, sort: { rank: -1 } })
    store.added("todos", 1, { _id: 1, rank: 5, done: false }, "1", ["q"])
    store.added("todos", 3, { _id: 3, rank: 4, done: false }, "1", ["q"])
    store.added("todos", 2, undefined, "1", ["q"])
    store.ready("q")
    let notified = 0
    store.listen("q", () => {
      notified += 1
    })
    await flush()
    expect(store.state("q").status).toBe("stale")
    expect(store.state("q").data.map((doc) => doc["_id"])).toEqual([1, 3, 2])
    expect(notified).toBe(1)
    expect(engine.loadedEngine()).toBeUndefined()
    await store.loadCore()
    expect(store.state("q").status).toBe("ready")
    expect(store.state("q").data.map((doc) => doc["_id"])).toEqual([1, 3, 2])
  })

  it("keeps server order for a snapshot resubscribed before any member arrived", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", { sort: { rank: -1 } })
    store.beginResync("q")
    store.added("todos", 1, { _id: 1, rank: 5 }, "1", ["q"])
    store.added("todos", 3, { _id: 3, rank: 4 }, "1", ["q"])
    store.added("todos", 2, { _id: 2, rank: 1 }, "1", ["q"])
    store.ready("q")
    await flush()
    expect(store.state("q").status).toBe("stale")
    expect(store.state("q").data.map((doc) => doc["_id"])).toEqual([1, 3, 2])
    expect(engine.loadedEngine()).toBeUndefined()
  })

  it("loads the core after the first live query has painted", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", {})
    store.listen("q", () => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(engine.loadedEngine()).toBeUndefined()
    store.added("todos", 1, { _id: 1 }, "1", ["q"])
    store.ready("q")
    await vi.waitFor(() => expect(engine.loadedEngine()).toBeDefined(), { timeout: 5000 })
  })

  it("supports immediate optimistic membership changes when the first query becomes ready", async () => {
    const graph = freshGraph()
    const { Store } =
      await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const { loadedEngine } =
      await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    vi.stubGlobal("requestAnimationFrame", () => 1)
    const store = new Store()
    store.addQuery("open", "todos", { filter: { done: false }, sort: { rank: 1 } })
    store.addQuery("done", "todos", { filter: { done: true }, sort: { rank: 1 } })
    store.ready("open")
    store.ready("done")

    expect(loadedEngine()).toBeUndefined()
    await vi.waitFor(() => expect(store.state("open").status).toBe("ready"), { timeout: 5000 })
    store.addLayer("insert", {
      kind: "insert",
      coll: "todos",
      id: 1,
      doc: { _id: 1, done: false, rank: 1 },
    })
    expect(store.state("open").data).toEqual([{ _id: 1, done: false, rank: 1 }])
    store.addLayer("update", {
      kind: "update",
      coll: "todos",
      id: 1,
      update: { $set: { done: true } },
    })
    expect(store.state("open").data).toEqual([])
    expect(store.state("done").data).toEqual([{ _id: 1, done: true, rank: 1 }])
  })

  it("holds a query whose member changed under its sort until the core sorts it", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", { sort: { rank: -1 } })
    store.added("todos", 1, { _id: 1, rank: 3 }, "1", ["q"])
    store.added("todos", 2, { _id: 2, rank: 2 }, "1", ["q"])
    store.ready("q")
    await flush()
    const first = store.state("q")
    expect(first.data.map((doc) => doc["_id"])).toEqual([1, 2])
    store.changed("todos", 2, "2", { set: { rank: 9 } })
    await flush()
    expect(engine.loadedEngine()).toBeUndefined()
    expect(store.state("q")).toBe(first)
    await store.loadCore()
    await flush()
    expect(store.state("q").data.map((doc) => doc["_id"])).toEqual([2, 1])
    expect(store.state("q").data.map((doc) => doc["rank"])).toEqual([9, 3])
  })

  it("holds a member added after the snapshot until the core places it", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", { sort: { rank: -1 } })
    store.added("todos", 1, { _id: 1, rank: 3 }, "1", ["q"])
    store.added("todos", 2, { _id: 2, rank: 2 }, "1", ["q"])
    store.ready("q")
    await flush()
    const first = store.state("q")
    expect(first.data.map((doc) => doc["_id"])).toEqual([1, 2])
    store.added("todos", 3, { _id: 3, rank: 2.5 }, "3", ["q"])
    await flush()
    expect(engine.loadedEngine()).toBeUndefined()
    expect(store.state("q")).toBe(first)
    await store.loadCore()
    await flush()
    expect(store.state("q").data.map((doc) => doc["_id"])).toEqual([1, 3, 2])
    expect(store.state("q").data.map((doc) => doc["rank"])).toEqual([3, 2.5, 2])
  })

  it("keeps rendering in server order when a change cannot move a member", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", {})
    store.added("todos", "b", { _id: "b", n: 1 }, "1", ["q"])
    store.added("todos", "c", { _id: "c", n: 1 }, "1", ["q"])
    store.ready("q")
    await flush()
    store.changed("todos", "b", "2", { set: { n: 7 } })
    store.removed("todos", "c", "3", ["q"])
    await flush()
    expect(engine.loadedEngine()).toBeUndefined()
    expect(store.state("q").data).toEqual([{ _id: "b", n: 7 }])
  })

  it("holds a resync and an optimistic change until the core arrives", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", { filter: { done: true } })
    store.addQuery("all", "todos", {})
    store.added("todos", 1, { _id: 1, done: false, n: 1 }, "10", ["all"])
    store.ready("q")
    store.ready("all")
    await flush()
    const held = store.state("q")
    expect(held.data).toEqual([])
    store.addLayer("m1", { kind: "update", coll: "todos", id: 1, update: { $set: { done: true } } })
    store.addLayer("m2", { kind: "insert", coll: "todos", id: 2, doc: { _id: 2, done: true } })
    store.beginResync("all")
    await flush()
    expect(engine.loadedEngine()).toBeUndefined()
    expect(store.view("todos", 1)).toEqual({ _id: 1, done: false, n: 1 })
    expect(store.state("q")).toBe(held)
    let notified = 0
    store.listen("q", () => {
      notified += 1
    })
    await store.loadCore()
    await flush()
    expect(store.view("todos", 1)).toEqual({ _id: 1, done: true, n: 1 })
    expect(store.state("q").data.map((doc) => doc["_id"])).toEqual([1, 2])
    expect(store.state("all").data.map((doc) => doc["_id"])).toEqual([1, 2])
    expect(notified).toBe(1)
    store.dropLayer("m1")
    expect(store.view("todos", 1)).toEqual({ _id: 1, done: false, n: 1 })
  })

  it("renders a projected query once the core it starts loading arrives", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", { fields: { title: 1 } })
    store.added("todos", 1, { _id: 1, title: "a", body: "long" }, "1", ["q"])
    store.ready("q")
    await flush()
    expect(store.state("q").status).toBe("loading")
    await vi.waitFor(() => expect(engine.loadedEngine()).toBeDefined(), { timeout: 5000 })
    await flush()
    expect(store.state("q").data).toEqual([{ _id: 1, title: "a" }])
  })

  it("renders cached documents in their order, then holds the snapshot until the core arrives", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", { sort: { rank: 1 } })
    store.seed("q", [
      { id: 2, doc: { _id: 2, rank: 1 }, ct: "1" },
      { id: 1, doc: { _id: 1, rank: 2 }, ct: "1" },
    ])
    await flush()
    const seeded = store.state("q")
    expect(seeded.status).toBe("stale")
    expect(seeded.data.map((doc) => doc["_id"])).toEqual([2, 1])
    store.added("todos", 1, { _id: 1, rank: 0 }, "2", ["q"])
    store.added("todos", 2, undefined, "2", ["q"])
    store.ready("q")
    await flush()
    expect(engine.loadedEngine()).toBeUndefined()
    expect(store.state("q")).toBe(seeded)
    await store.loadCore()
    await flush()
    expect(store.state("q").status).toBe("ready")
    expect(store.state("q").data.map((doc) => doc["_id"])).toEqual([1, 2])
  })

  it("fails a query whose filter is invalid when the core arrives", async () => {
    const graph = freshGraph()
    const fresh = await graph.load<typeof import("../../src/client/store.ts")>("client/store.ts")
    const engine = await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const store = new fresh.Store()
    store.addQuery("q", "todos", { filter: { a: { $bogus: 1 } } })
    await engine.loadEngine()
    await flush()
    const state = store.state("q")
    expect(state.status).toBe("error")
    expect(state.error).toBeInstanceOf(InvalidQueryError)
  })

  it("throws for an invalid filter or sort once loaded, and predicts with supported filters", async () => {
    const { Store } = await import("../../src/client/store.ts")
    const store = new Store()
    expect(() => store.addQuery("bad", "todos", { filter: { a: { $bogus: 1 } } })).toThrow(
      InvalidQueryError,
    )
    expect(() => store.addQuery("sort", "todos", { sort: { a: 2 as 1 } })).toThrow(
      InvalidQueryError,
    )
    store.addQuery("q", "todos", { filter: { title: { $regex: "^a" } } })
    store.added("todos", 1, { _id: 1, title: "abc" }, "1", ["q"])
    store.ready("q")
    store.addLayer("m1", {
      kind: "replace",
      coll: "todos",
      id: 1,
      doc: { title: "xyz" },
      upsert: false,
    })
    await flush()
    expect(store.state("q").data).toEqual([])
    store.dropLayer("m1")
    await flush()
    expect(store.state("q").data.map((doc) => doc["_id"])).toEqual([1])
  })

  it("falls back to the JavaScript translation when WebAssembly may not compile", async () => {
    const graph = freshGraph()
    const { WebAssembly: host } = globalThis as unknown as {
      readonly WebAssembly: {
        instantiate(...args: unknown[]): Promise<unknown>
        instantiateStreaming(...args: unknown[]): Promise<unknown>
        readonly CompileError: new (message: string) => Error
      }
    }
    const refusal = () => Promise.reject(new host.CompileError("Refused to compile WebAssembly"))
    vi.spyOn(host, "instantiate").mockImplementation(refusal)
    vi.spyOn(host, "instantiateStreaming").mockImplementation(refusal)
    const { loadEngine: fresh } =
      await graph.load<typeof import("../../src/client/engine.ts")>("client/engine.ts")
    const engine = await fresh()
    expect(engine.kind).toBe("js")
    const filter = engine.compileFilter({ n: { $gt: 1 } })
    expect(filter.matchAll([{ n: 2 }, { n: 1 }, { m: 3 }])).toEqual([true, false, false])
    filter.free()
  })

  it("preserves order with new documents and repeated retained documents", async () => {
    const engine = await loadEngine()
    const filter = engine.compileFilter({ n: { $gt: 1 } })
    const kept = { n: 2 }
    const missed = { n: 1 }
    try {
      expect(filter.matchAll([kept, missed, kept])).toEqual([true, false, true])
      expect(filter.matchAll([missed, { n: 3 }, kept, kept, { n: 0 }])).toEqual([
        false,
        true,
        true,
        true,
        false,
      ])
      expect(filter.matchAll([kept, missed, kept])).toEqual([true, false, true])
    } finally {
      filter.free()
    }
  })

  it("decides retained documents by their current position when a page is reordered, swapped in place, resized or replaced", async () => {
    const engine = await loadEngine()
    const owner = engine.compileFilter({ ownerId: "u1" })
    const big = engine.compileFilter({ n: { $gt: 1 } })
    const a = { ownerId: "u1", n: 0 }
    const b = { ownerId: "u2", n: 5 }
    const c = { ownerId: "u1", n: 9 }
    const page = [a, b, c]
    try {
      for (let round = 0; round < 3; round += 1) {
        expect(owner.matchAll(page)).toEqual([true, false, true])
        expect(big.matchAll(page)).toEqual([false, true, true])
      }
      page[0] = b
      page[1] = a
      expect(owner.matchAll(page)).toEqual([false, true, true])
      expect(big.matchAll(page)).toEqual([true, false, true])
      expect(owner.matchAll([c, b])).toEqual([true, false])
      expect(owner.matchAll([c, b, a, a])).toEqual([true, false, true, true])
      expect(owner.matchAll([c])).toEqual([true])
      const replaced = { ownerId: "u2", n: 0 }
      expect(owner.matchAll([replaced, b, a])).toEqual([false, false, true])
      expect(owner.matchAll([replaced, b, a])).toEqual([false, false, true])
      expect(owner.matchAll([replaced, b, a])).toEqual([false, false, true])
      expect(owner.matchAll([a, b, c])).toEqual([true, false, true])
    } finally {
      owner.free()
      big.free()
    }
  })

  it("translates refusals of the core into client errors", async () => {
    const engine = await loadEngine()
    expect(() => engine.compileFilter({ $where: "true" })).toThrow(InvalidQueryError)
    expect(() => engine.applyUpdate({ _id: 1, n: "x" }, { $inc: { n: 1 } })).toThrow(
      InvalidQueryError,
    )
    expect(() => engine.sortOrder({ a: 1 }, [{ _id: 1, a: [1, 2], b: [1] }])).not.toThrow()
    expect(() => engine.sortOrder({ a: 1, b: 1 }, [{ _id: 1, a: [1, 2], b: [1, 2] }])).toThrow(
      InvalidQueryError,
    )
  })

  it("keeps values the client uses through an update", async () => {
    const engine = await loadEngine()
    const at = new Date("2031-01-01T00:00:00.000Z")
    const updated = engine.applyUpdate(
      { _id: 1, n: 2_147_483_647, at, tags: ["a"] },
      { $inc: { n: 1 }, $push: { tags: "b" }, $set: { "nested.x": 1.5 } },
    )
    expect(updated["n"]?.constructor.name).toBe("Long")
    expect(String(updated["n"])).toBe("2147483648")
    expect(updated["at"]).toEqual(at)
    expect(updated["tags"]).toEqual(["a", "b"])
    expect(updated["nested"]).toEqual({ x: 1.5 })
  })

  it("applies updates to kept documents and leaves every earlier version as it was", async () => {
    const engine = await loadEngine()
    const original = { _id: "n1", title: "a note", n: 1, meta: { seen: false, by: "ada" } }
    const first = engine.applyUpdate(original, {
      $set: { title: "edited", "meta.seen": true },
      $inc: { n: 1 },
    })
    expect(Object.keys(first)).toEqual(["_id", "title", "n", "meta"])
    expect(first).toEqual({ _id: "n1", title: "edited", n: 2, meta: { seen: true, by: "ada" } })
    expect(original).toEqual({ _id: "n1", title: "a note", n: 1, meta: { seen: false, by: "ada" } })
    const second = engine.applyUpdate(first, { $inc: { n: 5 } })
    expect(second).toEqual({ _id: "n1", title: "edited", n: 7, meta: { seen: true, by: "ada" } })
    expect(second["meta"]).toBe(first["meta"])
    const branch = engine.applyUpdate(original, { $inc: { n: 10 } })
    expect(branch).toEqual({ _id: "n1", title: "a note", n: 11, meta: { seen: false, by: "ada" } })
    expect(engine.applyUpdate(first, { $set: { title: "again" } })["n"]).toBe(2)
  })

  it("orders the fields as MongoDB does when an update adds, removes or renames them", async () => {
    const engine = await loadEngine()
    const doc = { _id: 1, b: 1, a: 2 }
    const added = engine.applyUpdate(doc, { $set: { d: 1, c: 2 } })
    expect(Object.keys(added)).toEqual(["_id", "b", "a", "c", "d"])
    expect(added).toEqual({ _id: 1, b: 1, a: 2, c: 2, d: 1 })
    const removed = engine.applyUpdate(doc, { $unset: { b: "" } })
    expect(Object.keys(removed)).toEqual(["_id", "a"])
    const renamed = engine.applyUpdate(doc, { $rename: { b: "z" } })
    expect(Object.keys(renamed)).toEqual(["_id", "a", "z"])
    expect(renamed["z"]).toBe(1)
    const replaced = engine.applyUpdate(doc, { x: 1 })
    expect(Object.keys(replaced)).toEqual(["_id", "x"])
    expect(replaced).toEqual({ _id: 1, x: 1 })
  })

  it("sends a document again once the core has dropped it for newer ones", async () => {
    const engine = await loadEngine()
    const original = { _id: "n1", title: "a note", n: 1 }
    const first = engine.applyUpdate(original, { $inc: { n: 1 } })
    let other: Record<string, unknown> = { _id: "n2", n: 0 }
    for (let index = 0; index < 600; index += 1)
      other = engine.applyUpdate(other, { $inc: { n: 1 } })
    expect(other).toEqual({ _id: "n2", n: 600 })
    expect(engine.applyUpdate(original, { $set: { title: "edited" } })).toEqual({
      _id: "n1",
      title: "edited",
      n: 1,
    })
    expect(engine.applyUpdate(first, { $inc: { n: 10 } })).toEqual({
      _id: "n1",
      title: "a note",
      n: 12,
    })
    expect(() => engine.applyUpdate(first, { $inc: { title: 1 } })).toThrow(InvalidQueryError)
    expect(engine.applyUpdate(first, { $unset: { title: "" } })).toEqual({ _id: "n1", n: 2 })
  })

  it("keeps a document usable after an update MongoDB would refuse", async () => {
    const engine = await loadEngine()
    const doc = { _id: 1, n: "x", m: 1 }
    expect(() => engine.applyUpdate(doc, { $inc: { n: 1 } })).toThrow(InvalidQueryError)
    expect(() => engine.applyUpdate(doc, { $set: { _id: 2 } })).toThrow(InvalidQueryError)
    expect(engine.applyUpdate(doc, { $inc: { m: 1 } })).toEqual({ _id: 1, n: "x", m: 2 })
  })
})

describe("the client sources", () => {
  it("import no TypeScript implementation of the matcher, query, policy, schema or config, nor the authoring module", () => {
    const files = Object.entries(sources)
    for (const folder of owned)
      expect(
        files.some(([path]) => path.startsWith(`../../src/${folder}/`)),
        folder,
      ).toBe(true)
    const offending = files
      .filter(([, text]) =>
        /core\/(matcher|query|policy|schema|config)\/|\.\.\/(schema|policy|emit)\/|wasm\/authoring/.test(
          text,
        ),
      )
      .map(([path]) => path)
    expect(offending).toEqual([])
  })
})
