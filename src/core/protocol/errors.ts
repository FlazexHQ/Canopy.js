/**
 * Stable error codes shared by the wire protocol and REST Problem Details.
 * Values never change within a major protocol version.
 */
export const ErrorCode = {
  Unauthorized: "CANOPY_UNAUTHORIZED",
  TokenExpired: "CANOPY_TOKEN_EXPIRED",
  Forbidden: "CANOPY_FORBIDDEN",
  NotFound: "CANOPY_NOT_FOUND",
  PolicyViolation: "CANOPY_POLICY_VIOLATION",
  InvalidQuery: "CANOPY_INVALID_QUERY",
  Conflict: "CANOPY_CONFLICT",
  DuplicateKey: "CANOPY_DUPLICATE_KEY",
  PayloadTooLarge: "CANOPY_PAYLOAD_TOO_LARGE",
  ValidationFailed: "CANOPY_VALIDATION_FAILED",
  RateLimited: "CANOPY_RATE_LIMITED",
  LimitSubscriptions: "CANOPY_LIMIT_SUBSCRIPTIONS",
  SubscriptionTooLarge: "CANOPY_SUBSCRIPTION_TOO_LARGE",
  BulkLimit: "CANOPY_BULK_LIMIT",
  CollectionDropped: "CANOPY_COLLECTION_DROPPED",
  SessionMoved: "CANOPY_SESSION_MOVED",
  ProtocolError: "CANOPY_PROTOCOL_ERROR",
  Timeout: "CANOPY_TIMEOUT",
  Unavailable: "CANOPY_UNAVAILABLE",
  Internal: "CANOPY_INTERNAL",
  /** The built in auth claims hook threw, timed out or produced an oversized token; no token was issued. */
  AuthHookFailed: "CANOPY_AUTH_HOOK_FAILED",
  /** Local only: a configuration that does not validate. Never sent over the wire. */
  ConfigInvalid: "CANOPY_CONFIG_INVALID",
} as const

/** One of the stable `CANOPY_*` error codes. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  CANOPY_UNAUTHORIZED: 401,
  CANOPY_TOKEN_EXPIRED: 401,
  CANOPY_FORBIDDEN: 403,
  CANOPY_NOT_FOUND: 404,
  CANOPY_POLICY_VIOLATION: 403,
  CANOPY_INVALID_QUERY: 400,
  CANOPY_CONFLICT: 409,
  CANOPY_DUPLICATE_KEY: 409,
  CANOPY_PAYLOAD_TOO_LARGE: 413,
  CANOPY_VALIDATION_FAILED: 422,
  CANOPY_RATE_LIMITED: 429,
  CANOPY_LIMIT_SUBSCRIPTIONS: 429,
  CANOPY_SUBSCRIPTION_TOO_LARGE: 400,
  CANOPY_BULK_LIMIT: 400,
  CANOPY_COLLECTION_DROPPED: 410,
  CANOPY_SESSION_MOVED: 409,
  CANOPY_PROTOCOL_ERROR: 400,
  CANOPY_TIMEOUT: 504,
  CANOPY_UNAVAILABLE: 503,
  CANOPY_INTERNAL: 500,
  CANOPY_AUTH_HOOK_FAILED: 500,
  CANOPY_CONFIG_INVALID: 500,
}

const CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode))

/** Returns true when `value` is one of the known error codes. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && CODES.has(value)
}

/** Returns the HTTP status that REST responses use for `code`. */
export function httpStatusOf(code: ErrorCode): number {
  return HTTP_STATUS[code]
}

/** Options accepted by {@link CanopyError}. */
export interface CanopyErrorOptions {
  /** Structured, non secret details that may be returned to the caller. */
  readonly details?: Readonly<Record<string, unknown>>
  /** The underlying error, kept for logs and never serialized to clients. */
  readonly cause?: unknown
  /** What the caller can try next. Defaults to the hint of the code, when it has one. */
  readonly hint?: string
  /** The slug of the docs page under `errors/`. Defaults to the page of the code, when it has one. */
  readonly docs?: string
}

