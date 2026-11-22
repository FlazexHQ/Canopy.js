import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { type CanopyClient, createClient } from "../../src/client/index.ts"
import { type ChannelLike, type LockManagerLike, leaderTab } from "../../src/client/leader-tab.ts"
import { Server, ServerSocket, settle, tokenFor } from "./support.ts"

/** Web Locks within one test: the first request holds the lock until its promise settles. */
class Locks implements LockManagerLike {
  private readonly held = new Map<string, Promise<void>>()

  request(name: string, callback: () => Promise<void>): Promise<unknown> {
    const before = this.held.get(name) ?? Promise.resolve()
    const run = before.then(() => callback())
    this.held.set(
      name,
      run.catch(() => {}),
    )
    return run
  }
}

/** A BroadcastChannel bus: messages reach every other channel of the name, on a later task. */
function channels(): new (name: string) => ChannelLike {
  const open = new Set<{ name: string; channel: ChannelLike }>()
  return class Channel implements ChannelLike {
    onmessage: ((event: { readonly data: unknown }) => void) | null = null
    private readonly entry: { name: string; channel: ChannelLike }

    constructor(name: string) {
      this.entry = { name, channel: this }
      open.add(this.entry)
    }

    postMessage(message: unknown): void {
      const copy = structuredClone(message)
      for (const other of open)
        if (other !== this.entry && other.name === this.entry.name)
          setTimeout(() => other.channel.onmessage?.({ data: copy }), 0)
    }

    close(): void {
      open.delete(this.entry)
    }
  }
}

describe("leader tab", () => {
  let locks: Locks
  let Channel: new (name: string) => ChannelLike
  const clients: CanopyClient[] = []

  beforeEach(() => {
    ServerSocket.all = []
    locks = new Locks()
    Channel = channels()
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.close()
  })

  const tab = (sub = "alice") => {
    const shared = leaderTab({ locks, BroadcastChannel: Channel })
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Server,
      lifecycle: false,
      shared,
      auth: { getToken: () => tokenFor(sub) },
    })
    clients.push(client)
    return { client, shared }
  }

  it("shares one server connection between tabs and routes each tab its own events", async () => {
    const one = tab()
    await settle()
    const two = tab()
    await settle()
    expect(ServerSocket.all).toHaveLength(1)
    const server = ServerSocket.all[0] as ServerSocket
    await server.accept()
    await vi.waitFor(() => {
      expect(one.client.connectionStatus).toBe("live")
      expect(two.client.connectionStatus).toBe("live")
    })
    expect(server.of("hello")).toHaveLength(1)

    const first = one.client.live("todos", { done: false })
    const second = two.client.live("notes", {})
    const seen: unknown[][] = [[], []]
    first.subscribe((state) => seen[0]?.push(state.data.map((doc) => doc["_id"])))
    second.subscribe((state) => seen[1]?.push(state.data.map((doc) => doc["_id"])))
    await vi.waitFor(() => expect(server.of("sub")).toHaveLength(2))
    const [subA, subB] = server.of("sub").map((message) => String(message["id"]))
    expect(subA).not.toBe(subB)
    expect(new Set(server.of("sub").map((message) => message["c"]))).toEqual(
      new Set(["todos", "notes"]),
    )
    const todosSub = server.of("sub").find((message) => message["c"] === "todos")?.["id"]
    const notesSub = server.of("sub").find((message) => message["c"] === "notes")?.["id"]
    server.emit({
      t: "added",
      c: "todos",
      id: 1,
      d: { _id: 1, done: false },
      ct: "2",
      s: [todosSub],
    })
    server.emit({ t: "ready", s: todosSub, ct: "2" })
    server.emit({ t: "added", c: "notes", id: 7, d: { _id: 7 }, ct: "2", s: [notesSub] })
    server.emit({ t: "ready", s: notesSub, ct: "2" })
    await vi.waitFor(() => {
      expect(first.getState()).toMatchObject({ status: "ready", data: [{ _id: 1 }] })
      expect(second.getState()).toMatchObject({ status: "ready", data: [{ _id: 7 }] })
    })

    const write = two.client.insert("notes", { _id: 8 })
    await vi.waitFor(() => expect(server.of("mut")).toHaveLength(1))
    server.emit({
      t: "ack",
      m: write.mutationId,
      ok: true,
      ct: "3",
      echo: false,
      res: { matched: 0, modified: 0, docs: [{ _id: 8 }] },
    })
    await expect(write).resolves.toMatchObject({ echo: false })
    server.emit({ t: "changed", c: "todos", id: 1, ct: "4", set: { title: "renamed" } })
    await vi.waitFor(() =>
      expect(first.getState().data).toEqual([{ _id: 1, done: false, title: "renamed" }]),
    )
    server.emit({ t: "removed", c: "todos", id: 1, ct: "5", s: [todosSub] })
    await vi.waitFor(() => expect(first.getState().data).toEqual([]))
    expect(
      second
        .getState()
        .data.map((doc) => doc["_id"])
        .sort(),
    ).toEqual([7, 8])
  })

  it("moves the connection to the next tab when the leader leaves", async () => {
    const one = tab()
    await settle()
    const two = tab()
    await settle()
    await (ServerSocket.all[0] as ServerSocket).accept()
    const query = two.client.live("todos", {})
    query.subscribe(() => {})
    await vi.waitFor(() => expect((ServerSocket.all[0] as ServerSocket).of("sub")).toHaveLength(1))
    one.client.close()
    one.shared.dispose()
    await vi.waitFor(() => expect(ServerSocket.all).toHaveLength(2))
    const next = ServerSocket.all[1] as ServerSocket
    expect((ServerSocket.all[0] as ServerSocket).closedWith).toBe(1000)
    await next.accept("n1.t")
    await vi.waitFor(() => expect(next.of("sub")).toHaveLength(1))
    expect(next.of("sub")[0]?.["c"]).toBe("todos")
    expect(two.client.connectionStatus).toBe("live")
  })

  it("lets a tab of another user connect on its own", async () => {
    tab("alice")
    await settle()
    const bob = tab("bob")
    await settle()
    await (ServerSocket.all[0] as ServerSocket).accept()
    await vi.waitFor(() => expect(ServerSocket.all).toHaveLength(2))
    const direct = ServerSocket.all[1] as ServerSocket
    await direct.accept("n1.bob")
    await vi.waitFor(() => expect(bob.client.connectionStatus).toBe("live"))
    const sent = String(direct.of("hello")[0]?.["token"]).split(".")[1] ?? ""
    expect(JSON.parse(atob(sent.replaceAll("-", "+").replaceAll("_", "/")))).toMatchObject({
      sub: "bob",
    })
  })

  it("connects directly without Web Locks", () => {
    const shared = leaderTab({ BroadcastChannel: Channel })
    const globals = globalThis as { navigator?: { locks?: unknown } }
    if (globals.navigator?.locks !== undefined) return
    const socket = shared.connect("ws://x", "canopy.v1+json", Server)
    expect(socket).toBeInstanceOf(ServerSocket)
  })
})
