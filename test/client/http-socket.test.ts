import { describe, expect, it } from "vitest"

import { type Frame, HttpSocket } from "../../src/client/http-socket.ts"

class ProbeSocket extends HttpSocket {
  readonly handled: Frame[] = []

  constructor() {
    super("https://api.test/realtime/v1", fetch)
  }

  protected handle(message: Frame): void {
    this.handled.push(message)
  }

  failWith(response?: Response): Promise<void> {
    return this.fail(response)
  }

  currentHeaders(): Record<string, string> {
    return this.headers(true)
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

async function closeCode(response?: Response): Promise<number> {
  const socket = new ProbeSocket()
  await tick()
  const closed = new Promise<number>((resolve) => {
    socket.onclose = (event) => resolve(event.code)
  })
  await socket.failWith(response)
  return closed
}

describe("HTTP transport sockets", () => {
  it("closes with the code a failed response maps to", async () => {
    expect(await closeCode()).toBe(1006)
    expect(await closeCode(new Response("", { status: 401 }))).toBe(4001)
    expect(await closeCode(new Response("", { status: 403 }))).toBe(4003)
    expect(await closeCode(new Response("not json", { status: 502 }))).toBe(4500)
    expect(await closeCode(Response.json({ close: 4029 }, { status: 429 }))).toBe(4029)
    expect(await closeCode(Response.json({ close: "4029" }, { status: 429 }))).toBe(4500)
  })

  it("never opens once closed, and ignores frames sent while not open", async () => {
    const socket = new ProbeSocket()
    let opened = false
    const closes: number[] = []
    socket.onopen = () => {
      opened = true
    }
    socket.onclose = (event) => closes.push(event.code)
    socket.send(JSON.stringify({ t: "hello", key: "pk" }))
    socket.close(1000)
    socket.close(4000)
    await tick()
    expect(opened).toBe(false)
    expect(socket.readyState).toBe(3)
    expect(socket.handled).toEqual([])
    expect(closes).toEqual([1000])
  })

  it("takes the key and token from hello and auth frames", async () => {
    const socket = new ProbeSocket()
    await tick()
    expect(socket.readyState).toBe(1)
    socket.send(JSON.stringify({ t: "hello", key: "pk_app", token: "t1" }))
    expect(socket.currentHeaders()).toEqual({
      apikey: "pk_app",
      authorization: "Bearer t1",
      "content-type": "application/json",
    })
    socket.send(JSON.stringify({ t: "auth", token: "t2" }))
    expect(socket.currentHeaders()["authorization"]).toBe("Bearer t2")
    socket.send(JSON.stringify({ t: "auth", token: "" }))
    expect(socket.currentHeaders()).not.toHaveProperty("authorization")
    expect(socket.handled.map((frame) => frame.t)).toEqual(["hello", "auth", "auth"])
    socket.close()
  })
})