/** What to try next for the codes callers meet most, and the docs page under `errors/` about each. */
const HELP: Readonly<Partial<Record<ErrorCode, { readonly hint: string; readonly docs: string }>>> =
  {
    CANOPY_UNAUTHORIZED: {
      hint: "Send an API key in the apikey header, and a signed in user's token as Authorization: Bearer <token>.",
      docs: "unauthorized",
    },
    CANOPY_TOKEN_EXPIRED: {
      hint: "Refresh the access token and retry; the SDK does this itself when it is given a token provider.",
      docs: "token-expired",
    },
    CANOPY_FORBIDDEN: {
      hint: "No policy grants this operation to the caller's roles: add an allow rule, or check the roles in the token.",
      docs: "forbidden",
    },
    CANOPY_NOT_FOUND: {
      hint: "The document does not exist, or no read policy lets the caller see it.",
      docs: "not-found",
    },
    CANOPY_POLICY_VIOLATION: {
      hint: "The write failed a policy's where or check clause, or touched a field the caller may not write.",
      docs: "policy-violation",
    },
    CANOPY_INVALID_QUERY: {
      hint: "Check the operators, field paths and value types; operators Canopy does not support are refused.",
      docs: "invalid-query",
    },
    CANOPY_CONFLICT: {
      hint: "The document changed since it was read: read it again and retry the write.",
      docs: "conflict",
    },
    CANOPY_VALIDATION_FAILED: {
      hint: "The collection's validator refused the document: compare the document with its JSON Schema.",
      docs: "validation-failed",
    },
    CANOPY_RATE_LIMITED: {
      hint: "Wait for Retry-After (or details.retryAfterSeconds) before sending more.",
      docs: "rate-limited",
    },
    CANOPY_SUBSCRIPTION_TOO_LARGE: {
      hint: "Give the live query a limit, or narrow its filter.",
      docs: "subscription-too-large",
    },
  }

const BRAND: unique symbol = Symbol.for("canopy.error")

/**
 * The root of every error Canopy throws. `code` is stable and safe to branch on; `message` is for humans.
 */
export class CanopyError extends Error {
  readonly code: ErrorCode
  readonly details: Readonly<Record<string, unknown>> | undefined
  /** What the caller can try next, for the common codes. */
  readonly hint: string | undefined
  /** The slug of the docs page about this error, under `errors/` on the documentation site. */
  readonly docs: string | undefined

  constructor(code: ErrorCode, message: string, options: CanopyErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "CanopyError"
    this.code = code
    this.details = options.details
    this.hint = options.hint ?? HELP[code]?.hint
    this.docs = options.docs ?? HELP[code]?.docs
    Object.defineProperty(this, BRAND, { value: true })
  }

  /** The HTTP status used when this error is returned as Problem Details. */
  get status(): number {
    return httpStatusOf(this.code)
  }

  /** The `{ code, msg }` shape used by protocol `err`, `nosub` and `ack` messages. */
  toWire(): WireError {
    return { code: this.code, msg: this.message }
  }
}

/** The error shape carried inside protocol messages. */
export interface WireError {
  readonly code: ErrorCode
  readonly msg: string
}

/** Raised when a token or key is missing, invalid or expired. */
export class UnauthorizedError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions, expired = false) {
    super(expired ? ErrorCode.TokenExpired : ErrorCode.Unauthorized, message, options)
    this.name = "UnauthorizedError"
  }
}

/** Raised when an operation is not granted at all, or the caller is revoked or banned. */
export class ForbiddenError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions) {
    super(ErrorCode.Forbidden, message, options)
    this.name = "ForbiddenError"
  }
}

/** Raised when a collection or document does not exist or is not visible to the caller. */
export class NotFoundError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions) {
    super(ErrorCode.NotFound, message, options)
    this.name = "NotFoundError"
  }
}

