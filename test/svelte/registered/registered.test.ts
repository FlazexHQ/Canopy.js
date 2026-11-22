import { type CanopyClient, createClient, type Doc, ObjectId, type WebSocketLike } from "canopy.js"
import { describe, expect, expectTypeOf, it } from "vitest"

import { canopyStatus, createQuery, getCanopy, setCanopy } from "../../../src/svelte/index.ts"
import { schema } from "./canopy.schema.ts"

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

const WELCOME = {
  t: "welcome",
  seq: 0,
  sid: "s",
  v: 1,
  resumed: false,
  hb: 25000,
  pv: "p",
  ct: "1",
  caps: [],
  limits: {},
}

/** Type checks run by `tsc -b` against the registered schema, with no type argument anywhere; never called. */
function checks(client: CanopyClient): void {
  setCanopy(client)
  const canopy = getCanopy()
  expectTypeOf(canopy).toEqualTypeOf<CanopyClient>()
  // @ts-expect-error not a registered collection
  void canopy.from("todo")
  const todos = createQuery(canopy.from("todos").find({ done: false }))
  expectTypeOf(todos.data).toEqualTypeOf<readonly Doc<"todos">[]>()
  const titles = createQuery(canopy.from("todos").find({ done: false }).fields({ title: 1 }))
  expectTypeOf(titles.data).toEqualTypeOf<readonly { _id: ObjectId; title: string }[]>()
  const [first] = titles.data
  // @ts-expect-error the projection omits done
  void first?.done
  expectTypeOf(canopyStatus(canopy).current).toBeString()
  expectTypeOf(canopy.from("notes").insert).parameter(0).toHaveProperty("_id").toBeString()
}
void checks

describe("the Svelte bindings with a registered schema", () => {
  it("follow typed queries of a client that generates the schema's ids and defaults", async () => {
    const client = createClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Socket,
      lifecycle: false,
      schema,
    })
    await flush()
    const socket = Socket.last
    if (socket === undefined) throw new Error("the client opened no socket")
    socket.push(WELCOME)
    await flush()
    const titles = createQuery(client.from("todos").find({ done: false }).fields({ title: 1 }))
    const states: string[] = []
    const stop = titles.subscribe((state) => states.push(state.status))
    await flush()
    expect(socket.sent.filter((frame) => frame["t"] === "sub").map((frame) => frame["q"])).toEqual([
      { filter: { done: false }, fields: { title: 1 } },
    ])
    expect(states[0]).toBe("loading")
    const handle = client.from("todos").insert({ title: "Ship", ownerId: "u1", due: null })
    expect(handle.id).toBeInstanceOf(ObjectId)
    await flush()
    const [mut] = socket.sent.filter((frame) => frame["t"] === "mut")
    expect(mut?.["args"]).toMatchObject({
      doc: { _id: { $oid: handle.id.toHexString() }, title: "Ship", done: false, due: null },
    })
    void handle.catch(() => undefined)
    stop()
    client.close()
  })
})
