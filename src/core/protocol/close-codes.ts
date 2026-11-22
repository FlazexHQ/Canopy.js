/** WebSocket close codes used by `canopy.v1`. */
export const CloseCode = {
  Normal: 1000,
  ServiceRestart: 1012,
  Unauthorized: 4001,
  Forbidden: 4003,
  HelloTimeout: 4008,
  FrameTooLarge: 4009,
  UnsupportedVersion: 4010,
  RateLimited: 4029,
  SlowConsumer: 4040,
  ProtocolError: 4400,
  InternalError: 4500,
} as const

/** One of the close codes in {@link CloseCode}. */
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode]

/** How an SDK reacts to a close code. */
export interface CloseReaction {
  /** Whether the client should reconnect at all. */
  readonly reconnect: boolean
  /** The smallest delay before reconnecting, in milliseconds. */
  readonly minDelayMs: number
  /** Whether the token must be refreshed before reconnecting. */
  readonly refreshToken: boolean
  /** Whether the client should try to resume the previous session. */
  readonly resume: boolean
}

const REACTIONS: Readonly<Record<number, CloseReaction>> = {
  [CloseCode.Normal]: { reconnect: false, minDelayMs: 0, refreshToken: false, resume: false },
  [CloseCode.ServiceRestart]: { reconnect: true, minDelayMs: 0, refreshToken: false, resume: true },
  [CloseCode.Unauthorized]: { reconnect: true, minDelayMs: 0, refreshToken: true, resume: true },
  [CloseCode.Forbidden]: { reconnect: false, minDelayMs: 0, refreshToken: false, resume: false },
  [CloseCode.HelloTimeout]: { reconnect: true, minDelayMs: 250, refreshToken: false, resume: true },
  [CloseCode.FrameTooLarge]: {
    reconnect: true,
    minDelayMs: 250,
    refreshToken: false,
    resume: true,
  },
  [CloseCode.UnsupportedVersion]: {
    reconnect: false,
    minDelayMs: 0,
    refreshToken: false,
    resume: false,
  },
  [CloseCode.RateLimited]: {
    reconnect: true,
    minDelayMs: 30_000,
    refreshToken: false,
    resume: true,
  },
  [CloseCode.SlowConsumer]: { reconnect: true, minDelayMs: 0, refreshToken: false, resume: true },
  [CloseCode.ProtocolError]: {
    reconnect: true,
    minDelayMs: 250,
    refreshToken: false,
    resume: false,
  },
  [CloseCode.InternalError]: {
    reconnect: true,
    minDelayMs: 250,
    refreshToken: false,
    resume: true,
  },
}

const DEFAULT_REACTION: CloseReaction = {
  reconnect: true,
  minDelayMs: 250,
  refreshToken: false,
  resume: true,
}

/** Returns the SDK reaction for a close code. Unknown codes reconnect with backoff. */
export function closeReaction(code: number): CloseReaction {
  return REACTIONS[code] ?? DEFAULT_REACTION
}
