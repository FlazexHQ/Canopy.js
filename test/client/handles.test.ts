import { createClient, isCanopyError, type WebSocketLike } from "canopy.js"
import { memoryPersister } from "canopy.js/persist"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Server, ServerSocket } from "./support.ts"

class SilentSocket implements WebSocketLike {
  readyState = 0
  protocol = ""
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(): void {}
  close(): void {
    this.readyState = 3
  }
}

interface RejectionHost {
  readonly process?: {
    on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown
    off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown
  }
  addEventListener(type: "unhandledrejection", listener: (event: { reason: unknown }) => void): void
  removeEventListener(
    type: "unhandledrejection",
    listener: (event: { reason: unknown }) => void,
  ): void
}

/** Reports unhandled rejections to `record` until the returned function is called. */
function watchUnhandled(record: (reason: unknown) => void): () => void {
  const host = globalThis as unknown as RejectionHost
  const runtime = host.process
  if (runtime !== undefined) {
    runtime.on("unhandledRejection", record)
    return () => runtime.off("unhandledRejection", record)
  }
  const listener = (event: { reason: unknown }): void => record(event.reason)
  host.addEventListener("unhandledrejection", listener)
  return () => host.removeEventListener("unhandledrejection", listener)
}

describe("mutation handles", () => {
  const unhandled: unknown[] = []
  let stopWatching = (): void => {}
  afterEach(() => {
    stopWatching()
    unhandled.length = 0
  })

  it("never raise an unhandled rejection when they are dropped", async () => {
    stopWatching = watchUnhandled((reason) => unhandled.push(reason))
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: SilentSocket,
    })
    client.close()
    void client.insert("todos", { _id: 1 })
    void client.update("todos", 1, { $set: { a: 1 } })
    void client.delete("todos", 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(unhandled).toEqual([])
  })

  it("still reject with a typed error when awaited", async () => {
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: SilentSocket,
    })
    client.close()
    const error: unknown = await client.insert("todos", { _id: 1 }).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(isCanopyError(error, "CANOPY_UNAVAILABLE")).toBe(true)
  })
})

describe("advertised mutation support", () => {
  const options = { url: "http://canopy.test", publishableKey: "pk", WebSocket: Server }

  function latestSocket(): ServerSocket {
    const socket = ServerSocket.all.at(-1)
    if (socket === undefined) throw new Error("expected a socket")
    return socket
  }

  it.each([true, undefined])(
    "sends queued and new mutations when support is %s",
    async (mutations) => {
      const client = createClient(options)
      try {
        const socket = latestSocket()
        const queued = client.insert("todos", { _id: 1 })
        expect(socket.of("mut")).toEqual([])
        const capabilities = mutations === undefined ? undefined : { mutations }
        await socket.accept(undefined, false, capabilities)
        expect(client.capabilities).toEqual(capabilities)
        const live = client.insert("todos", { _id: 2 })
        expect(socket.of("mut").map((message) => message["id"])).toEqual([
          queued.mutationId,
          live.mutationId,
        ])
        socket.emit({ t: "ack", m: queued.mutationId, ok: true, ct: "1" })
        socket.emit({ t: "ack", m: live.mutationId, ok: true, ct: "2" })
        await expect(queued).resolves.toMatchObject({ ct: "1" })
        await expect(live).resolves.toMatchObject({ ct: "2" })
      } finally {
        client.close()
      }
    },
  )

  it("rejects every mutation operation immediately when the endpoint disables writes", async () => {
    const client = createClient(options)
    try {
      const socket = latestSocket()
      await socket.accept(undefined, false, { mutations: false })
      expect(client.capabilities).toEqual({ mutations: false })
      const mutations = [
        client.insert("todos", { _id: 1 }),
        client.insertMany("todos", [{ _id: 2 }]),
        client.update("todos", 1, { $set: { done: true } }),
        client.replace("todos", 1, { done: true }, { upsert: true }),
        client.delete("todos", 1),
        client.updateMany("todos", {}, { $set: { done: true } }),
        client.deleteMany("todos", {}),
      ]
      expect(client.pendingMutations).toBe(0)
      expect(client.store.get("todos", 1)).toBeUndefined()
      expect(client.store.get("todos", 2)).toBeUndefined()
      expect(socket.of("mut")).toEqual([])
      for (const mutation of mutations)
        await expect(mutation).rejects.toMatchObject({
          code: "CANOPY_UNAVAILABLE",
          message: expect.stringContaining("Write through your own API or Canopy REST"),
        })
    } finally {
      client.close()
    }
  })

  it("rolls back queued mutations, notifies listeners and removes persisted copies", async () => {
    const persist = memoryPersister()
    const client = createClient({ ...options, persist })
    try {
      const socket = latestSocket()
      const onError = vi.fn()
      client.onMutationError(onError)
      const queued = client.insert("todos", { _id: 1 })
      expect(client.store.get("todos", 1)).toEqual({ _id: 1 })
      await vi.waitFor(async () => expect(await persist.entries("mutations")).toHaveLength(1))
      await socket.accept(undefined, false, { mutations: false })
      await expect(queued).rejects.toMatchObject({ code: "CANOPY_UNAVAILABLE" })
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "CANOPY_UNAVAILABLE" }),
        queued.mutationId,
      )
      expect(client.pendingMutations).toBe(0)
      expect(client.store.get("todos", 1)).toBeUndefined()
      expect(socket.of("mut")).toEqual([])
      await vi.waitFor(async () => expect(await persist.entries("mutations")).toEqual([]))
    } finally {
      client.close()
    }
  })

  it("reports restored writes when the endpoint disables mutations", async () => {
    const persist = memoryPersister()
    const original = createClient({ ...options, persist })
    const queued = original.insert("todos", { _id: 1 })
    try {
      await vi.waitFor(async () => expect(await persist.entries("mutations")).toHaveLength(1))
    } finally {
      original.close()
    }

    const restored = createClient({ ...options, persist })
    try {
      const socket = latestSocket()
      const onError = vi.fn()
      restored.onMutationError(onError)
      await socket.accept(undefined, false, { mutations: false })
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ code: "CANOPY_UNAVAILABLE" }),
          queued.mutationId,
        ),
      )
      expect(restored.pendingMutations).toBe(0)
      expect(restored.store.get("todos", 1)).toBeUndefined()
      expect(socket.of("mut")).toEqual([])
      await vi.waitFor(async () => expect(await persist.entries("mutations")).toEqual([]))
    } finally {
      restored.close()
    }
  })
})
