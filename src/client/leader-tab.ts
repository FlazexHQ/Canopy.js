import {
  type ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  type SequencedMessage,
  unbatch,
  type WelcomeMessage,
} from "../core/protocol/index.ts"
import type { SharedConnection, WebSocketConstructor, WebSocketLike } from "./client-types.ts"

/** The part of the Web Locks API leader election uses (`navigator.locks`). */
export interface LockManagerLike {
  request(name: string, callback: () => Promise<void>): Promise<unknown>
}

/** A `BroadcastChannel`. */
export interface ChannelLike {
  postMessage(message: unknown): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
  close(): void
}

/** Options of {@link leaderTab}. */
export interface LeaderTabOptions {
  /** Separates apps on one origin. Defaults to `default`. */
  readonly name?: string
  /** Defaults to `navigator.locks`. */
  readonly locks?: LockManagerLike
  /** Defaults to the global `BroadcastChannel`. */
  readonly BroadcastChannel?: new (name: string) => ChannelLike
  /** How long a tab may stay silent before the leader drops its subscriptions. Defaults to 75 s. */
  readonly tabTimeoutMs?: number
}

type Envelope =
  | { readonly k: "who"; readonly from: string }
  | { readonly k: "leader"; readonly id: string }
  | { readonly k: "open"; readonly to: string; readonly from: string; readonly v: string }
  | { readonly k: "frame"; readonly to: string; readonly v: string; readonly text: string }
  | {
      readonly k: "end"
      readonly to: string
      readonly v: string
      readonly code: number
      readonly reason: string
    }
  | { readonly k: "opened"; readonly to: string; readonly v: string }
  | { readonly k: "refuse"; readonly to: string; readonly v: string }

/** Closes a tab's connection so its client reconnects at once and resubscribes. */
const MOVED = 1012
/** Closes a tab's connection whose user differs from the leader's; that tab then connects directly. */
const OTHER_USER = 4409

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function subjectOf(token: string | undefined): string {
  const part = token?.split(".")[1]
  if (part === undefined) return "anon"
  try {
    const claims = JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as {
      sub?: unknown
    }
    return typeof claims.sub === "string" ? claims.sub : "anon"
  } catch {
    return "anon"
  }
}

/** One tab's connection to the leader, shaped like a WebSocket so the client treats it as one. */
class TabSocket implements WebSocketLike {
  readyState = 0
  readonly protocol: string
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly id = randomId()
  leader: string | undefined
  private readonly hub: Hub

  constructor(hub: Hub, protocol: string) {
    this.hub = hub
    this.protocol = protocol
  }

  /** Binds to a leader once one is known. */
  bind(leader: string): void {
    if (this.readyState !== 0 || this.leader !== undefined) return
    this.leader = leader
    this.hub.toLeader({ k: "open", to: leader, from: this.hub.tab, v: this.id })
  }

  opened(): void {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.onopen?.({})
  }

  receive(text: string): void {
    if (this.readyState === 1) this.onmessage?.({ data: text })
  }

  send(data: string): void {
    if (this.readyState !== 1 || this.leader === undefined) return
    this.hub.toLeader({ k: "frame", to: this.leader, v: this.id, text: data })
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return
    if (this.leader !== undefined)
      this.hub.toLeader({ k: "end", to: this.leader, v: this.id, code, reason })
    this.finish(code, reason)
  }

  finish(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.hub.sockets.delete(this.id)
    this.onclose?.({ code, reason })
  }
}

interface Virtual {
  readonly id: string
  readonly tab: string
  subject: string | undefined
  welcomed: boolean
  seq: number
  lastSeen: number
  /** The tab's subscription IDs, mapped to the IDs used on the shared session. */
  readonly subs: Map<string, string>
  /** Collections the tab subscribes to, for `changed` events, which name no subscription. */
  readonly collections: Map<string, number>
}

