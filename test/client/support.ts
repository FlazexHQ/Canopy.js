import { expect, vi } from "vitest"

import type { WebSocketConstructor, WebSocketLike } from "../../src/client/index.ts"

/** A server socket the test drives: it opens on demand and records what the client sends. */
export class ServerSocket implements WebSocketLike {
  static all: ServerSocket[] = []
  readyState = 0
  readonly protocol = "canopy.v1+json"
  readonly sent: Record<string, unknown>[] = []
  closedWith: number | undefined
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private seq = 0

  constructor() {
    ServerSocket.all.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.closedWith = code
    this.readyState = 3
    this.onclose?.({ code, reason: "" })
  }

  /** Frames of one type the client sent. */
  of(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message["t"] === type)
  }

  /** Opens and answers the hello with a welcome. */
  async accept(
    sid = "n1.s",
    resumed = false,
    capabilities?: { readonly mutations: boolean },
  ): Promise<void> {
    this.readyState = 1
    this.onopen?.({})
    await vi.waitFor(() => expect(this.of("hello").length).toBeGreaterThan(0))
    this.seq = 0
    this.push({
      t: "welcome",
      seq: 0,
      sid,
      v: 1,
      resumed,
      hb: 25_000,
      pv: "p",
      ct: "1",
      caps: [],
      ...(capabilities === undefined ? {} : { capabilities }),
      limits: { subs: 100 },
    })
  }

  /** Sends a sequenced server message. */
  emit(message: Record<string, unknown>): void {
    this.seq += 1
    this.push({ ...message, seq: this.seq })
  }

  push(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  /** The server side closing the connection. */
  drop(code: number): void {
    this.readyState = 3
    this.onclose?.({ code, reason: "" })
  }
}

export const Server = ServerSocket as unknown as WebSocketConstructor

/** Lets queued microtasks and zero delay timers run. */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A JWT shaped token with a subject; the client only reads its claims. */
export function tokenFor(sub: string, expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  return `${part({ alg: "none" })}.${part({ sub, exp: expSeconds })}.sig`
}
