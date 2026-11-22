import { type ClusterTime, isClusterTime } from "./cluster-time.ts"
import { type DecodeOptions, parse, stringify } from "./ejson.ts"
import { type ErrorCode, isErrorCode, ProtocolError, type WireError } from "./errors.ts"
import { isDocument } from "./values.ts"

/** The protocol version spoken by this package. */
export const PROTOCOL_VERSION = 1

/** The WebSocket subprotocol for JSON framing of `canopy.v1`. */
export const SUBPROTOCOL = "canopy.v1+json"

/** Capability flags. */
export const Capability = {
  Batch: "batch",
  Diff: "diff",
  MsgPack: "msgpack",
} as const

/** One of the capability flags in {@link Capability}. */
export type Capability = (typeof Capability)[keyof typeof Capability]

/** A decoded document: a plain object with string keys. */
export type Document = Record<string, unknown>

/** A live query as sent in `sub.q`. */
export interface SubQuery {
  readonly filter?: Document
  readonly sort?: Document
  readonly limit?: number
  readonly fields?: Document
}

/** `hello`: the first client frame, carrying credentials and an optional resume position. */
export interface HelloMessage {
  readonly t: "hello"
  readonly v: number
  readonly key: string
  readonly token?: string
  readonly resume?: { readonly sid: string; readonly seq: number }
  readonly caps?: readonly string[]
  readonly sdk?: string
}

/** `auth`: replaces the user token. An empty token downgrades the connection to `anon`. */
export interface AuthMessage {
  readonly t: "auth"
  readonly token: string
}

/**
 * The caller a `sub` explanation is for: `claims` (absent or `null` for `anon`), custom `roles`, and
 * context lookup values in `ctx` (resolved from the database when absent).
 */
export interface ExplainAs {
  readonly claims?: Document | null
  readonly roles?: readonly string[]
  readonly ctx?: Document
}

/** Options of a `sub`. */
export interface SubOptions {
  readonly buffer?: number
  /**
   * Ask for the access report of the subscription in its `ready`: `true` for the connection itself, or a
   * stated caller. Only `service` connections (a secret key) may ask; others get `nosub` with
   * `CANOPY_FORBIDDEN`.
   */
  readonly explain?: true | ExplainAs
}

/** `sub`: subscribes to a live query. */
export interface SubMessage {
  readonly t: "sub"
  readonly id: string
  readonly c: string
  readonly q: SubQuery
  readonly o?: SubOptions
}

/** `unsub`: ends a subscription. */
export interface UnsubMessage {
  readonly t: "unsub"
  readonly id: string
}

/** Mutation operations carried by `mut`. */
export type MutationOp =
  "insert" | "insertMany" | "update" | "updateMany" | "replace" | "delete" | "deleteMany"

/** `mut`: a mutation, identified by a UUIDv7 that doubles as the idempotency key. */
export interface MutMessage {
  readonly t: "mut"
  readonly id: string
  readonly c: string
  readonly op: MutationOp
  readonly args: Document
}

/** `ping`: application level heartbeat. */
export interface PingMessage {
  readonly t: "ping"
  readonly ts: number
}

/** `bye`: graceful close; the server discards the session. */
export interface ByeMessage {
  readonly t: "bye"
}

/** Every message a client may send. */
export type ClientMessage =
  HelloMessage | AuthMessage | SubMessage | UnsubMessage | MutMessage | PingMessage | ByeMessage

/** Limits advertised in `welcome.limits`. */
export interface WelcomeLimits {
  readonly subs: number
  readonly [name: string]: number
}

/** Endpoint features advertised in `welcome.capabilities`. */
export interface WelcomeCapabilities {
  /** Whether this endpoint accepts mutations over the realtime protocol. */
  readonly mutations: boolean
}

/** `welcome`: the handshake result. */
export interface WelcomeMessage {
  readonly t: "welcome"
  readonly seq: number
  readonly sid: string
  readonly v: number
  readonly resumed: boolean
  readonly hb: number
  readonly pv: string
  readonly ct: ClusterTime
  readonly caps: readonly string[]
  /** Omitted when the endpoint's capabilities are unknown. */
  readonly capabilities?: WelcomeCapabilities
  readonly limits: WelcomeLimits
}