/**
 * The leader's side: one real session, shared by every tab's virtual session. Subscription IDs are
 * prefixed per virtual session, events and acks are routed back by subscription and mutation ID, and each
 * virtual session gets its own sequence numbers. When the real session is lost without resuming, every
 * virtual session is closed so its client resubscribes and sends its pending mutations again.
 */
class Multiplexer {
  private readonly hub: Hub
  private readonly WebSocketImpl: WebSocketConstructor
  private readonly url: string
  private readonly protocol: string
  private real: WebSocketLike | undefined
  private welcome: WelcomeMessage | undefined
  private sid: string | undefined
  private lastSeq = 0
  private hello: Extract<ClientMessage, { t: "hello" }> | undefined
  private subject = "anon"
  private readonly virtuals = new Map<string, Virtual>()
  private readonly bySub = new Map<string, { readonly v: string; readonly local: string }>()
  private readonly mutations = new Map<string, string>()
  private queued: string[] = []
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private lastInbound = 0
  private closed = false

  constructor(hub: Hub, url: string, protocol: string, WebSocketImpl: WebSocketConstructor) {
    this.hub = hub
    this.url = url
    this.protocol = protocol
    this.WebSocketImpl = WebSocketImpl
  }

  open(tab: string, id: string): void {
    this.virtuals.set(id, {
      id,
      tab,
      subject: undefined,
      welcomed: false,
      seq: 0,
      lastSeen: Date.now(),
      subs: new Map(),
      collections: new Map(),
    })
    this.hub.toTab(tab, { k: "opened", to: tab, v: id })
  }

  end(id: string): void {
    const virtual = this.virtuals.get(id)
    if (virtual === undefined) return
    this.virtuals.delete(id)
    for (const remote of virtual.subs.values()) {
      this.bySub.delete(remote)
      this.forward({ t: "unsub", id: remote })
    }
    for (const [mutation, owner] of this.mutations)
      if (owner === id) this.mutations.delete(mutation)
  }

  /** Closes virtual sessions that stopped sending, such as those of a tab that crashed. */
  sweep(timeoutMs: number): void {
    const now = Date.now()
    for (const virtual of [...this.virtuals.values()]) {
      if (now - virtual.lastSeen <= timeoutMs) continue
      this.end(virtual.id)
      this.hub.toTab(virtual.tab, {
        k: "end",
        to: virtual.tab,
        v: virtual.id,
        code: MOVED,
        reason: "timeout",
      })
    }
  }

  frame(id: string, text: string): void {
    const virtual = this.virtuals.get(id)
    if (virtual === undefined) return
    virtual.lastSeen = Date.now()
    const message = decodeClientMessage(text)
    if (message === undefined) return
    switch (message.t) {
      case "hello": {
        const subject = subjectOf(message.token)
        if (this.hello !== undefined && subject !== this.subject) {
          this.virtuals.delete(id)
          this.hub.toTab(virtual.tab, { k: "refuse", to: virtual.tab, v: id })
          return
        }
        virtual.subject = subject
        if (this.hello === undefined) {
          this.hello = message
          this.subject = subject
          this.connect()
        }
        if (this.welcome !== undefined) this.greet(virtual)
        return
      }
      case "ping":
        this.reply(virtual, encodeMessage({ t: "pong", ts: message.ts }))
        return
      case "auth":
        if (subjectOf(message.token) === this.subject) this.forward(message)
        return
      case "sub": {
        const remote = `${id}.${message.id}`
        if (!virtual.subs.has(message.id))
          virtual.collections.set(message.c, (virtual.collections.get(message.c) ?? 0) + 1)
        virtual.subs.set(message.id, remote)
        this.bySub.set(remote, { v: id, local: message.id })
        this.forward({ ...message, id: remote })
        return
      }
      case "unsub": {
        const remote = virtual.subs.get(message.id)
        if (remote === undefined) return
        virtual.subs.delete(message.id)
        this.forward({ ...message, id: remote })
        return
      }
      case "mut":
        this.mutations.set(message.id, id)
        this.forward(message)
        return
      case "bye":
        this.end(id)
        return
      default:
        this.forward(message)
    }
  }

