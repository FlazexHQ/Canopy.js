import {
  CanopyClient,
  type DocumentSchema,
  type MutationHandle,
  type ObjectId,
  type WebSocketLike,
} from "canopy.js"
import { memoryPersister } from "canopy.js/persist"
import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"

import {
  CanopyProvider,
  createReactDb,
  type ReactDb,
  useCanopyStatus,
  useMutationError,
  useStaleMutations,
} from "../../src/react/index.tsx"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  protocol = "canopy.v1+json"
  readonly sent: { t: string; id?: string }[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor() {
    FakeSocket.all.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { t: string })
  }
  close(): void {
    this.readyState = 3
  }
  push(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

interface Todo extends Record<string, unknown> {
  _id: number
  title: string
}

const counter = { renders: 0 }

interface Note {
  _id: ObjectId
  title: string
  done: boolean
}

/** Type checks run by `tsc -b`; never called. */
function useHookTypes(db: ReactDb<DocumentSchema<{ notes: Note }>>): void {
  const [note] = db.notes.useQuery({}, { fields: { title: 1 } }).data
  if (note !== undefined) {
    expectTypeOf(note).toEqualTypeOf<{ _id: ObjectId; title: string }>()
    // @ts-expect-error the projection omits done
    void note.done
  }
  expectTypeOf(db.notes.useQuery({ done: false }).data).toEqualTypeOf<readonly Note[]>()
  expectTypeOf(db.notes.insert({ title: "a", done: false })).toEqualTypeOf<
    MutationHandle<ObjectId>
  >()
  // @ts-expect-error a literal projection cannot mix inclusion and exclusion
  void db.notes.useQuery({}, { fields: { title: 1, done: 0 } })
}
void useHookTypes

function List({ db }: { readonly db: ReactDb<DocumentSchema<{ todos: Todo }>> }): ReactNode {
  counter.renders += 1
  const { data, status } = db.todos.useQuery({ done: false }, { sort: { title: 1 } })
  const connection = useCanopyStatus()
  return (
    <ul data-status={status} data-connection={connection}>
      {data.map((todo) => (
        <li key={todo._id}>{todo.title}</li>
      ))}
    </ul>
  )
}

function Status(): ReactNode {
  return <span>{useCanopyStatus()}</span>
}

function Failures(): ReactNode {
  const failure = useMutationError()
  const stale = useStaleMutations()
  return (
    <div>
      <p>{failure.error === undefined ? "none" : `${failure.error.name} ${failure.mutationId}`}</p>
      <button type="button" id="clear" onClick={failure.clear} />
      <ol data-count={stale.length}>
        {stale.map((entry) => (
          <li key={entry.mutationId}>
            <button type="button" onClick={() => entry.discard()}>
              {entry.mutationId}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

describe("canopy.js/react", () => {
  const containers: HTMLElement[] = []
  afterEach(() => {
    for (const element of containers.splice(0)) element.remove()
  })

  it("renders live results and the connection status, sharing one subscription between components", async () => {
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: FakeSocket,
    })
    const db = createReactDb<DocumentSchema<{ todos: Todo }>>(client)
    const container = document.createElement("div")
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <CanopyProvider client={client}>
          <List db={db} />
          <List db={db} />
        </CanopyProvider>,
      )
    })
    await tick()
    const socket = FakeSocket.all.at(-1) as FakeSocket
    expect(container.querySelector("ul")?.dataset["status"]).toBe("loading")
    await act(async () => {
      socket.push({
        t: "welcome",
        seq: 0,
        sid: "n1.x",
        v: 1,
        resumed: false,
        hb: 25000,
        pv: "",
        ct: "1",
        caps: [],
        limits: { subs: 100 },
      })
    })
    await tick()
    expect(socket.sent.filter((message) => message.t === "sub")).toHaveLength(1)
    await act(async () => {
      socket.push({
        t: "added",
        seq: 1,
        c: "todos",
        id: 2,
        d: { _id: 2, title: "b" },
        ct: "1",
        s: ["s1"],
      })
      socket.push({
        t: "added",
        seq: 2,
        c: "todos",
        id: 1,
        d: { _id: 1, title: "a" },
        ct: "1",
        s: ["s1"],
      })
      socket.push({ t: "ready", seq: 3, s: "s1", ct: "1" })
    })
    await tick()
    const lists = [...container.querySelectorAll("ul")]
    expect(lists.map((list) => list.textContent)).toEqual(["ab", "ab"])
    expect(lists[0]?.dataset["status"]).toBe("ready")
    expect(lists[0]?.dataset["connection"]).toBe("live")

    const before = counter.renders
    await act(async () => {
      socket.push({ t: "changed", seq: 4, c: "todos", id: 1, ct: "2", set: { title: "c" } })
    })
    await tick()
    expect([...container.querySelectorAll("ul")].map((list) => list.textContent)).toEqual([
      "bc",
      "bc",
    ])
    expect(counter.renders - before).toBeLessThanOrEqual(4)

    await act(async () => root.unmount())
    await tick()
    expect(socket.sent.filter((message) => message.t === "unsub")).toEqual([
      { t: "unsub", id: "s1" },
    ])
    client.close()
  })

  it("sends collection mutations through the client and shows them optimistically", async () => {
    FakeSocket.all = []
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: FakeSocket,
    })
    const db = createReactDb<DocumentSchema<{ todos: Todo }>>(client)
    const live = client.live("todos", {})
    const states: number[] = []
    const stop = live.subscribe((state) => states.push(state.data.length))
    const handle = db.todos.insert({ _id: 7, title: "t" })
    expect(handle.id).toBe(7)
    expect(client.store.view("todos", 7)).toEqual({ _id: 7, title: "t" })
    await client.updateEngine
    db.todos.update(7, { $set: { title: "u" } })
    expect(client.store.view("todos", 7)).toEqual({ _id: 7, title: "u" })
    db.todos.delete(7)
    expect(client.store.view("todos", 7)).toBeUndefined()
    expect(client.pendingMutations).toBe(3)
    const socket = FakeSocket.all[0]
    await tick()
    socket?.push({
      t: "welcome",
      seq: 1,
      sid: "n1.a",
      v: 1,
      resumed: false,
      hb: 25000,
      pv: "p",
      ct: "1",
      caps: [],
      limits: { subs: 100 },
    })
    await tick()
    const sent = (socket?.sent ?? []).filter((message) => message.t === "mut") as unknown as {
      c: string
      op: string
    }[]
    expect(sent.map((message) => [message.c, message.op])).toEqual([
      ["todos", "insert"],
      ["todos", "update"],
      ["todos", "delete"],
    ])
    stop()
    client.close()
    await expect(handle).rejects.toMatchObject({ code: "CANOPY_UNAVAILABLE" })
  })

  it("requires a provider for the status hook", async () => {
    const container = document.createElement("div")
    containers.push(container)
    const root = createRoot(container)
    const errors: unknown[] = []
    const original = console.error
    console.error = () => {}
    try {
      await act(async () => {
        root.render(<Status />)
      })
    } catch (error: unknown) {
      errors.push(error)
    } finally {
      console.error = original
    }
    expect(String(errors[0])).toContain("CanopyProvider")
  })

  it("reports rolled back and stale mutations through hooks", async () => {
    FakeSocket.all = []
    const persist = memoryPersister()
    const staleId = "0192f6a1-7c2e-7b1a-9d3e-00000000c001"
    const update = { $set: { title: "old" } }
    await persist.set(
      "mutations",
      `alice\u0000${staleId}`,
      JSON.stringify({
        m: { t: "mut", id: staleId, c: "todos", op: "update", args: { id: 1, update } },
        ids: [1],
        layers: [{ kind: "update", coll: "todos", id: 1, update }],
        at: Date.now() - 21 * 3_600_000,
      }),
    )
    const token = `e30.${btoa(JSON.stringify({ sub: "alice", exp: 4_000_000_000 }))}.sig`
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: FakeSocket,
      persist,
      auth: { getToken: () => token },
    })
    const container = document.createElement("div")
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <CanopyProvider client={client}>
          <Failures />
        </CanopyProvider>,
      )
    })
    for (let i = 0; i < 5 && FakeSocket.all.length === 0; i += 1) await tick()
    const socket = FakeSocket.all[0] as FakeSocket
    await tick()
    expect(container.querySelector("ol")?.dataset["count"]).toBe("1")
    expect(container.querySelector("li")?.textContent).toBe(staleId)
    await act(async () => {
      socket.push({
        t: "welcome",
        seq: 0,
        sid: "n1.y",
        v: 1,
        resumed: false,
        hb: 25000,
        pv: "",
        ct: "1",
        caps: [],
        limits: { subs: 100 },
      })
    })
    await tick()
    const handle = client.insert("todos", { _id: 9, title: "t" })
    await tick()
    expect(container.querySelector("p")?.textContent).toBe("none")
    await act(async () => {
      socket.push({
        t: "ack",
        seq: 1,
        m: handle.mutationId,
        ok: false,
        err: { code: "CANOPY_CONFLICT", msg: "changed first" },
      })
    })
    await tick()
    expect(container.querySelector("p")?.textContent).toBe(`ConflictError ${handle.mutationId}`)
    await expect(handle).rejects.toMatchObject({ code: "CANOPY_CONFLICT" })
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#clear")?.click()
    })
    expect(container.querySelector("p")?.textContent).toBe("none")
    await act(async () => {
      container.querySelector<HTMLButtonElement>("li button")?.click()
    })
    expect(container.querySelector("ol")?.dataset["count"]).toBe("0")
    expect(await persist.entries("mutations")).toEqual([])
    await act(async () => root.unmount())
    client.close()
  })
})