/** `added`: a document enters the listed subscriptions. */
export interface AddedMessage {
  readonly t: "added"
  readonly seq: number
  readonly c: string
  readonly id: unknown
  readonly d?: Document
  readonly ct: ClusterTime
  readonly s: readonly string[]
}

/** `changed`: a document level change, applied once to the client cache. */
export interface ChangedMessage {
  readonly t: "changed"
  readonly seq: number
  readonly c: string
  readonly id: unknown
  readonly ct: ClusterTime
  readonly set?: Document
  readonly unset?: readonly string[]
  readonly d?: Document
  readonly replace?: true
  readonly refetch?: true
}

/** `removed`: a document leaves the listed subscriptions. */
export interface RemovedMessage {
  readonly t: "removed"
  readonly seq: number
  readonly c: string
  readonly id: unknown
  readonly ct: ClusterTime
  readonly s: readonly string[]
}

/** `ready`: the initial snapshot of a subscription is complete. */
export interface ReadyMessage {
  readonly t: "ready"
  readonly seq: number
  readonly s: string
  readonly ct: ClusterTime
  /** The access report the `sub` asked for with `o.explain`, sent with the first `ready` only. */
  readonly explain?: Document
}

/** `nosub`: a subscription ended. */
export interface NosubMessage {
  readonly t: "nosub"
  readonly seq: number
  readonly s: string
  readonly err?: WireError
}

/** The result carried by an `ack`. */
export interface AckResult {
  readonly matched: number
  readonly modified: number
  readonly insertedIds?: readonly unknown[]
  readonly docs?: readonly Document[]
}

/** `ack`: a mutation result. */
export interface AckMessage {
  readonly t: "ack"
  readonly seq: number
  readonly m: string
  readonly ok: boolean
  readonly ct?: ClusterTime
  readonly echo?: boolean
  readonly res?: AckResult
  readonly replayed?: boolean
  readonly err?: WireError
}

/** `wm`: progress heartbeat. */
export interface WatermarkMessage {
  readonly t: "wm"
  readonly seq: number
  readonly ct: ClusterTime
}

/** `resync`: gap free delivery can no longer be guaranteed for the listed (or all) subscriptions. */
export interface ResyncMessage {
  readonly t: "resync"
  readonly seq: number
  readonly reason: string
  readonly s?: readonly string[]
}

/** `reconnect`: the server is draining. */
export interface ReconnectMessage {
  readonly t: "reconnect"
  readonly seq: number
  readonly retryAfterMs: number
  readonly reason: string
}

/** `err`: a connection level error. */
export interface ErrMessage {
  readonly t: "err"
  readonly seq: number
  readonly code: ErrorCode
  readonly msg: string
}

/** `pong`: heartbeat reply. It carries no `seq`. */
export interface PongMessage {
  readonly t: "pong"
  readonly ts: number
}

/** Every sequenced server message. */
export type SequencedMessage =
  | WelcomeMessage
  | AddedMessage
  | ChangedMessage
  | RemovedMessage
  | ReadyMessage
  | NosubMessage
  | AckMessage
  | WatermarkMessage
  | ResyncMessage
  | ReconnectMessage
  | ErrMessage

/** `batch`: a container of sequenced messages, each with its own `seq`. */
export interface BatchMessage {
  readonly t: "batch"
  readonly m: readonly SequencedMessage[]
}

/** Every message a server may send. */
export type ServerMessage = SequencedMessage | BatchMessage | PongMessage

const DEFAULT_DECODE: DecodeOptions = { maxDepth: 40, maxNodes: 200_000 }
const MUTATION_OPS: ReadonlySet<string> = new Set([
  "insert",
  "insertMany",
  "update",
  "updateMany",
  "replace",
  "delete",
  "deleteMany",
])
const SUB_ID = /^[\w.:-]{1,64}$/
const COLLECTION = /^[^\0$][^\0]{0,119}$/

/** Serializes a client or server message to its JSON text frame. */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return stringify(message)
}

function fail(message: string): never {
  throw new ProtocolError(message)
}

function field<T>(
  record: Document,
  name: string,
  check: (value: unknown) => value is T,
  what: string,
): T {
  const value = record[name]
  if (!check(value)) fail(`"${name}" must be ${what}`)
  return value
}

