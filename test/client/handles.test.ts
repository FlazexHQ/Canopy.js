import { afterEach, describe, expect, it } from "vitest"

import { createClient, isCanopyError, type WebSocketLike } from "../../src/client/index.ts"

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

describe("mutation handles", () => {
  const unhandled: unknown[] = []
  const record = (reason: unknown): void => {
    unhandled.push(reason)
  }
  afterEach(() => {
    process.off("unhandledRejection", record)
    unhandled.length = 0
  })

  it("never raise an unhandled rejection when they are dropped", async () => {
    process.on("unhandledRejection", record)
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
