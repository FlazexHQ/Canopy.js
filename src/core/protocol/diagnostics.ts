import { CanopyError, ErrorCode } from "./errors.ts"

/**
 * One problem explained for a developer: a stable code, one line saying what happened, the cause, the fix
 * and a docs page. Every CLI, startup and development error uses this shape.
 */
export interface Diagnostic {
  readonly code: ErrorCode
  /** One line, lower case, without a final period: what happened. */
  readonly summary: string
  /** Why it happened, in the user's terms. */
  readonly cause?: string
  /** What to do next. */
  readonly fix?: string
  /** The slug of the docs page about this problem, such as `standalone-mongodb`. */
  readonly docs?: string
}

/** Options of {@link formatDiagnostic}. */
export interface FormatDiagnosticOptions {
  /** `error` (the default) or `warning`. */
  readonly severity?: "error" | "warning"
  /** Prefixed to the docs slug to build a link. Without it the slug is printed as `errors/<slug>`. */
  readonly docsBase?: string
}

function indent(text: string, prefix: string, rest: string = prefix): string {
  return text
    .split("\n")
    .map((line, index) => `${index === 0 ? prefix : rest}${line}`)
    .join("\n")
}

/**
 * Formats a diagnostic for a terminal or a log:
 *
 * ```text
 * error CANOPY_UNAVAILABLE: change streams are not available
 *   MongoDB at localhost:27017 is a standalone server; change streams and transactions need a replica set.
 *   Fix: convert it to a single node replica set ...
 *   Docs: errors/standalone-mongodb
 * ```
 */
export function formatDiagnostic(
  diagnostic: Diagnostic,
  options: FormatDiagnosticOptions = {},
): string {
  const lines = [`${options.severity ?? "error"} ${diagnostic.code}: ${diagnostic.summary}`]
  if (diagnostic.cause !== undefined) lines.push(indent(diagnostic.cause, "  "))
  if (diagnostic.fix !== undefined) lines.push(indent(diagnostic.fix, "  Fix: ", "       "))
  if (diagnostic.docs !== undefined)
    lines.push(`  Docs: ${options.docsBase ?? "errors/"}${diagnostic.docs}`)
  return lines.join("\n")
}

/**
 * A {@link CanopyError} that carries a {@link Diagnostic}. The diagnostic is kept out of `details`, which
 * REST returns to callers: causes and fixes name hosts, databases and roles, so they are for logs and the
 * CLI only.
 */
export class DiagnosticError extends CanopyError {
  readonly diagnostic: Diagnostic

  constructor(diagnostic: Diagnostic, options: { readonly cause?: unknown } = {}) {
    super(diagnostic.code, diagnostic.summary, options)
    this.name = "DiagnosticError"
    this.diagnostic = diagnostic
  }
}

/** Where a MongoDB failure happened, to name it in the diagnostic. */
export interface MongoTarget {
  /** `host:port` of the deployment. */
  readonly host?: string
  /** The database the operation used. */
  readonly database?: string
}

/** The target of a connection string: its hosts (never its credentials) and the database. */
export function mongoTarget(uri: string, database?: string): MongoTarget {
  const host = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1]
  return {
    ...(host === undefined ? {} : { host }),
    ...(database === undefined ? {} : { database }),
  }
}

/**
 * The numeric code of a MongoDB server error, or `undefined` when it has none. Commands decoded with exact
 * BSON types (`promoteValues: false`) carry the code as an `Int32` object instead of a number, which a
 * plain `===` comparison never matches, so this unwraps such values too.
 */
export function serverErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code: unknown = (error as Record<string, unknown>)["code"]
  if (typeof code === "number") return code
  if (typeof code === "object" && code !== null) {
    const value: unknown = (code as { valueOf(): unknown }).valueOf()
    if (typeof value === "number") return value
  }
  return undefined
}

interface DriverError {
  readonly name: string
  readonly message: string
  readonly code: unknown
  readonly codeName: unknown
  readonly cause: unknown
  /** Whether the error lists servers and none of them ever answered (all still of type `Unknown`). */
  readonly unanswered: boolean
}

function driverError(error: unknown): DriverError | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const record = error as Record<string, unknown>
  const reason = record["reason"]
  const servers =
    typeof reason === "object" && reason !== null
      ? (reason as Record<string, unknown>)["servers"]
      : undefined
  const unanswered =
    servers instanceof Map &&
    servers.size > 0 &&
    [...servers.values()].every(
      (server: unknown) =>
        typeof server === "object" &&
        server !== null &&
        (server as Record<string, unknown>)["type"] === "Unknown",
    )
  return {
    name: typeof record["name"] === "string" ? record["name"] : "",
    message: typeof record["message"] === "string" ? record["message"] : "",
    code: serverErrorCode(error),
    codeName: record["codeName"],
    cause: record["cause"],
    unanswered,
  }
}

