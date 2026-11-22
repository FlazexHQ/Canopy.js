import type { Command } from "./types.ts"

/** A numeric bound of a setting, checked after defaults are applied. */
interface Range {
  readonly min?: number
  readonly max?: number
  readonly message: (value: number) => string
}

/** What a setting may add to its type: a default for when it is unset, and a numeric range. */
interface Constraints {
  readonly def?: unknown
  readonly range?: Range
}

/** What a setting accepts: its type, and for containers the specs of what they hold. */
export type Spec = (
  | { readonly t: "string" | "url" | "int" | "bool" | "list" | "duration" | "raw" }
  | { readonly t: "enum"; readonly values: readonly string[] }
  | { readonly t: "enums"; readonly values: readonly string[] }
  | { readonly t: "object"; readonly fields: Readonly<Record<string, Spec>> }
  | { readonly t: "record"; readonly of: Spec }
  | { readonly t: "toggle"; readonly of: Spec }
  | { readonly t: "origins" }
  | { readonly t: "auth" }
  | { readonly t: "policies" }
  | { readonly t: "function" }
  | { readonly t: "objects"; readonly of: Spec }
  | {
      readonly t: "tagged"
      readonly kinds: Readonly<Record<string, Readonly<Record<string, Spec>>>>
      readonly hint: string
    }
) &
  Constraints

export const str: Spec = { t: "string" }
const url: Spec = { t: "url" }
const int: Spec = { t: "int" }
export const bool: Spec = { t: "bool" }
const list: Spec = { t: "list" }
const duration: Spec = { t: "duration" }
export const oneOf = (...values: string[]): Spec => ({ t: "enum", values })
const obj = (fields: Record<string, Spec>): Spec => ({ t: "object", fields })
/** A setting with a default, applied when it is unset and recorded with a `default` source. */
const withDefault = (spec: Spec, def: unknown, range?: Range): Spec => ({
  ...spec,
  def,
  ...(range === undefined ? {} : { range }),
})

const MINUTE = 60_000
const DAY = 86_400_000
const POSITIVE: Range = {
  min: 1,
  message: (value) => `Received ${value}.
Expected a whole number of at least 1.`,
}
const DIMENSION: Range = {
  min: 1,
  max: 10_000,
  message: (value) => `Received ${value}.
Expected a number of pixels from 1 to 10000.`,
}
const PORT: Range = {
  min: 0,
  max: 65_535,
  message: (value) => `Received ${value}.\nExpected a port between 0 and 65535.`,
}

const ENVIRONMENTS = ["development", "production"] as const

/** API keys published in examples, the compose file and `canopy dev` output, which anyone can know. */
const DEVELOPMENT_KEYS = new Set(["pk_dev", "sk_dev_change_me", "canopy_pk_dev", "canopy_sk_dev"])

export function isDevelopmentKey(key: string): boolean {
  return DEVELOPMENT_KEYS.has(key) || /^canopy_(?:pk|sk)_dev_/.test(key)
}
const FULL_DOCUMENT = ["auto", "updateLookup", "images"] as const
const TRANSPORTS = ["websocket", "sse", "long-poll"] as const
const ID_TYPES = ["auto", "objectId", "string", "uuid", "number"] as const
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
const ENGINES = ["auto", "ts", "native", "wasm"] as const
const REALTIME_SERVERS = ["ts", "gateway"] as const
/** The change events a trigger can react to. */
export const TRIGGER_OPERATIONS = ["insert", "update", "replace", "delete"] as const

const OAUTH_CLIENT = { clientId: str, clientSecret: str }

const EMAIL_TRANSPORTS: Readonly<Record<string, Readonly<Record<string, Spec>>>> = {
  smtp: { kind: str, host: str, port: int, secure: bool, requireTls: bool, user: str, pass: str },
  resend: { kind: str, apiKey: str },
  postmark: { kind: str, serverToken: str, messageStream: str },
  ses: { kind: str, region: str, accessKeyId: str, secretAccessKey: str, sessionToken: str },
  log: { kind: str },
}

