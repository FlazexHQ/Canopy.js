import { InvalidQueryError } from "../core/protocol/index.ts"

/** Raised when a policy definition breaks a validation rule. */
export class PolicyValidationError extends InvalidQueryError {
  static {
    PolicyValidationError.registerType(PolicyValidationError.prototype, "PolicyValidationError")
  }

  readonly collection: string

  constructor(collection: string, message: string) {
    super(`Invalid policies for collection '${collection}': ${message}`)
    this.collection = collection
  }
}
