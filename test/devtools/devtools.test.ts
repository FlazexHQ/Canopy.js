import { CanopyClient, type DocumentSchema, type WebSocketLike } from "canopy.js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { attachDevtools, watchMistakes } from "../../src/devtools/index.ts"

class Socket implements WebSocketLike {
  static last: Socket | undefined
  readyState = 0
  protocol = "canopy.v1+json"
  readonly sent: Record<string, unknown>[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor() {
    Socket.last = this
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.readyState = 3
  }
  push(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const flush = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await Promise.resolve()
}

const clients: CanopyClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  document.body.replaceChildren()
})

async function connected(): Promise<{ client: CanopyClient; socket: Socket }> {
  const client = new CanopyClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: Socket,
    lifecycle: false,
  })
  clients.push(client)
  await flush()
  const socket = Socket.last as Socket
  socket.push({
    t: "welcome",
    seq: 0,
    sid: "n1.abc",
    v: 1,
    resumed: false,
    hb: 25000,
    pv: "p",
    ct: "1",
    caps: ["batch"],
    limits: {},
  })
  await flush()
  return { client, socket }
}

const cells = (): string[] =>
  [...document.querySelectorAll("[data-canopy-devtools] td")].map((cell) => cell.textContent ?? "")

describe("devtools panel", () => {
  it("attaches to a client typed with a generated schema", () => {
    const typed = new CanopyClient<
      DocumentSchema<{ todos: { readonly _id: string; done: boolean } }>
    >({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Socket,
      lifecycle: false,
    })
    const devtools = attachDevtools(typed, { open: true, warnings: false })
    const stop = watchMistakes(typed, { warn: () => {} })
    expect(document.querySelector("[data-canopy-devtools]")).not.toBeNull()
    stop()
    devtools.destroy()
    typed.close()
  })

  it("shows the connection, subscriptions and the protocol log", async () => {
    const { client, socket } = await connected()
    const devtools = attachDevtools(client, { open: true, warnings: false })
    expect(cells()).toEqual(
      expect.arrayContaining(["Status", "live", "Session", "n1.abc", "Transport", "WebSocket"]),
    )
    const query = client.live("todos", { done: false }, { limit: 10 })
    query.subscribe(() => {})
    await flush()
    const sub = socket.sent.find((message) => message["t"] === "sub")?.["id"]
    socket.push({
      t: "batch",
      m: [
        { t: "added", seq: 1, c: "todos", id: 1, d: { _id: 1, done: false }, ct: "7", s: [sub] },
        { t: "ready", seq: 2, s: sub, ct: "7" },
      ],
    })
    await flush()
    expect(devtools.log.map((entry) => `${entry.direction}:${entry.type}`)).toEqual([
      "out:sub",
      "in:added",
      "in:ready",
    ])
    expect(devtools.log[1]).toMatchObject({ seq: 1, ct: "7" })
    const button = (name: string) =>
      [...document.querySelectorAll("button")].find((node) => node.textContent === name)
    button("Subscriptions")?.click()
    expect(cells()).toEqual([
      String(sub),
      "todos",
      '{"filter":{"done":false},"limit":10}',
      "ready",
      "1",
    ])
    button("Log")?.click()
    expect(cells().slice(0, 4)).toEqual(["←", "ready", "2", "7"])
    button("Store")?.click()
    expect(document.querySelector("[data-canopy-devtools] pre")?.textContent).toBe(
      '{"_id":1,"done":false} @7',
    )
    devtools.close()
    expect((document.querySelector("[data-canopy-devtools] section") as HTMLElement).hidden).toBe(
      true,
    )
    devtools.destroy()
    expect(document.querySelector("[data-canopy-devtools]")).toBeNull()
  })

  it("keeps tokens and secret keys out of the protocol log and the panel", async () => {
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "canopy_sk_do_not_show",
      WebSocket: Socket,
      lifecycle: false,
      auth: { getToken: () => "header.payload.signature" },
    })
    clients.push(client)
    const devtools = attachDevtools(client, { open: true, warnings: false })
    await flush()
    const hello = devtools.log.find((entry) => entry.type === "hello")
    expect(hello?.direction).toBe("out")
    for (const entry of devtools.log) {
      expect(entry.text).not.toContain("header.payload.signature")
      expect(entry.text).not.toContain("canopy_sk_do_not_show")
    }
    ;[...document.querySelectorAll("button")].find((node) => node.textContent === "Log")?.click()
    expect(document.body.textContent).not.toContain("header.payload.signature")
    expect(document.body.textContent).not.toContain("canopy_sk_do_not_show")
    expect(document.body.textContent).toContain("hello")
    devtools.destroy()
  })

  it("discards a pending mutation from the panel", async () => {
    const { client } = await connected()
    const devtools = attachDevtools(client, { open: true, warnings: false })
    const write = client.insert("todos", { _id: 5 })
    await flush()
    ;[...document.querySelectorAll("button")]
      .find((node) => node.textContent === "Mutations")
      ?.click()
    expect(cells().slice(0, 4)).toEqual([write.mutationId, "todos", "insert", "yes"])
    document.querySelector<HTMLButtonElement>(`[aria-label="Discard ${write.mutationId}"]`)?.click()
    await expect(write).rejects.toMatchObject({ code: "CANOPY_CONFLICT" })
    expect(client.pendingMutations).toBe(0)
    devtools.destroy()
  })
})

describe("development warnings", () => {
  it("reports large unlimited results, unsafe queries and denied mutations once each", async () => {
    const { client, socket } = await connected()
    const warn = vi.fn()
    const stop = watchMistakes(client, { warn, largeResult: 2 })
    const unlimited = client.live("todos", {})
    unlimited.subscribe(() => {})
    const unsafe = client.live("notes", { $where: "this.a > 1" }, { limit: 5 })
    unsafe.subscribe(() => {})
    await flush()
    const [first] = socket.sent.filter((message) => message["t"] === "sub").map((m) => m["id"])
    for (const id of [1, 2])
      socket.push({ t: "added", seq: id, c: "todos", id, d: { _id: id }, ct: "2", s: [first] })
    socket.push({ t: "ready", seq: 3, s: first, ct: "2" })
    const write = client.insert("todos", { _id: 9 })
    await flush()
    socket.push({
      t: "ack",
      seq: 4,
      m: write.mutationId,
      ok: false,
      err: { code: "CANOPY_POLICY_VIOLATION", msg: "check failed" },
    })
    await expect(write).rejects.toThrow()
    const messages = warn.mock.calls.map(([message]) => String(message))
    expect(messages).toHaveLength(3)
    expect(messages[0]).toMatch(
      /notes \{"\$where":"this.a > 1"\} uses operators the client cannot evaluate/,
    )
    expect(messages[1]).toMatch(/todos \{\} has no limit and returned 2 documents/)
    expect(messages[2]).toMatch(
      /insert on todos was rolled back: CANOPY_POLICY_VIOLATION \(check failed\)/,
    )
    stop()
  })
})
