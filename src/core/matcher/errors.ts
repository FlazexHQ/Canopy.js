import { type CanopyErrorOptions, InvalidQueryError } from "../protocol/index.ts"

/**
 * Raised for a valid MongoDB query construct that the in-process matcher does not evaluate, such as `$expr`,
 * geo operators or a regular expression that needs backtracking. Callers route such queries to MongoDB (a
 * polling observer) instead of rejecting them.
 */
export class UnsupportedQueryError extends InvalidQueryError {
  static {
    UnsupportedQueryError.registerType(UnsupportedQueryError.prototype, "UnsupportedQueryError")
  }

  constructor(message: string, options?: CanopyErrorOptions) {
    super(message, options)
  }
}

/** Raised by the updater when MongoDB would reject the update. The message mirrors MongoDB's reason. */
export class UpdateError extends InvalidQueryError {
  static {
    UpdateError.registerType(UpdateError.prototype, "UpdateError")
  }

  constructor(message: string, options?: CanopyErrorOptions) {
    super(message, options)
  }
}
