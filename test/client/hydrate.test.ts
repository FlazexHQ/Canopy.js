import { ObjectId } from "canopy.js/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { type CanopyClient, createClient } from "../../src/client/index.ts"
import { mmkvPersister } from "../../src/client/persist.ts"
import { reactNativeLifecycle } from "../../src/client/react-native.ts"
import { createServerClient, dehydrate } from "../../src/client/server.ts"
import { Server, ServerSocket, settle } from "./support.ts"

const clients: CanopyClient[] = []
beforeEach(() => {
  ServerSocket.all = []
})
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

const make = (options: Partial<Parameters<typeof createClient>[0]> = {}) => {
  const client = createClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: Server,
    lifecycle: false,
    ...options,
  })
  clients.push(client)
  return client
}

describe("server rendering", () => {
  const oid = new ObjectId("64a1b2c3d4e5f6a7b8c9d0e1")

  function rest(calls: { url: string; init: RequestInit }[]): typeof fetch {
    return async (input, init = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/auth/v1/token"))
        return Response.json({ access_token: "jwt-from-cookie", token_type: "bearer" })
      return Response.json({
        data: [{ _id: { $oid: oid.hex }, title: "a", at: { $date: { $numberLong: "0" } } }],
        page: { limit: 20, next: null },
        ct: "77",
      })
    }
  }

  it("reads through REST with the cookie's token and returns the snapshot's cluster time", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const server = createServerClient({
      url: "https://api.test/",
      publishableKey: "pk",
      cookies: { getAll: () => [{ name: "better-auth.session_token", value: "a b" }] },
      fetch: rest(calls),
    })
    const snapshot = await server.find("todos", { done: false }, { sort: { at: -1 }, limit: 20 })
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.test/auth/v1/token",
      "https://api.test/rest/v1/todos/_query",
    ])
    expect(new Headers(calls[0]?.init.headers).get("cookie")).toBe(
      "better-auth.session_token=a%20b",
    )
    const headers = new Headers(calls[1]?.init.headers)
    expect(headers.get("authorization")).toBe("Bearer jwt-from-cookie")
    expect(headers.get("apikey")).toBe("pk")
    expect(headers.get("accept")).toBe("application/ejson")
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      filter: { done: false },
      sort: { at: { $numberInt: "-1" } },
      limit: { $numberInt: "20" },
    })
    expect(snapshot.ct).toBe("77")
    expect(snapshot.docs[0]?.["_id"]).toEqual(oid)
    expect(snapshot.docs[0]?.["at"]).toEqual(new Date(0))
    await server.find("todos")
    expect(calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1)
  })

  it("reads as anon without a token or cookies and reports REST errors with their codes", async () => {
    const server = createServerClient({
      url: "https://api.test",
      publishableKey: "pk",
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false)
        return Response.json(
          { code: "CANOPY_FORBIDDEN", detail: "No read policy", status: 403 },
          { status: 403 },
        )
      },
    })
    await expect(server.find("todos")).rejects.toMatchObject({ code: "CANOPY_FORBIDDEN" })
  })

  it("hydrates a live query: stale data at once, ready when the server confirms", async () => {
    const server = createServerClient({
      url: "https://api.test",
      publishableKey: "pk",
      token: "t",
      fetch: rest([]),
    })
    const state = dehydrate([
      await server.find("todos", { done: false }, { sort: { at: -1 }, limit: 20 }),
    ])
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    const client = make()
    client.hydrate(JSON.parse(JSON.stringify(state)))
    const query = client.live("todos", { done: false }, { sort: { at: -1 }, limit: 20 })
    expect(query.getState()).toMatchObject({ status: "stale", data: [{ title: "a" }] })
    expect(client.live("todos", { done: true }).getState().status).toBe("loading")
    const states: string[] = []
    query.subscribe((current) => states.push(`${current.status}:${current.data.length}`))
    const socket = ServerSocket.all[0] as ServerSocket
    await socket.accept()
    await vi.waitFor(() => expect(socket.of("sub")).toHaveLength(1))
    const sub = socket.of("sub")[0]?.["id"]
    socket.emit({
      t: "changed",
      c: "todos",
      id: { $oid: oid.hex },
      ct: "50",
      set: { title: "older" },
    })
    socket.emit({
      t: "added",
      c: "todos",
      id: { $oid: oid.hex },
      d: { _id: { $oid: oid.hex }, title: "a" },
      ct: "77",
      s: [sub],
    })
    socket.emit({ t: "ready", s: sub, ct: "77" })
    await vi.waitFor(() => expect(query.getState().status).toBe("ready"))
    expect(query.getState().data.map((doc) => doc["title"])).toEqual(["a"])
    expect(states[0]).toBe("stale:1")
    expect(states).not.toContain("loading:0")
  })
})