  private forward(message: ClientMessage): void {
    const text = encodeMessage(message)
    if (this.real !== undefined && this.real.readyState === 1 && this.welcome !== undefined)
      this.real.send(text)
    else this.queued.push(text)
  }

  private reply(virtual: Virtual, text: string): void {
    this.hub.toTab(virtual.tab, { k: "frame", to: virtual.tab, v: virtual.id, text })
  }

  private deliver(virtual: Virtual, message: Record<string, unknown>): void {
    virtual.seq += 1
    this.reply(virtual, encodeMessage({ ...message, seq: virtual.seq } as never))
  }

  private greet(virtual: Virtual): void {
    const welcome = this.welcome
    if (welcome === undefined || virtual.welcomed) return
    virtual.welcomed = true
    virtual.seq = 0
    this.reply(virtual, encodeMessage({ ...welcome, sid: virtual.id, resumed: false, seq: 0 }))
  }

  private connect(): void {
    const hello = this.hello
    if (this.closed || hello === undefined) return
    const socket = new this.WebSocketImpl(this.url, this.protocol)
    this.real = socket
    socket.onopen = () => {
      socket.send(
        encodeMessage({
          ...hello,
          ...(this.sid === undefined ? {} : { resume: { sid: this.sid, seq: this.lastSeq } }),
        }),
      )
    }
    socket.onmessage = (event) => {
      if (typeof event.data === "string") this.receive(event.data)
    }
    socket.onclose = () => {
      if (this.real !== socket) return
      this.real = undefined
      this.welcome = undefined
      clearInterval(this.heartbeat)
      if (this.closed) return
      const delay = Math.random() * Math.min(30_000, 250 * 2 ** this.attempt)
      this.attempt += 1
      this.timer = setTimeout(() => this.connect(), delay)
    }
    socket.onerror = () => {}
  }

  private receive(text: string): void {
    this.lastInbound = Date.now()
    const message = decodeServerMessage(text)
    if (message === undefined) return
    for (const part of unbatch(message)) if (part.t !== "pong") this.route(part)
  }