/** Raised when a write fails a `check` clause. */
export class PolicyViolationError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions) {
    super(ErrorCode.PolicyViolation, message, options)
    this.name = "PolicyViolationError"
  }
}

/** Raised for malformed queries, banned operators, unreadable path references and exceeded query limits. */
export class InvalidQueryError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions) {
    super(ErrorCode.InvalidQuery, message, options)
    this.name = "InvalidQueryError"
  }
}

/** Raised when a compare and set precondition fails or a mutation ID is reused by another subject. */
export class ConflictError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions) {
    super(ErrorCode.Conflict, message, options)
    this.name = "ConflictError"
  }
}

/** Raised when a document fails validation. */
export class ValidationError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions) {
    super(ErrorCode.ValidationFailed, message, options)
    this.name = "ValidationError"
  }
}

/** Raised when a rate or resource limit is exceeded. */
export class RateLimitError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions) {
    super(ErrorCode.RateLimited, message, options)
    this.name = "RateLimitError"
  }
}

/** Raised when a peer violates the wire protocol. */
export class ProtocolError extends CanopyError {
  constructor(message: string, options?: CanopyErrorOptions) {
    super(ErrorCode.ProtocolError, message, options)
    this.name = "ProtocolError"
  }
}

/** The claims hook of built in auth failed, so no access token was issued (fail closed). */
export class AuthHookFailedError extends CanopyError {
  constructor(message: string, options: CanopyErrorOptions = {}) {
    super(ErrorCode.AuthHookFailed, message, options)
    this.name = "AuthHookFailedError"
  }
}

/**
 * Builds the most specific {@link CanopyError} subclass for a wire error. `options` carries what a
 * transport adds, such as the details of a Problem Details response.
 */
export function errorFromWire(error: WireError, options: CanopyErrorOptions = {}): CanopyError {
  switch (error.code) {
    case ErrorCode.Unauthorized:
      return new UnauthorizedError(error.msg, options)
    case ErrorCode.TokenExpired:
      return new UnauthorizedError(error.msg, options, true)
    case ErrorCode.Forbidden:
      return new ForbiddenError(error.msg, options)
    case ErrorCode.NotFound:
      return new NotFoundError(error.msg, options)
    case ErrorCode.PolicyViolation:
      return new PolicyViolationError(error.msg, options)
    case ErrorCode.InvalidQuery:
      return new InvalidQueryError(error.msg, options)
    case ErrorCode.Conflict:
      return new ConflictError(error.msg, options)
    case ErrorCode.ValidationFailed:
      return new ValidationError(error.msg, options)
    case ErrorCode.RateLimited:
      return new RateLimitError(error.msg, options)
    case ErrorCode.ProtocolError:
      return new ProtocolError(error.msg, options)
    case ErrorCode.AuthHookFailed:
      return new AuthHookFailedError(error.msg, options)
    default:
      return new CanopyError(error.code, error.msg, options)
  }
}

/**
 * Whether `error` is a {@link CanopyError}, optionally with a given code: `isCanopyError(e, "CANOPY_CONFLICT")`.
 * It narrows `error.code` and works across duplicate copies of the package, where `instanceof` does not.
 */
export function isCanopyError<C extends ErrorCode = ErrorCode>(
  error: unknown,
  code?: C,
): error is CanopyError & { readonly code: C } {
  if (typeof error !== "object" || error === null) return false
  if (!(error instanceof CanopyError) && (error as { [BRAND]?: unknown })[BRAND] !== true)
    return false
  return code === undefined || (error as { code?: unknown }).code === code
}

/** Converts any thrown value into a {@link CanopyError}, mapping unknown failures to `CANOPY_INTERNAL`. */
export function toCanopyError(error: unknown): CanopyError {
  if (error instanceof CanopyError) return error
  return new CanopyError(ErrorCode.Internal, "Internal error", { cause: error })
}