describe("React Native", () => {
  it("reconnects when the app returns to the foreground and goes offline with NetInfo", async () => {
    const appListeners: ((state: string) => void)[] = []
    const netListeners: ((state: { isConnected: boolean | null }) => void)[] = []
    let removed = 0
    const client = make({
      lifecycle: reactNativeLifecycle({
        AppState: {
          currentState: "active",
          addEventListener: (_type, listener) => {
            appListeners.push(listener)
            return { remove: () => (removed += 1) }
          },
        },
        NetInfo: {
          addEventListener: (listener) => {
            netListeners.push(listener)
            return () => (removed += 1)
          },
        },
      }),
    })
    await (ServerSocket.all[0] as ServerSocket).accept()
    expect(client.connectionStatus).toBe("live")
    for (const listener of netListeners) listener({ isConnected: false })
    expect(client.connectionStatus).toBe("offline")
    expect((ServerSocket.all[0] as ServerSocket).closedWith).toBe(4000)
    for (const listener of appListeners) listener("background")
    expect(ServerSocket.all).toHaveLength(1)
    for (const listener of netListeners) listener({ isConnected: true })
    expect(ServerSocket.all).toHaveLength(2)
    ;(ServerSocket.all[1] as ServerSocket).drop(1006)
    for (const listener of appListeners) listener("active")
    await settle()
    expect(ServerSocket.all.length).toBeGreaterThanOrEqual(3)
    client.close()
    expect(removed).toBe(2)
  })

  it("persists into MMKV under a prefix, in key order", async () => {
    const store = new Map<string, string>()
    const persister = mmkvPersister({
      getString: (key) => store.get(key),
      set: (key, value) => {
        store.set(key, value)
      },
      delete: (key) => {
        store.delete(key)
      },
      getAllKeys: () => [...store.keys()],
    })
    await persister.set("mutations", "b", "2")
    await persister.set("mutations", "a", "1")
    await persister.set("docs", "x", "3")
    expect(await persister.entries("mutations")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ])
    expect(store.has("canopy:docs:x")).toBe(true)
    await persister.delete("mutations", "a")
    expect(await persister.get("mutations", "a")).toBeUndefined()
    expect(await persister.get("mutations", "b")).toBe("2")
  })
})

describe("devtools hooks", () => {
  it("taps every frame and discards a pending mutation as a rollback", async () => {
    const client = make()
    const frames: string[] = []
    const internals = client.devtools()
    const stop = internals.tap((direction, text) =>
      frames.push(`${direction}:${JSON.parse(text).t}`),
    )
    const socket = ServerSocket.all[0] as ServerSocket
    await socket.accept()
    const errors: string[] = []
    client.onMutationError((error) => errors.push(error.message))
    const write = client.insert("todos", { _id: 1, title: "x" })
    const query = client.live("todos", {})
    query.subscribe(() => {})
    await vi.waitFor(() => expect(client.devtools().outbox).toHaveLength(1))
    expect(query.getState().data).toHaveLength(1)
    internals.discard(write.mutationId)
    await expect(write).rejects.toMatchObject({ code: "CANOPY_CONFLICT" })
    expect(errors).toEqual(["Discarded in devtools"])
    expect(client.devtools().outbox).toHaveLength(0)
    await vi.waitFor(() => expect(query.getState().data).toHaveLength(0))
    expect(frames).toEqual(
      expect.arrayContaining(["out:hello", "in:welcome", "out:mut", "out:sub"]),
    )
    stop()
    socket.emit({ t: "wm", ct: "9" })
    expect(frames).not.toContain("in:wm")
    expect([...client.devtools().subscriptions.values()].map((sub) => sub.coll)).toEqual(["todos"])
  })
})