/** The fields of each `auth.kind`: built in auth, external tokens and the provider presets. */
export const AUTH_KINDS: Readonly<Record<string, Readonly<Record<string, Spec>>>> = {
  builtin: {
    kind: str,
    secret: str,
    appName: withDefault(str, "Canopy"),
    accessTokenTtl: withDefault(duration, 10 * MINUTE, {
      min: 5 * MINUTE,
      max: 60 * MINUTE,
      message: () => "Access tokens live between 5 and 60 minutes.",
    }),
    algorithm: withDefault(oneOf("EdDSA", "ES256"), "EdDSA"),
    keyRotation: obj({
      interval: withDefault(duration, 30 * DAY, {
        min: 60 * MINUTE,
        message: () => "Keys sign for at least an hour.",
      }),
      grace: withDefault(duration, 30 * DAY),
    }),
    redirectUrls: list,
    emailPassword: {
      t: "toggle",
      of: obj({
        minPasswordLength: withDefault(int, 10, {
          min: 10,
          max: 128,
          message: () => "Use 10 to 128 characters.",
        }),
        requireEmailVerification: withDefault(bool, true),
      }),
    },
    magicLink: withDefault(bool, true),
    emailOtp: withDefault(bool, true),
    anonymous: withDefault(bool, false),
    twoFactor: withDefault(bool, true),
    passkeys: withDefault(bool, true),
    providers: obj({
      google: obj(OAUTH_CLIENT),
      github: obj(OAUTH_CLIENT),
      apple: obj(OAUTH_CLIENT),
      microsoft: obj({ ...OAUTH_CLIENT, tenantId: str }),
      discord: obj(OAUTH_CLIENT),
    }),
    oidc: {
      t: "objects",
      of: obj({ id: str, discoveryUrl: url, clientId: str, clientSecret: str, scopes: list }),
    },
    claims: { t: "function" },
    email: obj({
      from: str,
      transport: {
        t: "tagged",
        kinds: EMAIL_TRANSPORTS,
        hint: "Use email.smtp(), email.resend(), email.postmark(), email.ses() or email.log().",
      },
    }),
    trustedProxies: withDefault(list, []),
    identifierLimit: obj({ max: withDefault(int, 10), window: withDefault(duration, MINUTE) }),
    session: obj({
      expiresIn: withDefault(duration, 7 * DAY),
      updateAge: withDefault(duration, DAY),
    }),
  },
  external: {
    kind: str,
    jwksUrl: url,
    jwks: { t: "raw" },
    issuer: str,
    audience: str,
    algorithms: list,
    rolesClaim: str,
    allowServiceRoleFromJwt: bool,
    clockToleranceSeconds: int,
  },
  auth0: { kind: str, domain: str, audience: str, rolesClaim: str },
  clerk: { kind: str, frontendApi: str, audience: str, rolesClaim: str },
  firebase: { kind: str, projectId: str, rolesClaim: str },
  supabase: { kind: str, projectRef: str, rolesClaim: str },
}

