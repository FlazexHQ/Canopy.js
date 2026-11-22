import type { WebSocketLike } from "./client-types.ts"

/** A decoded JSON frame. */
export type Frame = Record<string, unknown> & { t?: unknown; seq?: unknown }

type Handlers = Pick<WebSocketLike, "onopen" | "onmessage" | "onclose" | "onerror">

/** Common behavior of the HTTP transports: an asynchronous open, close events, frame delivery. */
export abstract class HttpSocket implements WebSocketLike, Handlers {
  readyState = 0
  readonly protocol = "canopy.v1+json"
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  protected key = ""
  protected token: string | undefined
  protected readonly abort: AbortController = new AbortController()
  protected readonly base: string
  protected readonly fetch: typeof fetch

  constructor(base: string, fetchImpl: typeof fetch) {
    this.base = base
    this.fetch = fetchImpl
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.({})
    }, 0)
  }

  protected headers(json = false): Record<string, string> {
    return {
      apikey: this.key,
      ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
      ...(json ? { "content-type": "application/json" } : {}),
    }
  }

  protected deliver(frame: Frame | string): void {
    if (this.readyState === 1)
      this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) })
  }

  /** Closes with the code a failed response carries, or `1006` when the network failed. */
  protected async fail(response?: Response): Promise<void> {
    let code = 1006
    if (response !== undefined) {
      code = response.status === 401 ? 4001 : response.status === 403 ? 4003 : 4500
      try {
        const body = (await response.json()) as { close?: unknown }
        if (typeof body.close === "number") code = body.close
      } catch {
        // A body that is not JSON keeps the close code derived from the status.
      }
    }
    this.end(code)
  }

  protected end(code: number, reason = ""): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.abort.abort()
    setTimeout(() => this.onclose?.({ code, reason }), 0)
  }

  close(code = 1000, reason = ""): void {
    this.end(code, reason)
  }

  send(text: string): void {
    if (this.readyState !== 1) return
    const message = JSON.parse(text) as Frame
    if (message.t === "hello") {
      this.key = String(message["key"])
      this.token = typeof message["token"] === "string" ? message["token"] : undefined
    }
    if (message.t === "auth")
      this.token = message["token"] === "" ? undefined : String(message["token"])
    this.handle(message, text)
  }

  protected abstract handle(message: Frame, text: string): void
}