function optionalField<T>(
  record: Document,
  name: string,
  check: (value: unknown) => value is T,
  what: string,
): T | undefined {
  if (record[name] === undefined) return undefined
  return field(record, name, check, what)
}

const isString = (value: unknown): value is string => typeof value === "string"
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean"
const isSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)
const isDoc = (value: unknown): value is Document => isDocument(value)
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
const isSubId = (value: unknown): value is string => typeof value === "string" && SUB_ID.test(value)
const isCollection = (value: unknown): value is string =>
  typeof value === "string" && COLLECTION.test(value)

const MAX_EXPLAIN_ROLES = 32

function decodeExplain(value: unknown): true | ExplainAs | undefined {
  if (value === undefined || value === false) return undefined
  if (value === true) return true
  if (!isDocument(value)) return fail('"o.explain" must be true or { claims, roles, ctx }')
  for (const key of Object.keys(value))
    if (key !== "claims" && key !== "roles" && key !== "ctx")
      fail(`"o.explain" has an unknown field "${key}"`)
  const claims = value["claims"]
  if (claims !== undefined && claims !== null && !isDocument(claims))
    fail('"o.explain.claims" must be an object or null')
  const roles = optionalField(value, "roles", isStringArray, "a list of role names")
  if (roles !== undefined && roles.length > MAX_EXPLAIN_ROLES)
    fail(`"o.explain.roles" may list at most ${MAX_EXPLAIN_ROLES} roles`)
  const ctx = optionalField(value, "ctx", isDoc, "an object")
  return {
    ...(claims === undefined ? {} : { claims }),
    ...(roles === undefined ? {} : { roles }),
    ...(ctx === undefined ? {} : { ctx }),
  }
}

function wireError(value: unknown): WireError | undefined {
  if (value === undefined) return undefined
  if (!isDocument(value) || !isErrorCode(value["code"]) || typeof value["msg"] !== "string") {
    return fail('"err" must be { code, msg } with a known code')
  }
  return { code: value["code"], msg: value["msg"] }
}

function decodeObject(text: string, options: DecodeOptions | undefined): Document {
  let value: unknown
  try {
    value = parse(text, options ?? DEFAULT_DECODE)
  } catch (error: unknown) {
    throw new ProtocolError("Frame is not valid EJSON", { cause: error })
  }
  if (!isDocument(value)) fail("A frame must be a JSON object")
  return value
}

function decodeSubQuery(value: unknown): SubQuery {
  if (!isDocument(value)) return fail('"q" must be an object')
  const out: { filter?: Document; sort?: Document; limit?: number; fields?: Document } = {}
  const filter = optionalField(value, "filter", isDoc, "an object")
  const sort = optionalField(value, "sort", isDoc, "an object")
  const limit = optionalField(value, "limit", isSeq, "a non negative integer")
  const fields = optionalField(value, "fields", isDoc, "an object")
  if (filter !== undefined) out.filter = filter
  if (sort !== undefined) out.sort = sort
  if (limit !== undefined) out.limit = limit
  if (fields !== undefined) out.fields = fields
  return out
}

/**
 * Decodes and validates a client frame. Returns `undefined` for a well formed frame of an unknown type, which
 * the server may ignore. Throws {@link ProtocolError} for malformed frames.
 */
