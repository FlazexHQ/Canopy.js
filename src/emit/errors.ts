/** The part of a bundle a refusal belongs to. */
export type BundlePart = "config" | "policies" | "tests" | "schema"

/** The stable codes of authoring refusals. */
export type AuthoringCode =
  "CANOPY_INVALID_QUERY" | "CANOPY_CONFIG_INVALID" | "CANOPY_SCHEMA_INVALID" | "CANOPY_INTERNAL"

/** The code each part reports its refusals with. */
export const PART_CODES: Readonly<Record<BundlePart, AuthoringCode>> = {
  config: "CANOPY_CONFIG_INVALID",
  policies: "CANOPY_INVALID_QUERY",
  tests: "CANOPY_INVALID_QUERY",
  schema: "CANOPY_SCHEMA_INVALID",
}

/**
 * Why a project could not be emitted: the stable code, the part, an RFC 6901 pointer into that part's
 * canonical document (empty for the whole part), and the project file the value came from when known.
 */
export class AuthoringError extends Error {
  readonly code: AuthoringCode
  readonly part: BundlePart
  readonly path: string
  readonly file: string | null
  /** What is wrong, without the path. */
  readonly reason: string

  constructor(
    code: AuthoringCode,
    part: BundlePart,
    path: string,
    reason: string,
    file: string | null = null,
  ) {
    super(`${path === "" ? "/" : path}: ${reason}`)
    this.name = "AuthoringError"
    this.code = code
    this.part = part
    this.path = path
    this.reason = reason
    this.file = file
  }

  /** The same refusal, attributed to a project file. */
  inFile(file: string | null): AuthoringError {
    return new AuthoringError(this.code, this.part, this.path, this.reason, file)
  }
}

/** The emitter itself failed, for example the authoring module did not load: not the project's fault. */
export class EmitterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "EmitterError"
  }
}

/** Appends one escaped RFC 6901 segment. */
export function pointer(path: string, segment: string): string {
  return `${path}/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`
}
