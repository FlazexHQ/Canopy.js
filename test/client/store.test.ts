import type { Document } from "canopy.js/protocol"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Store } from "../../src/client/index.ts"
import { applyUpdate } from "../../src/core/matcher/index.ts"

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function ids(store: Store, query: string): unknown[] {
  return store.state(query).data.map((doc) => doc["_id"])
}

function setup(spec: Parameters<Store["addQuery"]>[2] = {}): Store {
  const store = new Store(Date.now, applyUpdate)
  store.addQuery("q", "todos", spec)
  return store
}

afterEach(() => {
  vi.useRealTimers()
})

describe("optimistic layers", () => {
  it("shows update layers once the lazily loaded update engine arrives", async () => {
    const store = new Store()
    store.addQuery("q", "todos", { filter: { done: true } })
    store.addQuery("all", "todos", {})
    store.added("todos", 1, { _id: 1, done: false, n: 1 }, "10", ["all"])
    store.addLayer("m1", { kind: "update", coll: "todos", id: 1, update: { $set: { done: true } } })
    store.addLayer("m2", { kind: "insert", coll: "todos", id: 2, doc: { _id: 2, done: true } })
    await flush()
    expect(store.view("todos", 1)).toEqual({ _id: 1, done: false, n: 1 })
    expect(ids(store, "q")).toEqual([2])
    let notified = 0
    store.listen("q", () => {
      notified += 1
    })
    store.useUpdater(applyUpdate)
    await flush()
    expect(store.view("todos", 1)).toEqual({ _id: 1, done: true, n: 1 })
    expect(ids(store, "q")).toEqual([1, 2])
    expect(notified).toBeGreaterThan(0)
    store.dropLayer("m1")
    expect(store.view("todos", 1)).toEqual({ _id: 1, done: false, n: 1 })
  })

  it("shows an optimistic insert in matching queries only, and removes it on rollback", () => {
    const store = setup({ filter: { status: "active" } })
    store.addQuery("done", "todos", { filter: { status: "done" } })
    store.addLayer("m1", {
      kind: "insert",
      coll: "todos",
      id: 1,
      doc: { _id: 1, status: "active" },
    })
    expect(ids(store, "q")).toEqual([1])
    expect(ids(store, "done")).toEqual([])
    store.dropLayer("m1")
    expect(ids(store, "q")).toEqual([])
    expect(store.size).toBe(0)
  })

  it("rebases a pending update on top of a newer server state", () => {
    const store = setup()
    store.added("todos", 1, { _id: 1, n: 1 }, "10", ["q"])
    store.addLayer("m1", { kind: "update", coll: "todos", id: 1, update: { $inc: { n: 1 } } })
    expect(store.view("todos", 1)).toEqual({ _id: 1, n: 2 })
    store.changed("todos", 1, "11", { set: { n: 5 } })
    expect(store.view("todos", 1)).toEqual({ _id: 1, n: 6 })
    expect(store.serverState("todos", 1)).toEqual({ _id: 1, n: 5 })
    store.dropLayer("m1")
    expect(store.view("todos", 1)).toEqual({ _id: 1, n: 5 })
  })

  it("applies layers oldest first", () => {
    const store = setup()
    store.added("todos", 1, { _id: 1, n: 2 }, "10", ["q"])
    store.addLayer("a", { kind: "update", coll: "todos", id: 1, update: { $mul: { n: 3 } } })
    store.addLayer("b", { kind: "update", coll: "todos", id: 1, update: { $inc: { n: 1 } } })
    expect(store.view("todos", 1)).toEqual({ _id: 1, n: 7 })
    store.dropLayer("a")
    expect(store.view("todos", 1)).toEqual({ _id: 1, n: 3 })
  })

  it("hides a deleted document and restores it on rollback", () => {
    const store = setup()
    store.added("todos", 1, { _id: 1 }, "10", ["q"])
    store.addLayer("m", { kind: "delete", coll: "todos", id: 1 })
    expect(ids(store, "q")).toEqual([])
    store.dropLayer("m")
    expect(ids(store, "q")).toEqual([1])
  })

  it("predicts membership only for documents touched by pending layers", () => {
    const store = setup({ filter: { status: "active" } })
    store.addQuery("done", "todos", { filter: { status: "done" } })
    store.added("todos", 1, { _id: 1, status: "active" }, "10", ["q"])
    store.added("todos", 2, { _id: 2, status: "done" }, "10", ["q"])
    expect(ids(store, "q")).toEqual([1, 2])
    store.addLayer("m", {
      kind: "update",
      coll: "todos",
      id: 1,
      update: { $set: { status: "done" } },
    })
    expect(ids(store, "q")).toEqual([2])
    expect(ids(store, "done")).toEqual([1])
  })

  it("keeps server membership for queries it cannot evaluate or that project fields", () => {
    const store = setup({ filter: { title: { $regex: "^(a)\\1" } } })
    store.addQuery("p", "todos", {
      filter: { status: "active" },
      project: (doc) => ({ _id: doc["_id"] }),
    })
    store.added("todos", 1, { _id: 1, title: "aab", status: "active" }, "10", ["q", "p"])
    store.addLayer("m", {
      kind: "update",
      coll: "todos",
      id: 1,
      update: { $set: { title: "x", status: "x" } },
    })
    expect(ids(store, "q")).toEqual([1])
    expect(store.state("q").data[0]).toEqual({ _id: 1, title: "x", status: "x" })
    expect(store.state("p").data).toEqual([{ _id: 1 }])
    store.addLayer("i", {
      kind: "insert",
      coll: "todos",
      id: 2,
      doc: { _id: 2, title: "aac", status: "active" },
    })
    expect(ids(store, "q")).toEqual([1])
  })

  it("sorts and limits the predicted result", () => {
    const store = setup({ filter: {}, sort: { n: -1 }, limit: 2 })
    store.added("todos", 1, { _id: 1, n: 1 }, "10", ["q"])
    store.added("todos", 2, { _id: 2, n: 2 }, "10", ["q"])
    store.addLayer("m", { kind: "insert", coll: "todos", id: 3, doc: { _id: 3, n: 3 } })
    expect(ids(store, "q")).toEqual([3, 2])
  })

  it("applies bulk layers to every cached document matching their filter", () => {
    const store = setup({ filter: { done: false } })
    store.added("todos", 1, { _id: 1, done: false }, "10", ["q"])
    store.added("todos", 2, { _id: 2, done: false, keep: true }, "10", ["q"])
    store.addLayer("m", {
      kind: "updateMany",
      coll: "todos",
      filter: { keep: { $ne: true } },
      update: { $set: { done: true } },
    })
    expect(ids(store, "q")).toEqual([2])
    store.addLayer("d", { kind: "deleteMany", coll: "todos", filter: { keep: true } })
    expect(ids(store, "q")).toEqual([])
  })

  it("keeps an unrelated document's identity when layers change", () => {
    const store = setup()
    store.added("todos", 1, { _id: 1, n: 1 }, "10", ["q"])
    store.added("todos", 2, { _id: 2, n: 1 }, "10", ["q"])
    const before = store.state("q").data
    store.addLayer("m", { kind: "update", coll: "todos", id: 1, update: { $inc: { n: 1 } } })
    const after = store.state("q").data
    expect(after[1]).toBe(before[1])
    expect(after[0]).not.toBe(before[0])
    store.addLayer("noop", { kind: "update", coll: "todos", id: 1, update: { $set: { n: 2 } } })
    expect(store.state("q").data[0]).toBe(after[0])
  })

  it("ignores server messages older than the cached state", () => {
    const store = setup()
    store.added("todos", 1, { _id: 1, n: 2 }, "20", ["q"])
    store.changed("todos", 1, "19", { set: { n: 1 } })
    expect(store.view("todos", 1)).toEqual({ _id: 1, n: 2 })
  })

  it("notifies listeners once per microtask batch", async () => {
    const store = setup()
    const listener = vi.fn()
    store.listen("q", listener)
    store.addLayer("a", { kind: "insert", coll: "todos", id: 1, doc: { _id: 1 } })
    store.addLayer("b", { kind: "insert", coll: "todos", id: 2, doc: { _id: 2 } })
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("acks without echo", () => {
  it("trusts confirmed post images and predicts membership until the server catches up", () => {
    vi.useFakeTimers()
    const store = setup({ filter: { status: "active" } })
    store.addLayer("m", { kind: "insert", coll: "todos", id: 1, doc: { _id: 1, status: "active" } })
    store.confirm("todos", 1, { _id: 1, status: "active", at: 5 }, "30")
    store.dropLayer("m")
    expect(store.state("q").data).toEqual([{ _id: 1, status: "active", at: 5 }])
    store.added("todos", 1, { _id: 1, status: "active", at: 5 }, "30", [])
    expect(ids(store, "q")).toEqual([])
    store.added("todos", 1, undefined, "30", ["q"])
    expect(ids(store, "q")).toEqual([1])
  })

  it("stops predicting confirmed documents after the grace period", () => {
    vi.useFakeTimers()
    let now = 0
    const store = new Store(() => now, applyUpdate)
    store.addQuery("q", "todos", { filter: {} })
    store.confirm("todos", 1, { _id: 1 }, "30")
    expect(ids(store, "q")).toEqual([1])
    now = 6000
    vi.advanceTimersByTime(6000)
    expect(ids(store, "q")).toEqual([])
  })

  it("records a confirmed delete as a tombstone that stale messages cannot undo", () => {
    const store = setup()
    store.added("todos", 1, { _id: 1 }, "10", ["q"])
    store.confirm("todos", 1, null, "20")
    expect(ids(store, "q")).toEqual([])
    store.changed("todos", 1, "15", { set: { x: 1 } })
    expect(store.view("todos", 1)).toBeUndefined()
  })

  it("keeps a bulk layer until every touched document reaches the ack time", () => {
    vi.useFakeTimers()
    const store = setup({ filter: {} })
    store.added("todos", 1, { _id: 1, n: 0 }, "10", ["q"])
    store.added("todos", 2, { _id: 2, n: 0 }, "10", ["q"])
    store.added("todos", 3, { _id: 3, n: 0, skip: true }, "10", ["q"])
    store.addLayer("m", {
      kind: "updateMany",
      coll: "todos",
      filter: { skip: { $ne: true } },
      update: { $inc: { n: 1 } },
    })
    store.awaitServer("m", "20")
    expect(store.hasLayer("m")).toBe(true)
    store.changed("todos", 1, "20", { set: { n: 1 } })
    expect(store.hasLayer("m")).toBe(true)
    store.changed("todos", 2, "21", { set: { n: 1 } })
    expect(store.hasLayer("m")).toBe(false)
    expect(store.state("q").data.map((doc) => doc["n"])).toEqual([1, 1, 0])
  })

  it("drops a waiting bulk layer after the timeout and asks for a refetch", () => {
    vi.useFakeTimers()
    const store = setup({ filter: {} })
    const refetch = vi.fn()
    store.onRefetch = refetch
    store.added("todos", 1, { _id: 1, n: 0 }, "10", ["q"])
    store.addLayer("m", {
      kind: "updateMany",
      coll: "todos",
      filter: {},
      update: { $inc: { n: 1 } },
    })
    store.awaitServer("m", "20", 5000)
    vi.advanceTimersByTime(4999)
    expect(store.hasLayer("m")).toBe(true)
    vi.advanceTimersByTime(1)
    expect(store.hasLayer("m")).toBe(false)
    expect(refetch).toHaveBeenCalledWith("todos")
  })

  it("drops a bulk layer at once when it touched nothing", () => {
    const store = setup()
    store.addLayer("m", { kind: "deleteMany", coll: "todos", filter: { x: 1 } })
    store.awaitServer("m", "20")
    expect(store.hasLayer("m")).toBe(false)
  })
})

describe("rebase convergence", () => {
  type Update = Document
  const update: fc.Arbitrary<Update> = fc.oneof(
    fc.record({ $inc: fc.record({ n: fc.integer({ min: -3, max: 3 }) }) }),
    fc.record({ $mul: fc.record({ n: fc.integer({ min: -2, max: 2 }) }) }),
    fc.record({ $set: fc.record({ s: fc.constantFrom("a", "b", "c") }) }),
    fc.record({ $set: fc.record({ n: fc.integer({ min: -5, max: 5 }) }) }),
    fc.record({ $push: fc.record({ tags: fc.constantFrom("x", "y") }) }),
    fc.record({ $unset: fc.record({ s: fc.constant("") }) }),
  )
  const step = fc.oneof(
    fc.record({ kind: fc.constant("local" as const), update }),
    fc.record({ kind: fc.constant("remote" as const), update }),
    fc.record({ kind: fc.constant("commit" as const) }),
    fc.record({ kind: fc.constant("reject" as const) }),
  )

  it("always shows the server state with the pending layers folded on top, and converges", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const store = new Store(Date.now, applyUpdate)
        store.addQuery("q", "todos", { filter: {} })
        let server: Document = { _id: 1, n: 1, tags: [] }
        let ct = 1
        store.added("todos", 1, server, String(ct), ["q"])
        const pending: { mid: string; update: Update }[] = []
        let next = 0
        const expected = (): Document =>
          pending.reduce<Document>((doc, layer) => applyUpdate(doc, layer.update), server)
        for (const s of steps) {
          if (s.kind === "local") {
            const mid = `m${next++}`
            pending.push({ mid, update: s.update })
            store.addLayer(mid, { kind: "update", coll: "todos", id: 1, update: s.update })
          } else if (s.kind === "remote") {
            server = applyUpdate(server, s.update)
            ct += 1
            store.changed("todos", 1, String(ct), { replace: server })
          } else {
            const first = pending.shift()
            if (first === undefined) continue
            if (s.kind === "commit") {
              server = applyUpdate(server, first.update)
              ct += 1
              store.changed("todos", 1, String(ct), { replace: server })
            }
            store.dropLayer(first.mid)
          }
          expect(store.view("todos", 1)).toEqual(expected())
          expect(store.state("q").data).toEqual([expected()])
        }
        for (const layer of pending.splice(0)) {
          server = applyUpdate(server, layer.update)
          ct += 1
          store.changed("todos", 1, String(ct), { replace: server })
          store.dropLayer(layer.mid)
        }
        expect(store.view("todos", 1)).toEqual(server)
        expect(store.pendingLayers).toBe(0)
      }),
      { numRuns: 500 },
    )
  })
})