export function decodeClientMessage(
  text: string,
  options?: DecodeOptions,
): ClientMessage | undefined {
  const raw = decodeObject(text, options)
  const t = field(raw, "t", isNonEmptyString, "a message type")
  switch (t) {
    case "hello": {
      const v = field(raw, "v", isSeq, "a protocol version")
      const key = field(raw, "key", isString, "a string")
      const token = optionalField(raw, "token", isString, "a string")
      const caps = optionalField(raw, "caps", isStringArray, "an array of strings")
      const sdk = optionalField(raw, "sdk", isString, "a string")
      const resumeRaw = optionalField(raw, "resume", isDoc, "an object")
      let resume: { sid: string; seq: number } | undefined
      if (resumeRaw !== undefined) {
        resume = {
          sid: field(resumeRaw, "sid", isNonEmptyString, "a session id"),
          seq: field(resumeRaw, "seq", isSeq, "a sequence number"),
        }
      }
      return {
        t: "hello",
        v,
        key,
        ...(token === undefined ? {} : { token }),
        ...(resume === undefined ? {} : { resume }),
        ...(caps === undefined ? {} : { caps }),
        ...(sdk === undefined ? {} : { sdk }),
      }
    }
    case "auth":
      return { t: "auth", token: field(raw, "token", isString, "a string") }
    case "sub": {
      const id = field(raw, "id", isSubId, "a subscription id of at most 64 word characters")
      const c = field(raw, "c", isCollection, "a collection name")
      const q = decodeSubQuery(raw["q"] ?? Object.create(null))
      const oRaw = optionalField(raw, "o", isDoc, "an object")
      if (oRaw === undefined) return { t: "sub", id, c, q }
      const buffer = optionalField(oRaw, "buffer", isSeq, "a non negative integer")
      const explain = decodeExplain(oRaw["explain"])
      return {
        t: "sub",
        id,
        c,
        q,
        o: {
          ...(buffer === undefined ? {} : { buffer }),
          ...(explain === undefined ? {} : { explain }),
        },
      }
    }
    case "unsub":
      return { t: "unsub", id: field(raw, "id", isSubId, "a subscription id") }
    case "mut": {
      const id = field(raw, "id", isNonEmptyString, "a mutation id")
      const c = field(raw, "c", isCollection, "a collection name")
      const op = field(
        raw,
        "op",
        (v): v is MutationOp => isString(v) && MUTATION_OPS.has(v),
        "a mutation op",
      )
      const args = field(raw, "args", isDoc, "an object")
      return { t: "mut", id, c, op, args }
    }
    case "ping":
      return { t: "ping", ts: field(raw, "ts", isFiniteNumber, "a number") }
    case "bye":
      return { t: "bye" }
    default:
      return undefined
  }
}