/** Every top level setting of the config file. */
export const ROOT_FIELDS: Readonly<Record<string, Spec>> = {
  mongodb: obj({
    uri: str,
    database: str,
    metaDatabase: withDefault(str, "canopy"),
    authDatabase: withDefault(str, "canopy_auth"),
  }),
  environment: withDefault(oneOf(...ENVIRONMENTS), "development"),
  publicUrl: url,
  masterKey: str,
  previousMasterKeys: list,
  auth: { t: "auth" },
  keys: obj({ publishable: withDefault(list, []), secret: withDefault(list, []) }),
  policies: { t: "policies" },
  rest: {
    t: "toggle",
    of: obj({
      defaultLimit: withDefault(int, 100),
      maxLimit: withDefault(int, 1000),
      maxBodyBytes: withDefault(int, 1024 * 1024),
      mutationTtl: withDefault(duration, DAY),
    }),
  },
  realtime: {
    t: "toggle",
    of: obj({
      fullDocument: withDefault(oneOf(...FULL_DOCUMENT), "auto"),
      transports: withDefault({ t: "enums", values: TRANSPORTS }, TRANSPORTS),
      resumeWindow: withDefault(duration, 120_000),
      checkpoints: withDefault(oneOf("meta", "off"), "meta"),
      drainWindow: withDefault(duration, 30_000),
      echoTimeout: withDefault(duration, 2000),
      server: withDefault(oneOf(...REALTIME_SERVERS), "ts"),
    }),
  },
  graphql: {
    t: "toggle",
    of: obj({
      maxDepth: withDefault(int, 10, { min: 1, max: 50, message: () => "Use 1 to 50." }),
      maxComplexity: withDefault(int, 5000, { min: 1, message: () => "Use at least 1." }),
      maxAliases: withDefault(int, 30, { min: 0, message: () => "Use 0 or more." }),
      maxBatch: withDefault(int, 10, { min: 1, max: 100, message: () => "Use 1 to 100." }),
      introspection: oneOf("always", "authenticated", "never"),
      persisted: obj({ file: str, only: withDefault(bool, false) }),
    }),
  },
  rateLimits: {
    t: "toggle",
    of: obj({
      enabled: withDefault(bool, true),
      requests: obj({
        perSecond: withDefault(int, 50, POSITIVE),
        burst: withDefault(int, 200, POSITIVE),
      }),
      messages: obj({
        perSecond: withDefault(int, 20, POSITIVE),
        burst: withDefault(int, 100, POSITIVE),
      }),
      anonymousConnectionsPerAddress: withDefault(int, 50, POSITIVE),
      failedAuthentications: obj({
        perSecond: withDefault(int, 1, POSITIVE),
        burst: withDefault(int, 30, POSITIVE),
      }),
      exemptService: withDefault(bool, true),
    }),
  },
  collections: {
    t: "record",
    of: obj({
      idType: oneOf(...ID_TYPES),
      typeName: str,
      relations: {
        t: "record",
        of: obj({ to: str, local: str, foreign: str, many: bool }),
      },
      search: bool,
    }),
  },
  cors: obj({ origins: { t: "origins" } }),
  audit: obj({ dataWrites: withDefault(bool, false) }),
  storage: obj({
    backend: {
      t: "tagged",
      kinds: {
        local: { kind: str, root: str },
        r2: {
          kind: str,
          accountId: str,
          bucket: str,
          accessKeyId: str,
          secretAccessKey: str,
          jurisdiction: str,
          prefix: str,
        },
        s3: {
          kind: str,
          endpoint: url,
          region: str,
          bucket: str,
          accessKeyId: str,
          secretAccessKey: str,
          sessionToken: str,
          forcePathStyle: bool,
          prefix: str,
        },
      },
      hint: 'Use { kind: "local", root }, { kind: "r2", accountId, bucket, accessKeyId, secretAccessKey } or { kind: "s3", region, bucket, accessKeyId, secretAccessKey }.',
    },
    maxFileSize: withDefault(int, 50 * 1024 * 1024, POSITIVE),
    maxUploadSize: withDefault(int, 5 * 1024 * 1024 * 1024, POSITIVE),
    images: obj({
      enabled: withDefault(bool, true),
      maxDimension: withDefault(int, 2500, DIMENSION),
      maxSourceSize: withDefault(int, 25 * 1024 * 1024, POSITIVE),
    }),
    buckets: {
      t: "record",
      of: obj({ public: bool, maxFileSize: int, allowedTypes: list }),
    },
  }),
  webhooks: obj({
    secret: str,
    maxAttempts: withDefault(int, 8, { min: 1, max: 50, message: () => "Use 1 to 50." }),
    timeout: withDefault(duration, 10_000),
    triggers: {
      t: "record",
      of: obj({
        collection: str,
        operations: { t: "enums", values: TRIGGER_OPERATIONS },
        filter: { t: "raw" },
        url,
      }),
    },
    schedules: { t: "record", of: obj({ cron: str, url, body: { t: "raw" } }) },
  }),
  telemetry: obj({ tracing: withDefault(bool, false) }),
  server: obj({
    port: withDefault(int, 8080, PORT),
    metricsPort: withDefault(int, 9464, PORT),
    metricsHost: withDefault(str, "127.0.0.1"),
    metricsToken: str,
    adminListen: str,
    nodeId: withDefault(str, "n1"),
    trustedProxies: withDefault(list, []),
    engine: withDefault(oneOf(...ENGINES), "auto"),
  }),
  log: obj({ level: withDefault(oneOf(...LOG_LEVELS), "info") }),
  types: obj({ out: str, role: str }),
  dev: obj({ insecure: withDefault(bool, false) }),
}

/** The spec of a whole config file. */
export const ROOT: Spec = obj(ROOT_FIELDS)

