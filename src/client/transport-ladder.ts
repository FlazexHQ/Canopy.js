import { SUBPROTOCOL } from "../core/protocol/index.ts"
import type { ClientOptions, FallbackTransport, WebSocketConstructor } from "./client-types.ts"

/** Options of a {@link TransportLadder}. */
export interface TransportLadderOptions {
  readonly fallback: ClientOptions["fallback"]
  readonly webSocket: () => WebSocketConstructor | undefined
  readonly socketUrl: string
  readonly probeIntervalMs: number
  readonly closed: () => boolean
  /** Called when a probe reached the WebSocket endpoint again while on a fallback rung. */
  readonly onReachable: () => void
}

/**
 * The transports the client tries in order: rung 0 is WebSocket, the next rungs are the fallback
 * transports, loaded on first use. Two quick connection failures move one rung down; while below rung
 * 0, a periodic probe checks whether WebSocket works again.
 */
export class TransportLadder {
  private readonly options: TransportLadderOptions
  private current = 0
  private ladder: readonly FallbackTransport[] | undefined
  private failures: number[] = []
  private probeTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: TransportLadderOptions) {
    this.options = options
  }

  /** The current rung: 0 for WebSocket, `n` for the `n`th fallback transport. */
  get rung(): number {
    return this.current
  }

  /** The fallback transport of the current rung, or `undefined` on WebSocket. */
  get transport(): FallbackTransport | undefined {
    return this.ladder?.[this.current - 1]
  }

  /**
   * Records a connection that failed before `welcome`. Returns whether two failures within 10 seconds
   * call for the next rung.
   */
  failed(now: number): boolean {
    this.failures = [...this.failures.filter((at) => now - at < 10_000), now]
    return this.failures.length >= 2
  }

  /**
   * Loads the fallback transports when needed and moves one rung down if there is one. Returns whether
   * the rung changed. Starts probing for WebSocket either way.
   */
  async descend(): Promise<boolean> {
    const source = this.options.fallback
    if (source === undefined) return false
    try {
      this.ladder ??= (typeof source === "function" ? await source() : source).transports
    } catch {
      this.ladder = []
    }
    let moved = false
    if (this.current < this.ladder.length) {
      this.current += 1
      moved = true
    }
    this.failures = []
    this.startProbe()
    return moved
  }

  private startProbe(): void {
    const WebSocketImpl = this.options.webSocket()
    if (this.probeTimer !== undefined || WebSocketImpl === undefined || this.current === 0) return
    this.probeTimer = setInterval(() => {
      if (this.options.closed() || this.current === 0) return
      const probe = new WebSocketImpl(this.options.socketUrl, SUBPROTOCOL)
      probe.onopen = () => {
        probe.close(1000, "probe")
        this.options.onReachable()
      }
      probe.onmessage = null
      probe.onerror = () => {}
      probe.onclose = null
    }, this.options.probeIntervalMs)
  }

  /** Moves back to WebSocket. Returns `false` when already there. */
  ascend(): boolean {
    if (this.current === 0) return false
    this.current = 0
    this.failures = []
    this.stop()
    return true
  }

  /** Stops probing. */
  stop(): void {
    if (this.probeTimer !== undefined) clearInterval(this.probeTimer)
    this.probeTimer = undefined
  }
}