function decodeSequenced(raw: Document, t: string): SequencedMessage | undefined {
  const seq = field(raw, "seq", isSeq, "a sequence number")
  const ct = (): ClusterTime => field(raw, "ct", isClusterTime, "a cluster time")
  switch (t) {
    case "welcome": {
      const capabilities = optionalField(raw, "capabilities", isDoc, "an object")
      const limits = field(raw, "limits", isDoc, "an object")
      const parsedLimits = {
        subs: 0,
        ...Object.fromEntries(
          Object.entries(limits).flatMap(([name, value]) =>
            isFiniteNumber(value) ? [[name, value] as const] : [],
          ),
        ),
      }
      return {
        t: "welcome",
        seq,
        sid: field(raw, "sid", isNonEmptyString, "a session id"),
        v: field(raw, "v", isSeq, "a protocol version"),
        resumed: field(raw, "resumed", isBoolean, "a boolean"),
        hb: field(raw, "hb", isSeq, "a heartbeat interval"),
        pv: field(raw, "pv", isString, "a policy version"),
        ct: ct(),
        caps: field(raw, "caps", isStringArray, "an array of strings"),
        ...(capabilities === undefined
          ? {}
          : {
              capabilities: { mutations: field(capabilities, "mutations", isBoolean, "a boolean") },
            }),
        limits: parsedLimits as WelcomeLimits,
      }
    }
    case "added":
    case "removed": {
      const c = field(raw, "c", isCollection, "a collection name")
      if (raw["id"] === undefined) fail('"id" is required')
      const s = field(raw, "s", isStringArray, "an array of subscription ids")
      if (t === "removed") return { t: "removed", seq, c, id: raw["id"], ct: ct(), s }
      const d = optionalField(raw, "d", isDoc, "a document")
      return { t: "added", seq, c, id: raw["id"], ct: ct(), s, ...(d === undefined ? {} : { d }) }
    }
    case "changed": {
      const c = field(raw, "c", isCollection, "a collection name")
      if (raw["id"] === undefined) fail('"id" is required')
      const set = optionalField(raw, "set", isDoc, "a document")
      const unset = optionalField(raw, "unset", isStringArray, "an array of paths")
      const d = optionalField(raw, "d", isDoc, "a document")
      const replace = raw["replace"] === true
      const refetch = raw["refetch"] === true
      if (replace && d === undefined) fail('"replace" requires "d"')
      return {
        t: "changed",
        seq,
        c,
        id: raw["id"],
        ct: ct(),
        ...(set === undefined ? {} : { set }),
        ...(unset === undefined ? {} : { unset }),
        ...(d === undefined ? {} : { d }),
        ...(replace ? { replace: true as const } : {}),
        ...(refetch ? { refetch: true as const } : {}),
      }
    }
    case "ready": {
      const explain = optionalField(raw, "explain", isDoc, "an object")
      return {
        t: "ready",
        seq,
        s: field(raw, "s", isSubId, "a subscription id"),
        ct: ct(),
        ...(explain === undefined ? {} : { explain }),
      }
    }
    case "nosub": {
      const err = wireError(raw["err"])
      const s = field(raw, "s", isSubId, "a subscription id")
      return err === undefined ? { t: "nosub", seq, s } : { t: "nosub", seq, s, err }
    }
    case "ack": {
      const err = wireError(raw["err"])
      const ackCt = optionalField(raw, "ct", isClusterTime, "a cluster time")
      const echo = optionalField(raw, "echo", isBoolean, "a boolean")
      const replayed = optionalField(raw, "replayed", isBoolean, "a boolean")
      const resRaw = optionalField(raw, "res", isDoc, "an object")
      let res: AckResult | undefined
      if (resRaw !== undefined) {
        const insertedIds = resRaw["insertedIds"]
        const docs = resRaw["docs"]
        if (insertedIds !== undefined && !Array.isArray(insertedIds))
          fail('"insertedIds" must be an array')
        if (docs !== undefined && !(Array.isArray(docs) && docs.every(isDocument))) {
          fail('"docs" must be an array of documents')
        }
        res = {
          matched: field(resRaw, "matched", isSeq, "a count"),
          modified: field(resRaw, "modified", isSeq, "a count"),
          ...(insertedIds === undefined ? {} : { insertedIds: insertedIds as unknown[] }),
          ...(docs === undefined ? {} : { docs: docs as Document[] }),
        }
      }
      return {
        t: "ack",
        seq,
        m: field(raw, "m", isNonEmptyString, "a mutation id"),
        ok: field(raw, "ok", isBoolean, "a boolean"),
        ...(ackCt === undefined ? {} : { ct: ackCt }),
        ...(echo === undefined ? {} : { echo }),
        ...(res === undefined ? {} : { res }),
        ...(replayed === undefined ? {} : { replayed }),
        ...(err === undefined ? {} : { err }),
      }
    }
    case "wm":
      return { t: "wm", seq, ct: ct() }
    case "resync": {
      const s = optionalField(raw, "s", isStringArray, "an array of subscription ids")
      const reason = field(raw, "reason", isString, "a string")
      return s === undefined ? { t: "resync", seq, reason } : { t: "resync", seq, reason, s }
    }
    case "reconnect":
      return {
        t: "reconnect",
        seq,
        retryAfterMs: field(raw, "retryAfterMs", isSeq, "a delay in milliseconds"),
        reason: field(raw, "reason", isString, "a string"),
      }
    case "err":
      return {
        t: "err",
        seq,
        code: field(raw, "code", isErrorCode, "a known error code"),
        msg: field(raw, "msg", isString, "a string"),
      }
    default:
      return undefined
  }
}

/**
 * Decodes and validates a server frame. Returns `undefined` for frames of unknown types, which clients must
 * ignore. Unknown messages inside a `batch` are dropped.
 */
export function decodeServerMessage(
  text: string,
  options?: DecodeOptions,
): ServerMessage | undefined {
  const raw = decodeObject(text, options)
  const t = field(raw, "t", isNonEmptyString, "a message type")
  if (t === "pong") return { t: "pong", ts: field(raw, "ts", isFiniteNumber, "a number") }
  if (t === "batch") {
    const items = raw["m"]
    if (!Array.isArray(items)) fail('"m" must be an array')
    const m: SequencedMessage[] = []
    for (const item of items) {
      if (!isDocument(item)) fail("batch items must be objects")
      const inner = field(item, "t", isNonEmptyString, "a message type")
      const decoded = decodeSequenced(item, inner)
      if (decoded !== undefined) m.push(decoded)
    }
    return { t: "batch", m }
  }
  return decodeSequenced(raw, t)
}

/** Flattens a server message into its sequenced parts, unwrapping `batch` containers. */
export function unbatch(message: ServerMessage): readonly (SequencedMessage | PongMessage)[] {
  return message.t === "batch" ? message.m : [message]
}