  private route(message: SequencedMessage): void {
    if (message.t === "welcome") {
      this.attempt = 0
      const resumed = message.resumed && message.sid === this.sid
      this.sid = message.sid
      this.welcome = message
      this.startHeartbeat(message.hb)
      if (!resumed) {
        this.lastSeq = 0
        this.queued = []
        for (const virtual of [...this.virtuals.values()]) {
          if (!virtual.welcomed) continue
          this.end(virtual.id)
          this.hub.toTab(virtual.tab, {
            k: "end",
            to: virtual.tab,
            v: virtual.id,
            code: MOVED,
            reason: "session lost",
          })
        }
      } else {
        for (const text of this.queued.splice(0)) this.real?.send(text)
      }
      for (const virtual of this.virtuals.values())
        if (virtual.subject !== undefined) this.greet(virtual)
      return
    }
    if (message.seq <= this.lastSeq) return
    this.lastSeq = message.seq
    const { seq: _seq, ...body } = message
    switch (body.t) {
      case "added":
      case "removed": {
        for (const [v, locals] of this.split(body.s)) this.deliverTo(v, { ...body, s: locals })
        return
      }
      case "ready":
      case "nosub": {
        const target = this.bySub.get(body.s)
        if (target === undefined) return
        if (body.t === "nosub") this.bySub.delete(body.s)
        this.deliverTo(target.v, { ...body, s: target.local })
        return
      }
      case "ack": {
        const owner = this.mutations.get(body.m)
        if (owner === undefined) return
        this.mutations.delete(body.m)
        this.deliverTo(owner, body)
        return
      }
      case "changed":
        for (const virtual of this.virtuals.values())
          if (virtual.welcomed && (virtual.collections.get(body.c) ?? 0) > 0)
            this.deliver(virtual, body)
        return
      case "resync": {
        if (body.s === undefined) {
          for (const virtual of this.virtuals.values())
            if (virtual.welcomed) this.deliver(virtual, body)
          return
        }
        for (const [v, locals] of this.split(body.s)) this.deliverTo(v, { ...body, s: locals })
        return
      }
      case "reconnect": {
        const socket = this.real
        this.real = undefined
        this.welcome = undefined
        socket?.close(1000, "server asked to reconnect")
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.connect(), body.retryAfterMs)
        return
      }
      case "wm":
        for (const virtual of this.virtuals.values())
          if (virtual.welcomed) this.deliver(virtual, body)
        return
      default:
        return
    }
  }

  private split(remotes: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const remote of remotes) {
      const target = this.bySub.get(remote)
      if (target === undefined) continue
      const list = out.get(target.v) ?? []
      list.push(target.local)
      out.set(target.v, list)
    }
    return out
  }

  private deliverTo(id: string, message: Record<string, unknown>): void {
    const virtual = this.virtuals.get(id)
    if (virtual?.welcomed === true) this.deliver(virtual, message)
  }

  private startHeartbeat(ms: number): void {
    clearInterval(this.heartbeat)
    this.lastInbound = Date.now()
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastInbound > 2 * ms) {
        this.real?.close(4000, "heartbeat timeout")
        return
      }
      if (this.real?.readyState === 1) this.real.send(encodeMessage({ t: "ping", ts: Date.now() }))
    }, ms)
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    clearInterval(this.heartbeat)
    if (this.real?.readyState === 1) this.real.send(encodeMessage({ t: "bye" }))
    this.real?.close(1000, "leader left")
    this.real = undefined
  }
}

/** The coordinator of one page: it elects the leader, carries envelopes and holds the tab's sockets. */
class Hub {
  readonly tab = randomId()
  readonly sockets = new Map<string, TabSocket>()
  leader: string | undefined
  direct = false
  private readonly channel: ChannelLike
  private multiplexer: Multiplexer | undefined
  private target: { url: string; protocol: string; WebSocketImpl: WebSocketConstructor } | undefined
  private sweeper: ReturnType<typeof setInterval> | undefined
  private release: (() => void) | undefined
  private readonly tabTimeoutMs: number

  constructor(
    name: string,
    locks: LockManagerLike,
    Channel: new (name: string) => ChannelLike,
    tabTimeoutMs: number,
  ) {
    this.tabTimeoutMs = tabTimeoutMs
    this.channel = new Channel(`canopy:${name}`)
    this.channel.onmessage = (event) => this.envelope(event.data as Envelope)
    void locks
      .request(`canopy:${name}`, () => {
        this.lead()
        return new Promise<void>((resolve) => {
          this.release = resolve
        })
      })
      .catch(() => {})
    this.channel.postMessage({ k: "who", from: this.tab } satisfies Envelope)
  }

  get isLeader(): boolean {
    return this.leader === this.tab
  }

  socket(url: string, protocol: string, WebSocketImpl: WebSocketConstructor): WebSocketLike {
    this.target ??= { url, protocol, WebSocketImpl }
    const socket = new TabSocket(this, protocol)
    this.sockets.set(socket.id, socket)
    if (this.leader !== undefined) socket.bind(this.leader)
    return socket
  }

  private lead(): void {
    this.leader = this.tab
    this.announce()
    clearInterval(this.sweeper)
    this.sweeper = setInterval(() => this.multiplexer?.sweep(this.tabTimeoutMs), this.tabTimeoutMs)
  }

  private announce(): void {
    if (this.leader === undefined) return
    const envelope: Envelope = { k: "leader", id: this.leader }
    this.channel.postMessage(envelope)
    this.onLeader(this.leader)
  }

