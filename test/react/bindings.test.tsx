import { CanopyClient, type QueryState, type WebSocketLike } from "canopy.js"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import {
  CanopyProvider,
  Hydrate,
  useDocument,
  useQuery,
  useSession,
} from "../../src/react/index.tsx"
import { loadVectors, runVector } from "../support/vectors.ts"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

/** Renders a hook and hands each value it returns to `onValue`. */
function Probe<T>({ use, onValue }: { use: () => T; onValue: (value: T) => void }) {
  onValue(use())
  return null
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})

function mount(node: ReactNode): HTMLElement {
  const element = document.createElement("div")
  const root = createRoot(element)
  roots.push(root)
  act(() => root.render(node))
  return element
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let round = 0; round < 5; round += 1) await Promise.resolve()
  })
}

describe("protocol vectors through useQuery", () => {
  it.each(loadVectors().map((vector) => [vector.name, vector] as const))(
    "%s",
    async (_name, vector) => {
      await runVector(
        vector,
        (client, subscription) => {
          let latest: QueryState | undefined
          const query = client.live(
            subscription.c,
            subscription.filter,
            subscription.sort === undefined ? {} : { sort: subscription.sort },
          )
          const element = document.createElement("div")
          const root = createRoot(element)
          act(() =>
            root.render(
              <Probe
                use={() => useQuery(query)}
                onValue={(value) => {
                  latest = value
                }}
              />,
            ),
          )
          return {
            read: () => latest as QueryState,
            stop: () => act(() => root.unmount()),
          }
        },
        flush,
      )
    },
  )
})

describe("server rendering and single documents", () => {
  const client = (auth?: ConstructorParameters<typeof CanopyClient>[0]["auth"]) =>
    new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Socket,
      lifecycle: false,
      ...(auth === undefined ? {} : { auth }),
    })

  it("renders hydrated documents on the first render, before the socket answers", () => {
    const canopy = client()
    const state = {
      canopy: 1 as const,
      queries: [
        {
          c: "todos",
          q: { filter: { done: false } },
          docs: [{ _id: 1, title: "from the server" }],
          ct: "5",
        },
      ],
    }
    const seen: string[] = []
    const query = canopy.live("todos", { done: false })
    mount(
      <CanopyProvider client={canopy}>
        <Hydrate state={state}>
          <Probe
            use={() => useQuery(query)}
            onValue={(result) =>
              seen.push(`${result.status}:${result.data.map((doc) => doc["title"]).join(",")}`)
            }
          />
        </Hydrate>
      </CanopyProvider>,
    )
    expect(seen[0]).toBe("stale:from the server")
    canopy.close()
  })

  it("follows one document by _id, optimistic writes included", async () => {
    const canopy = client()
    let latest: { data: Record<string, unknown> | undefined; status: string } | undefined
    mount(
      <CanopyProvider client={canopy}>
        <Probe
          use={() => useDocument("todos", 3)}
          onValue={(value) => {
            latest = value
          }}
        />
      </CanopyProvider>,
    )
    await flush()
    const socket = Socket.last as Socket
    socket.push({
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
    })
    await flush()
    const sub = socket.sent.find((message) => message["t"] === "sub")
    expect(sub).toMatchObject({ c: "todos", q: { filter: { _id: 3 }, limit: 1 } })
    socket.push({
      t: "added",
      seq: 1,
      c: "todos",
      id: 3,
      d: { _id: 3, done: false },
      ct: "2",
      s: [sub?.["id"]],
    })
    socket.push({ t: "ready", seq: 2, s: sub?.["id"], ct: "2" })
    await flush()
    expect(latest).toMatchObject({ status: "ready", data: { _id: 3, done: false } })
    await act(async () => {
      canopy.update("todos", 3, { $set: { done: true } })
      await canopy.updateEngine
    })
    await flush()
    expect(latest?.data).toEqual({ _id: 3, done: true })
    canopy.close()
  })

  it("reports the signed in user and follows changes", async () => {
    const listeners = new Set<() => void>()
    let user: { id: string } | undefined = { id: "u1" }
    const auth = {
      getToken: () => null,
      onChange: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      get user() {
        return user
      },
    }
    const canopy = client(auth)
    let seen: unknown
    mount(
      <CanopyProvider client={canopy}>
        <Probe
          use={() => useSession()}
          onValue={(value) => {
            seen = value
          }}
        />
      </CanopyProvider>,
    )
    expect(seen).toEqual({ id: "u1" })
    act(() => {
      user = undefined
      for (const listener of listeners) listener()
    })
    expect(seen).toBeUndefined()
    canopy.close()
  })
})