/** Variables that configure Canopy without a config file. A config file may not contradict them. */
export const WELL_KNOWN: readonly (readonly [string, string, Spec])[] = [
  ["MONGODB_URI", "mongodb.uri", str],
  ["CANOPY_DB", "mongodb.database", str],
  ["CANOPY_META_DB", "mongodb.metaDatabase", str],
  ["CANOPY_AUTH_DB", "mongodb.authDatabase", str],
  ["CANOPY_ENV", "environment", oneOf(...ENVIRONMENTS)],
  ["CANOPY_PUBLIC_URL", "publicUrl", url],
  ["CANOPY_MASTER_KEY", "masterKey", str],
  ["CANOPY_MASTER_KEY_PREVIOUS", "previousMasterKeys", list],
  ["CANOPY_JWT_JWKS_URL", "auth.jwksUrl", url],
  ["CANOPY_JWT_ISSUER", "auth.issuer", str],
  ["CANOPY_JWT_AUDIENCE", "auth.audience", str],
  ["CANOPY_JWT_ALGORITHMS", "auth.algorithms", list],
  ["CANOPY_JWT_ROLES_CLAIM", "auth.rolesClaim", str],
  ["CANOPY_PUBLISHABLE_KEYS", "keys.publishable", list],
  ["CANOPY_SECRET_KEYS", "keys.secret", list],
  ["CANOPY_POLICIES", "policies.dir", str],
  ["CANOPY_MUTATION_TTL", "rest.mutationTtl", duration],
  ["CANOPY_REALTIME_FULL_DOCUMENT", "realtime.fullDocument", oneOf(...FULL_DOCUMENT)],
  ["CANOPY_RESUME_WINDOW", "realtime.resumeWindow", duration],
  ["CANOPY_CHECKPOINTS", "realtime.checkpoints", oneOf("meta", "off")],
  ["CANOPY_DRAIN_WINDOW", "realtime.drainWindow", duration],
  ["CANOPY_ECHO_TIMEOUT", "realtime.echoTimeout", duration],
  ["CANOPY_REALTIME_SERVER", "realtime.server", oneOf(...REALTIME_SERVERS)],
  ["CANOPY_RATE_LIMITS", "rateLimits.enabled", bool],
  ["CANOPY_RATE_LIMIT_REQUESTS", "rateLimits.requests.perSecond", int],
  ["CANOPY_RATE_LIMIT_REQUEST_BURST", "rateLimits.requests.burst", int],
  ["CANOPY_RATE_LIMIT_MESSAGES", "rateLimits.messages.perSecond", int],
  ["CANOPY_RATE_LIMIT_MESSAGE_BURST", "rateLimits.messages.burst", int],
  ["CANOPY_RATE_LIMIT_ANONYMOUS_CONNECTIONS", "rateLimits.anonymousConnectionsPerAddress", int],
  ["CANOPY_RATE_LIMIT_FAILED_AUTH", "rateLimits.failedAuthentications.perSecond", int],
  ["CANOPY_RATE_LIMIT_FAILED_AUTH_BURST", "rateLimits.failedAuthentications.burst", int],
  ["CANOPY_RATE_LIMIT_EXEMPT_SERVICE", "rateLimits.exemptService", bool],
  ["CANOPY_AUDIT_DATA_WRITES", "audit.dataWrites", bool],
  ["CANOPY_WEBHOOK_SECRET", "webhooks.secret", str],
  ["CANOPY_STORAGE_MAX_FILE_SIZE", "storage.maxFileSize", int],
  ["CANOPY_STORAGE_IMAGES", "storage.images.enabled", bool],
  ["CANOPY_TRACING", "telemetry.tracing", bool],
  ["CANOPY_CORS_ORIGINS", "cors.origins", { t: "origins" }],
  ["PORT", "server.port", int],
  ["METRICS_PORT", "server.metricsPort", int],
  ["METRICS_HOST", "server.metricsHost", str],
  ["CANOPY_METRICS_TOKEN", "server.metricsToken", str],
  ["CANOPY_ADMIN_LISTEN", "server.adminListen", str],
  ["CANOPY_NODE_ID", "server.nodeId", str],
  ["CANOPY_TRUSTED_PROXIES", "server.trustedProxies", list],
  ["CANOPY_ENGINE", "server.engine", oneOf(...ENGINES)],
  ["CANOPY_LOG_LEVEL", "log.level", oneOf(...LOG_LEVELS)],
  ["CANOPY_DEV_INSECURE", "dev.insecure", bool],
]

/** Settings whose values are masked when the config is printed. */
export const SECRET_PATHS = new Set([
  "masterKey",
  "previousMasterKeys",
  "keys.secret",
  "server.metricsToken",
  "webhooks.secret",
  "storage.backend.secretAccessKey",
  "storage.backend.sessionToken",
])

/** The sections each command needs. Unset variables elsewhere are not reported. */
export const NEEDS: Readonly<Record<Command, ReadonlySet<string> | "all">> = {
  start: "all",
  dev: "all",
  print: "all",
  realtime: new Set([
    "mongodb",
    "environment",
    "auth",
    "keys",
    "policies",
    "realtime",
    "rateLimits",
    "cors",
    "server",
    "log",
    "dev",
    "collections",
  ]),
  gen: new Set(["mongodb", "policies", "collections", "types", "environment"]),
  policies: new Set(["policies", "environment"]),
  doctor: new Set(["mongodb", "auth", "policies", "realtime", "environment", "publicUrl", "cors"]),
}