  private onLeader(id: string): void {
    this.leader = id
    for (const socket of [...this.sockets.values()]) {
      if (socket.leader !== undefined && socket.leader !== id)
        socket.finish(MOVED, "leader changed")
      else socket.bind(id)
    }
  }

  private mux(): Multiplexer | undefined {
    const target = this.target
    if (!this.isLeader || target === undefined) return undefined
    this.multiplexer ??= new Multiplexer(this, target.url, target.protocol, target.WebSocketImpl)
    return this.multiplexer
  }

  toLeader(envelope: Envelope): void {
    if (this.isLeader) queueMicrotask(() => this.atLeader(envelope))
    else this.channel.postMessage(envelope)
  }

  toTab(tab: string, envelope: Envelope): void {
    if (tab === this.tab) queueMicrotask(() => this.atTab(envelope))
    else this.channel.postMessage(envelope)
  }

  private atLeader(envelope: Envelope): void {
    const mux = this.mux()
    if (mux === undefined) return
    if (envelope.k === "open") mux.open(envelope.from, envelope.v)
    else if (envelope.k === "frame") mux.frame(envelope.v, envelope.text)
    else if (envelope.k === "end") mux.end(envelope.v)
  }

  private atTab(envelope: Envelope): void {
    if (!("v" in envelope)) return
    const socket = this.sockets.get(envelope.v)
    if (socket === undefined) return
    if (envelope.k === "opened") socket.opened()
    else if (envelope.k === "frame") socket.receive(envelope.text)
    else if (envelope.k === "end") socket.finish(envelope.code, envelope.reason)
    else if (envelope.k === "refuse") {
      this.direct = true
      socket.finish(OTHER_USER, "another user leads")
    }
  }

  private envelope(envelope: Envelope): void {
    switch (envelope.k) {
      case "who":
        if (this.isLeader) this.announce()
        return
      case "leader":
        if (envelope.id !== this.tab) this.onLeader(envelope.id)
        return
      case "open":
      case "frame":
      case "end":
        if (envelope.to === this.tab && this.isLeader) this.atLeader(envelope)
        else if (envelope.to === this.tab) this.atTab(envelope)
        return
      case "opened":
      case "refuse":
        if (envelope.to === this.tab) this.atTab(envelope)
        return
    }
  }

  /** Leaves: a leader hands the lock to the next tab. */
  dispose(): void {
    for (const socket of [...this.sockets.values()]) socket.close(1000, "tab closed")
    this.multiplexer?.close()
    clearInterval(this.sweeper)
    this.release?.()
    this.channel.close()
  }
}

/**
 * Shares one realtime connection between the tabs of an origin. Tabs elect a leader with the Web Locks
 * API; the leader holds the only socket and the others reach it over a `BroadcastChannel`, so a user with
 * ten tabs open costs the server one connection. When the leader tab closes, the next tab takes over and
 * every client resubscribes and resends its pending mutations (with the same mutation IDs, so they stay
 * idempotent). Tabs of another user, and browsers without Web Locks or `BroadcastChannel`, connect
 * directly.
 *
 * ```ts
 * import { leaderTab } from "canopy.js/leader-tab"
 * const canopy = createClient({ url, publishableKey, shared: leaderTab() })
 * ```
 */
export function leaderTab(options: LeaderTabOptions = {}): SharedConnection & { dispose(): void } {
  const locks =
    options.locks ?? (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks
  const Channel =
    options.BroadcastChannel ??
    (globalThis as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel
  let hub: Hub | undefined
  return {
    connect(url, protocol, WebSocketImpl) {
      if (locks === undefined || Channel === undefined || hub?.direct === true)
        return new WebSocketImpl(url, protocol)
      hub ??= new Hub(options.name ?? "default", locks, Channel, options.tabTimeoutMs ?? 75_000)
      return hub.socket(url, protocol, WebSocketImpl)
    },
    dispose() {
      hub?.dispose()
      hub = undefined
    },
  }
}