function messages(error: unknown, depth = 0): string {
  const driver = driverError(error)
  if (driver === undefined || depth > 4) return ""
  const reason = (error as Record<string, unknown>)["reason"]
  const servers =
    typeof reason === "object" && reason !== null
      ? (reason as Record<string, unknown>)["servers"]
      : undefined
  const serverErrors =
    servers instanceof Map
      ? [...servers.values()].map((server: unknown) =>
          typeof server === "object" && server !== null
            ? messages((server as Record<string, unknown>)["error"], depth + 1)
            : "",
        )
      : []
  return [driver.message, messages(driver.cause, depth + 1), ...serverErrors].join("\n")
}

const at = (target: MongoTarget): string =>
  target.host === undefined ? "MongoDB" : `MongoDB at ${target.host}`

function standaloneDiagnostic(target: MongoTarget): Diagnostic {
  return {
    code: ErrorCode.Unavailable,
    summary: "change streams are not available",
    cause: `${at(target)} is a standalone server; change streams and transactions need a replica set.`,
    fix: "convert it to a single node replica set: start mongod with --replSet rs0, run rs.initiate() once\nand add replicaSet=rs0 to the connection string.",
    docs: "standalone-mongodb",
  }
}

const ROLE_HINT =
  "The canopyRealtime and canopyPlatform roles in the operations guide list every action Canopy needs."

const ACTIONS: Readonly<Record<string, string>> = {
  aggregate: "find",
  count: "find",
  delete: "remove",
}

function actionOf(command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  return Object.hasOwn(ACTIONS, command) ? ACTIONS[command] : command
}

interface MongoDiagnosticRule {
  matches(error: DriverError, text: string): boolean
  diagnose(error: DriverError, text: string, target: MongoTarget): Diagnostic
}

/**
 * Known MongoDB driver failures and their fixes, shared by the server and `canopy doctor`. The first
 * matching rule wins. Errors are inspected by shape (`name`, `code`, `codeName`, messages), so this table
 * does not depend on the driver.
 */
