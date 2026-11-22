import type { FallbackTransport } from "./client-types.ts"
import { type Frame, HttpSocket } from "./http-socket.ts"

/** SSE with POST, or long-polling, against the realtime HTTP endpoints. */
class SessionSocket extends HttpSocket {
  private sid: string | undefined
  private queue: string[] = []
  private lastSeq = 0
  private readonly stream: boolean

  constructor(base: string, fetchImpl: typeof fetch, stream: boolean) {
    super(`${base}/realtime/v1/sessions`, fetchImpl)
    this.stream = stream
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(`${this.base}${path}`, {
      ...init,
      headers: this.headers(init.body !== undefined),
      signal: this.abort.signal,
    })
  }

  protected handle(message: Frame, text: string): void {
    if (message.t === "hello") {
      const { key: _key, token: _token, ...hello } = message
      void this.open(JSON.stringify(hello))
    } else if (message.t === "bye") {
      if (this.sid !== undefined)
        void this.fetch(`${this.base}/${this.sid}`, {
          method: "DELETE",
          headers: this.headers(),
        }).catch(() => {})
    } else {
      this.queue.push(text)
      if (this.queue.length === 1) queueMicrotask(() => void this.flush())
    }
  }

  private async open(hello: string): Promise<void> {
    try {
      const response = await this.request("", { method: "POST", body: hello })
      if (!response.ok) return this.fail(response)
      const welcome = await response.text()
      this.sid = (JSON.parse(welcome) as { sid: string }).sid
      this.deliver(welcome)
      void this.flush()
      await (this.stream ? this.events() : this.poll())
    } catch {
      this.end(1006)
    }
  }

  private async flush(): Promise<void> {
    if (this.sid === undefined || this.queue.length === 0) return
    const body = `[${this.queue.join(",")}]`
    this.queue = []
    try {
      const response = await this.request(`/${this.sid}/messages`, { method: "POST", body })
      if (!response.ok) await this.fail(response)
    } catch {
      this.end(1006)
    }
  }

  private async events(): Promise<void> {
    const response = await this.request(`/${this.sid}/events`)
    if (!response.ok || response.body === null) return this.fail(response)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return this.end(1006)
      buffer += value
      let index = buffer.indexOf("\n\n")
      while (index >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf("\n\n")
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n")
        if (data === "") continue
        if (block.startsWith("event: close")) {
          const closed = JSON.parse(data) as { code: number; reason: string }
          return this.end(closed.code, closed.reason)
        }
        this.deliver(data)
      }
    }
  }

  private async poll(): Promise<void> {
    while (this.readyState === 1) {
      const response = await this.request(`/${this.sid}/poll?after=${this.lastSeq}&wait=25`)
      if (!response.ok) return this.fail(response)
      for (const frame of (await response.json()) as Frame[]) {
        if (typeof frame.seq === "number") this.lastSeq = Math.max(this.lastSeq, frame.seq)
        this.deliver(frame)
      }
    }
  }
}

/** SSE for server frames and POST for client frames. */
export const sse: FallbackTransport = {
  connect: (url, fetchImpl) => new SessionSocket(url, fetchImpl, true),
}

/** Long-polling, the last resort before REST polling. */
export const longPoll: FallbackTransport = {
  connect: (url, fetchImpl) => new SessionSocket(url, fetchImpl, false),
}

/** The ladder below WebSocket: SSE, then long-polling. Add `restPolling()` from `canopy.js/rest-polling` for fallback syncing. */
export const transports: readonly FallbackTransport[] = [sse, longPoll]