const RULES: readonly MongoDiagnosticRule[] = [
  {
    matches: (error, text) =>
      error.code === 40573 ||
      error.codeName === "Location40573" ||
      /only supported on replica sets/i.test(text) ||
      /Transaction numbers are only allowed on a replica set member or mongos/i.test(text),
    diagnose: (_error, _text, target) => standaloneDiagnostic(target),
  },
  {
    matches: (error, text) =>
      error.code === 18 ||
      error.codeName === "AuthenticationFailed" ||
      /Authentication failed/i.test(text),
    diagnose: (_error, _text, target) => ({
      code: ErrorCode.Unavailable,
      summary: "MongoDB rejected the credentials",
      cause: `${at(target)} refused the user name and password of the connection string.`,
      fix: "check the user name, the password (percent encoded) and authSource in the connection string.",
      docs: "authentication-failed",
    }),
  },
  {
    matches: (error, text) =>
      error.code === 13 || error.codeName === "Unauthorized" || /not authorized on/i.test(text),
    diagnose: (_error, text, target) => {
      const match = /not authorized on (\S+) to execute command \{\s*(\w+)/i.exec(text)
      const database = match?.[1] ?? target.database ?? "the database"
      const action = /\$changeStream/.test(text) ? "changeStream" : actionOf(match?.[2])
      return {
        code: ErrorCode.Unavailable,
        summary: `the MongoDB user may not run ${action ?? "this command"} on ${database}`,
        cause: `${at(target)} denied the command because the user lacks a privilege.`,
        fix: `grant the ${action ?? "needed"} action on the database ${database} to the user Canopy connects as.\n${ROLE_HINT}`,
        docs: "missing-privilege",
      }
    },
  },
  {
    matches: (_error, text) => /featureCompatibilityVersion/i.test(text),
    diagnose: (_error, _text, target) => featureCompatibilityDiagnostic(undefined, target),
  },
  {
    matches: (_error, text) =>
      /\b(?:SSL|TLS)\b|certificate|wrong version number|EPROTO/i.test(text),
    diagnose: (_error, _text, target) => ({
      code: ErrorCode.Unavailable,
      summary: "the TLS handshake with MongoDB failed",
      cause: `${at(target)} and the connection string disagree about TLS, or the server certificate is not trusted.`,
      fix: "set tls=true only when the server requires TLS, and pass tlsCAFile for a private certificate authority.",
      docs: "tls-mismatch",
    }),
  },
  {
    matches: (error, text) =>
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|connect ECONN/i.test(text) ||
      (error.name === "MongoServerSelectionError" &&
        (error.unanswered || /connection .*(?:closed|refused)/i.test(text))),
    diagnose: (_error, _text, target) => ({
      code: ErrorCode.Unavailable,
      summary: "cannot reach MongoDB",
      cause: `${at(target)} did not accept a connection: the host is wrong or mongod is not running.`,
      fix: "check that mongod is running and that the host and port of the connection string are right.\nIn Docker, use the service name instead of localhost.",
      docs: "mongodb-unreachable",
    }),
  },
  {
    matches: (error) =>
      error.name === "MongoServerSelectionError" || error.name === "MongoTopologyClosedError",
    diagnose: (_error, _text, target) => ({
      code: ErrorCode.Unavailable,
      summary: "no MongoDB server could be selected",
      cause: `${at(target)} answered, but no member matched the connection string: the replica set name may be wrong or no primary is elected.`,
      fix: "check that replicaSet in the connection string matches rs.status().set and that a primary exists.",
      docs: "no-primary",
    }),
  },
]

/** Explains a MongoDB driver failure, or returns `undefined` when it matches no known problem. */
export function diagnoseMongoError(
  error: unknown,
  target: MongoTarget = {},
): Diagnostic | undefined {
  const driver = driverError(error)
  if (driver === undefined) return undefined
  const text = messages(error)
  for (const rule of RULES) {
    if (rule.matches(driver, text)) return rule.diagnose(driver, text, target)
  }
  return undefined
}

/**
 * Checks a deployment at startup from its `hello` and `buildInfo` answers: it must be a replica set or a
 * sharded cluster (change streams and transactions) and run MongoDB 8.0 or newer. Returns the problem, or
 * `undefined` when there is none.
 */
export function deploymentDiagnostic(
  hello: Readonly<Record<string, unknown>>,
  version: string,
  target: MongoTarget = {},
): Diagnostic | undefined {
  if (typeof hello["setName"] !== "string" && hello["msg"] !== "isdbgrid")
    return standaloneDiagnostic(target)
  const major = Number.parseInt(version, 10)
  if (!Number.isInteger(major) || major < MIN_MAJOR_VERSION)
    return {
      code: ErrorCode.Unavailable,
      summary: "MongoDB is too old",
      cause: `${at(target)} runs MongoDB ${version}; Canopy needs ${MIN_FEATURE_COMPATIBILITY_VERSION} or newer.`,
      fix: `upgrade the deployment to MongoDB ${MIN_FEATURE_COMPATIBILITY_VERSION} or newer.`,
    }
  return undefined
}

/** The oldest feature compatibility version Canopy supports. */
export const MIN_FEATURE_COMPATIBILITY_VERSION = "8.0"

const MIN_MAJOR_VERSION = Number.parseInt(MIN_FEATURE_COMPATIBILITY_VERSION, 10)

/** The diagnostic for a deployment whose feature compatibility version is below the oldest Canopy supports. */
export function featureCompatibilityDiagnostic(
  version: string | undefined,
  target: MongoTarget = {},
): Diagnostic {
  return {
    code: ErrorCode.Unavailable,
    summary: `the feature compatibility version is below ${MIN_FEATURE_COMPATIBILITY_VERSION}`,
    cause: `${at(target)} runs with featureCompatibilityVersion ${version ?? `below ${MIN_FEATURE_COMPATIBILITY_VERSION}`}; Canopy needs ${MIN_FEATURE_COMPATIBILITY_VERSION} or newer.`,
    fix: `after upgrading the binaries, run db.adminCommand({ setFeatureCompatibilityVersion: "${MIN_FEATURE_COMPATIBILITY_VERSION}", confirm: true }).`,
    docs: "feature-compatibility-version",
  }
}

/**
 * Turns any failure into a diagnostic: the one a {@link DiagnosticError} carries, a known driver failure,
 * or a plain account of a {@link CanopyError} or other error.
 */
export function diagnosticOf(error: unknown, target: MongoTarget = {}): Diagnostic {
  if (error instanceof DiagnosticError) return error.diagnostic
  const known = diagnoseMongoError(error, target)
  if (known !== undefined) return known
  if (error instanceof CanopyError) return { code: error.code, summary: error.message }
  return {
    code: ErrorCode.Internal,
    summary: error instanceof Error ? error.message : String(error),
  }
}
