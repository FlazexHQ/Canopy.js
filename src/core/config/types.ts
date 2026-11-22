import type { EnvMarker } from "./env.ts"

/** A setting given directly or read from an environment variable with {@link env}. */
export type Value<T> = T | EnvMarker<T> | EnvMarker<T | undefined>

/** `development` (the default) or `production`, which turns on stricter checks. */
export type Environment = "development" | "production"

/** The command a config is loaded for. Each only needs some sections; the others may be incomplete. */
export type Command = "start" | "dev" | "realtime" | "gen" | "policies" | "doctor" | "print"

/** What a config function receives. */
export interface ConfigContext {
  /** From `CANOPY_ENV`. */
  readonly mode: Environment
  readonly command: Command
}

/** How full documents are obtained for change events. */
export type FullDocumentMode = "auto" | "updateLookup" | "images"

/** Which server answers realtime: the TypeScript engine or the native gateway. */
export type RealtimeServer = "ts" | "gateway"

/** The realtime transports a server offers. */
export type Transport = "websocket" | "sse" | "long-poll"

/** How the `{id}` path segment of a collection is read. */
export type IdType = "auto" | "objectId" | "string" | "uuid" | "number"

/** Log levels. */
export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * Which implementation of the core evaluates policies and matches change events: `auto` (the Rust core when a
 * build of it loads, else the TypeScript packages), `ts` (the TypeScript packages), `native` (the Rust core as
 * a Node-API addon) or `wasm` (the Rust core as WebAssembly).
 */
export type Engine = "auto" | "ts" | "native" | "wasm"

/** Tokens from any OIDC or JWKS identity provider. */
export interface ExternalAuthInput {
  readonly kind: "external"
  /** The JWKS endpoint. Must use HTTPS outside `localhost`. */
  readonly jwksUrl?: Value<string>
  /** An inline JWKS, for tests and air gapped setups. */
  readonly jwks?: { readonly keys: readonly Readonly<Record<string, unknown>>[] }
  readonly issuer: Value<string>
  readonly audience: Value<string>
  /** Pinned algorithms. `none` and HMAC algorithms are refused. */
  readonly algorithms?: Value<readonly string[]>
  /** The claim holding custom roles, for example `https://example.com/roles`. */
  readonly rolesClaim?: Value<string>
  /** Lets a token claim the `service` role. Off by default. */
  readonly allowServiceRoleFromJwt?: boolean
  /** Clock skew tolerance in seconds. @default 60 */
  readonly clockToleranceSeconds?: number
}

/** Auth0: tokens of the API whose identifier is `audience`. */
export interface Auth0Input {
  readonly kind: "auth0"
  /** The tenant domain, for example `example.eu.auth0.com`. */
  readonly domain: Value<string>
  readonly audience: Value<string>
  readonly rolesClaim?: Value<string>
}

/** Clerk: session tokens from a JWT template that sets `aud`. */
export interface ClerkInput {
  readonly kind: "clerk"
  /** The Frontend API host, for example `clerk.example.com`. */
  readonly frontendApi: Value<string>
  readonly audience: Value<string>
  readonly rolesClaim?: Value<string>
}

/** Firebase Authentication ID tokens of one project. */
export interface FirebaseInput {
  readonly kind: "firebase"
  readonly projectId: Value<string>
  readonly rolesClaim?: Value<string>
}

/** Supabase Auth with asymmetric signing keys. */
export interface SupabaseInput {
  readonly kind: "supabase"
  /** The project reference, the subdomain of `<ref>.supabase.co`. */
  readonly projectRef: Value<string>
  readonly rolesClaim?: Value<string>
}

/** Delivery of auth emails through an SMTP relay. STARTTLS is required unless `requireTls` is false. */
export interface SmtpTransportInput {
  readonly kind: "smtp"
  readonly host: Value<string>
  /** @default 587, or 465 with `secure` */
  readonly port?: Value<number>
  /** Implicit TLS (port 465). */
  readonly secure?: Value<boolean>
  /** @default true */
  readonly requireTls?: Value<boolean>
  readonly user?: Value<string>
  readonly pass?: Value<string>
}

/** Delivery through Resend. */
export interface ResendTransportInput {
  readonly kind: "resend"
  readonly apiKey: Value<string>
}

/** Delivery through Postmark. */
export interface PostmarkTransportInput {
  readonly kind: "postmark"
  readonly serverToken: Value<string>
  /** @default "outbound" */
  readonly messageStream?: Value<string>
}

/** Delivery through Amazon SES (the v2 `SendEmail` API). */
export interface SesTransportInput {
  readonly kind: "ses"
  readonly region: Value<string>
  readonly accessKeyId: Value<string>
  readonly secretAccessKey: Value<string>
  readonly sessionToken?: Value<string>
}

/** Writes emails, links included, to the log. Development only. */
export interface LogTransportInput {
  readonly kind: "log"
}

/** How built in auth sends email. */
export type EmailTransportInput =
  | SmtpTransportInput
  | ResendTransportInput
  | PostmarkTransportInput
  | SesTransportInput
  | LogTransportInput

/** Client credentials of a named OAuth provider. */
export interface OAuthClientInput {
  readonly clientId: Value<string>
  readonly clientSecret: Value<string>
}

/** A generic OpenID Connect provider, found through its discovery document. */
export interface OidcProviderInput {
  /** Used in `/auth/v1/sign-in/social` and the callback path. Lower case letters, digits, `_` and `-`. */
  readonly id: string
  readonly discoveryUrl: Value<string>
  readonly clientId: Value<string>
  readonly clientSecret: Value<string>
  /** @default ["openid", "email", "profile"] */
  readonly scopes?: readonly string[]
}

/**
 * A claims hook as the config stores it. `@canopy/server` exports `builtin()` with the hook fully typed
 * (it receives the user, the session and the app database); import it from there.
 */
export type ClaimsHookFunction = (input: never) => unknown

/** Canopy issues the user tokens itself (users live in the `canopy_auth` database). */
export interface BuiltinAuthInput<Hook extends ClaimsHookFunction = ClaimsHookFunction> {
  readonly kind: "builtin"
  /** The app name emails and email template previews use. @default "Canopy" */
  readonly appName?: Value<string>
  /** Signs cookies and encrypts signing keys, at least 32 characters. @default the master key */
  readonly secret?: Value<string>
  /** 5 to 60 minutes. @default "10m" */
  readonly accessTokenTtl?: Value<number | string>
  /** @default "EdDSA" */
  readonly algorithm?: Value<"EdDSA" | "ES256">
  readonly keyRotation?: {
    /** How long a key signs. @default "30d" */
    readonly interval?: Value<number | string>
    /** How long a retired key keeps verifying. @default "30d" */
    readonly grace?: Value<number | string>
  }
  /** Origins that redirects, OAuth callbacks and cross origin calls may use. @default the CORS origins */
  readonly redirectUrls?: Value<readonly string[]>
  /** `false` turns email and password sign in off. @default true */
  readonly emailPassword?:
    | boolean
    | {
        /** At least 10. @default 10 */
        readonly minPasswordLength?: Value<number>
        /** @default true */
        readonly requireEmailVerification?: Value<boolean>
      }
  /** @default true */
  readonly magicLink?: Value<boolean>
  /** @default true */
  readonly emailOtp?: Value<boolean>
  /** @default false */
  readonly anonymous?: Value<boolean>
  /** TOTP second factor with backup codes; users opt in. @default true */
  readonly twoFactor?: Value<boolean>
  /** WebAuthn passkeys for the public URL's host; users opt in. @default true */
  readonly passkeys?: Value<boolean>
  readonly providers?: {
    readonly google?: OAuthClientInput
    readonly github?: OAuthClientInput
    readonly apple?: OAuthClientInput
    readonly microsoft?: OAuthClientInput & { readonly tenantId?: Value<string> }
    readonly discord?: OAuthClientInput
  }
  readonly oidc?: readonly OidcProviderInput[]
  /** Runs when a token is minted; must finish within 200 ms. */
  readonly claims?: Hook
  /** Required in production. In development, emails are written to the log when it is left out. */
  readonly email?: { readonly from: Value<string>; readonly transport: EmailTransportInput }
  /** Proxies (addresses or IPv4 CIDR ranges) whose `X-Forwarded-For` is trusted. */
  readonly trustedProxies?: Value<readonly string[]>
  /** Attempts per email address and route. @default { max: 10, window: "1m" } */
  readonly identifierLimit?: {
    readonly max?: Value<number>
    readonly window?: Value<number | string>
  }
  readonly session?: {
    /** @default "7d" */
    readonly expiresIn?: Value<number | string>
    /** @default "1d" */
    readonly updateAge?: Value<number | string>
  }
}

/** Where user tokens come from. */
export type AuthInput =
  ExternalAuthInput | Auth0Input | ClerkInput | FirebaseInput | SupabaseInput | BuiltinAuthInput

/** Policies from a directory of files, or from the `canopy` meta database. */
export type PoliciesInput =
  | {
      /** Relative to the config file. */
      readonly dir: string
      /** Reload on change. @default true */
      readonly watch?: boolean
    }
  | { readonly source: "database"; readonly watch?: boolean }

/** Data API settings. */
export interface RestInput {
  /** @default 100 */
  readonly defaultLimit?: Value<number>
  /** @default 1000 */
  readonly maxLimit?: Value<number>
  /** @default 1048576 */
  readonly maxBodyBytes?: Value<number>
  /** How long idempotency records live. @default "24h" */
  readonly mutationTtl?: Value<number | string>
}

/** Who may run GraphQL introspection queries. */
export type GraphqlIntrospection = "always" | "authenticated" | "never"

/** GraphQL settings. GraphQL is served at `/graphql/v1` on top of the Data API. */
export interface GraphqlInput {
  /** @default 10 */
  readonly maxDepth?: Value<number>
  /** Every field costs 1, times the `limit` of each list above it. @default 5000 */
  readonly maxComplexity?: Value<number>
  /** @default 30 */
  readonly maxAliases?: Value<number>
  /** Operations in one batched request. @default 10 */
  readonly maxBatch?: Value<number>
  /** @default "authenticated" in production, "always" otherwise */
  readonly introspection?: Value<GraphqlIntrospection>
  /** An allowlist of operations: a JSON file mapping the hex SHA-256 of each document to the document. */
  readonly persisted?: {
    /** Relative to the config file. */
    readonly file: string
    /** Refuses every operation that is not in the file. @default false */
    readonly only?: Value<boolean>
  }
}

/** A GraphQL relation from one collection to another. */
export interface RelationInput {
  /** The target collection. */
  readonly to: string
  /** The field of this collection that holds the key. */
  readonly local: string
  /** The field of the target collection the key matches. @default "_id" */
  readonly foreign?: string
  /** Whether several target documents may match, so the field is a list. @default false */
  readonly many?: boolean
}

/** Settings of one collection. */
export interface CollectionInput {
  readonly idType?: IdType
  /** The GraphQL type name, such as `Person` for `people`. @default the singular of the name */
  readonly typeName?: string
  /** GraphQL relations by field name, resolved under the target collection's policies. */
  readonly relations?: Readonly<Record<string, RelationInput>>
  /**
   * Allows `$search` and `$vectorSearch` as the first stage of Data API aggregations on this collection. It
   * needs an Atlas Search or MongoDB Search index; policies filter the results. @default false
   */
  readonly search?: Value<boolean>
}

/** A resolved GraphQL relation. */
export interface ResolvedRelation {
  readonly to: string
  readonly local: string
  readonly foreign: string
  readonly many: boolean
}

/** A resolved collection entry. */
export interface ResolvedCollection {
  readonly idType: IdType
  readonly typeName?: string
  readonly relations?: Readonly<Record<string, ResolvedRelation>>
  /** Whether aggregations may start with `$search` or `$vectorSearch`. */
  readonly search?: boolean
}

/** Realtime settings. */
export interface RealtimeInput {
  /** @default "auto" */
  readonly fullDocument?: Value<FullDocumentMode>
  /** @default ["websocket", "sse", "long-poll"] */
  readonly transports?: readonly Transport[]
  /** How long a session survives a disconnect. @default "2m" */
  readonly resumeWindow?: Value<number | string>
  /** Where the stream position is kept. @default "meta" */
  readonly checkpoints?: Value<"meta" | "off">
  /** How long shutdown waits for clients to move. @default "30s" */
  readonly drainWindow?: Value<number | string>
  /**
   * How long a write's acknowledgement waits for the write's change events before it is sent with the post
   * images instead (`echo: false`). Raise it on a sharded cluster, where an idle shard delays change events.
   * @default "2s"
   */
  readonly echoTimeout?: Value<number | string>
  /**
   * Which server answers realtime: `ts`, the engine inside the TypeScript process, or `gateway`, the native
   * `canopy-gateway` executable. With `gateway`, `canopy-server` runs the gateway on the public port, where it
   * serves realtime and passes every other request to the TypeScript server on loopback.
   * @default "ts"
   */
  readonly server?: Value<RealtimeServer>
}

/** One token bucket: the rate a caller can sustain and the burst it can spend at once. */
export interface BucketInput {
  /** Tokens added per second. */
  readonly perSecond?: Value<number>
  /** The most tokens a bucket holds. */
  readonly burst?: Value<number>
}

/**
 * Limits on the data plane, counted in memory by each instance. Callers are keyed by API key and subject;
 * anonymous callers are keyed by client address too (see `server.trustedProxies`). `false` turns every
 * limit off.
 */
export interface RateLimitsInput {
  /** Set to `false` to turn every limit off. @default true */
  readonly enabled?: Value<boolean>
  /** REST and GraphQL requests, one token each. @default { perSecond: 50, burst: 200 } */
  readonly requests?: BucketInput
  /** Realtime `sub`, `mut` and `auth` frames, one token each. @default { perSecond: 20, burst: 100 } */
  readonly messages?: BucketInput
  /** Open realtime connections of anonymous callers per client address. @default 50 */
  readonly anonymousConnectionsPerAddress?: Value<number>
  /**
   * Failed authentications (an unknown API key, a bad token) per client address. An address over this
   * budget is refused before its credentials are checked. @default { perSecond: 1, burst: 30 }
   */
  readonly failedAuthentications?: BucketInput
  /** Whether callers with the `service` role (secret keys) are exempt. @default true */
  readonly exemptService?: Value<boolean>
}

/** The change events a trigger can react to. */
export type TriggerOperation = "insert" | "update" | "replace" | "delete"

/** A change in the app database that calls a webhook. */
export interface TriggerInput {
  /** The collection whose changes are watched. */
  readonly collection: string
  /** @default ["insert", "update", "replace", "delete"] */
  readonly operations?: readonly TriggerOperation[]
  /**
   * A query filter the document must match: the document after the change, or before it for deletes. An
   * event whose document is not available (a delete without pre images) does not match a filter.
   */
  readonly filter?: Readonly<Record<string, unknown>>
  /** The endpoint that receives one POST per matching change. */
  readonly url: Value<string>
}

/** A webhook called on a cron schedule, in UTC. */
export interface ScheduleInput {
  /** Five fields (minute, hour, day of month, month, day of week) or a macro such as `@hourly`. */
  readonly cron: string
  /** The endpoint that receives one POST per fire. */
  readonly url: Value<string>
  /** A JSON object sent as `body` in every payload. */
  readonly body?: Readonly<Record<string, unknown>>
}

/**
 * Database triggers and scheduled jobs, delivered as signed HTTP POSTs (Standard Webhooks) at least once,
 * with retries and a dead letter collection in the meta database.
 */
export interface WebhooksInput {
  /** Signs every delivery (`CANOPY_WEBHOOK_SECRET`): `whsec_` and base64, or any text of 16 characters or more. */
  readonly secret?: Value<string>
  /** Attempts before a delivery is dead lettered. @default 8 */
  readonly maxAttempts?: Value<number>
  /** How long one attempt may take. @default "10s" */
  readonly timeout?: Value<number | string>
  readonly triggers?: Readonly<Record<string, TriggerInput>>
  readonly schedules?: Readonly<Record<string, ScheduleInput>>
}

/**
 * Where stored files live: on local disk, in a Cloudflare R2 bucket, or in an AWS S3 bucket (or another S3
 * compatible store given by `endpoint`).
 */
export type StorageBackendInput =
  | {
      readonly kind: "local"
      /**
       * The folder files are stored under, relative to the config file (or to the working directory when set
       * from the environment). @default "storage"
       */
      readonly root?: Value<string>
    }
  | {
      readonly kind: "r2"
      /** The Cloudflare account id. */
      readonly accountId: Value<string>
      readonly bucket: Value<string>
      /** The access key id of an R2 API token. */
      readonly accessKeyId: Value<string>
      readonly secretAccessKey: Value<string>
      /** For a bucket created in a jurisdiction, such as `eu`. */
      readonly jurisdiction?: Value<string>
      /** A key prefix inside the bucket. @default "" */
      readonly prefix?: Value<string>
    }
  | {
      readonly kind: "s3"
      readonly region: Value<string>
      readonly bucket: Value<string>
      readonly accessKeyId: Value<string>
      readonly secretAccessKey: Value<string>
      readonly sessionToken?: Value<string>
      /**
       * The endpoint of a store other than AWS S3, such as `http://localhost:9000` for MinIO.
       * @default `https://s3.<region>.amazonaws.com`
       */
      readonly endpoint?: Value<string>
      /** Addresses the bucket in the path rather than the host name. @default true with `endpoint`, else false */
      readonly forcePathStyle?: Value<boolean>
      /** A key prefix inside the bucket. @default "" */
      readonly prefix?: Value<string>
    }

/** Image transformations at `/storage/v1/render/image/...`. */
export interface StorageImagesInput {
  /** @default true */
  readonly enabled?: Value<boolean>
  /** The largest width or height asked for, in pixels. @default 2500 */
  readonly maxDimension?: Value<number>
  /** The largest source image transformed, in bytes. @default 26214400 (25 MiB) */
  readonly maxSourceSize?: Value<number>
}

/** The settings of one storage bucket. */
export interface StorageBucketInput {
  /** Anyone may read its files at `/storage/v1/public/<bucket>/<path>`, without a policy. @default false */
  readonly public?: Value<boolean>
  /** The largest file in bytes. @default the `maxFileSize` of the storage section */
  readonly maxFileSize?: Value<number>
  /** Accepted media types such as `image/png` or `image/*`. @default any */
  readonly allowedTypes?: Value<readonly string[]>
}

/**
 * File storage at `/storage/v1`, with the policies of the reserved collection `storage.objects` applied to
 * the metadata document of every file. On when at least one bucket is configured.
 */
export interface StorageInput {
  /** @default { kind: "local", root: "storage" } */
  readonly backend?: StorageBackendInput
  /** The largest file sent in one request, in bytes. @default 52428800 (50 MiB) */
  readonly maxFileSize?: Value<number>
  /** The largest resumable upload, in bytes. @default 5368709120 (5 GiB) */
  readonly maxUploadSize?: Value<number>
  readonly images?: StorageImagesInput
  readonly buckets?: Readonly<Record<string, StorageBucketInput>>
}

/** The input of {@link defineConfig}. Every setting may also be an {@link env} marker. */
export interface CanopyConfigInput {
  readonly mongodb?: {
    readonly uri: Value<string>
    /** @default the database in the URI path */
    readonly database?: Value<string>
    /** @default "canopy" */
    readonly metaDatabase?: Value<string>
    /** @default "canopy_auth" */
    readonly authDatabase?: Value<string>
  }
  /** @default "development" */
  readonly environment?: Value<Environment>
  /** The external base URL, used for JWT issuers, redirects and the default CORS origin. */
  readonly publicUrl?: Value<string>
  /** The key encryption key of stored secrets. Required in production for the `canopy` server. */
  readonly masterKey?: Value<string>
  /**
   * Master keys being rotated out. Stored secrets sealed with one of them still open, and
   * `POST /admin/v1/settings/rotate-master-key` seals them again with `masterKey`.
   */
  readonly previousMasterKeys?: Value<readonly string[]>
  readonly auth?: AuthInput
  readonly keys?: {
    readonly publishable?: Value<readonly string[]>
    readonly secret?: Value<readonly string[]>
  }
  readonly policies?: PoliciesInput
  /** `true` for the defaults, `false` to turn the Data API off. @default true */
  readonly rest?: boolean | RestInput
  /** `true` for the defaults, `false` to turn GraphQL off. Needs `rest`. @default true */
  readonly graphql?: boolean | GraphqlInput
  /** `true` for the defaults, `false` to turn realtime off. @default true */
  readonly realtime?: boolean | RealtimeInput
  /** `true` for the defaults, `false` to turn the data plane limits off. @default true */
  readonly rateLimits?: boolean | RateLimitsInput
  readonly collections?: Readonly<Record<string, CollectionInput>>
  readonly cors?: { readonly origins: Value<readonly string[]> | "*" }
  readonly audit?: {
    /**
     * Records every committed write of the data plane (REST, GraphQL and realtime mutations) in the audit
     * log: who wrote, the collection, the operation and the document ids, never the documents themselves.
     * It costs one insert into the meta database per write. @default false
     */
    readonly dataWrites?: Value<boolean>
  }
  /** Database triggers and scheduled jobs that call webhooks. */
  readonly webhooks?: WebhooksInput
  /** File storage with policies on file metadata. */
  readonly storage?: StorageInput
  readonly telemetry?: {
    /**
     * Records OpenTelemetry spans: each HTTP request (continuing an incoming `traceparent`), each MongoDB
     * command, each policy load and each realtime fan out. Needs the `@opentelemetry/api` package; spans
     * are exported by the SDK the app registers, so without one they cost almost nothing. @default false
     */
    readonly tracing?: Value<boolean>
  }
  readonly server?: {
    /** @default 8080 */
    readonly port?: Value<number>
    /** @default 9464 */
    readonly metricsPort?: Value<number>
    /**
     * The address the metrics port binds. The default only accepts scrapers on this machine; in a container
     * or behind a private network use `0.0.0.0` together with {@link metricsToken} or a network policy.
     * @default "127.0.0.1"
     */
    readonly metricsHost?: Value<string>
    /** A bearer token scrapers must send to `/metrics` (`CANOPY_METRICS_TOKEN`). */
    readonly metricsToken?: Value<string>
    /** Serves `/admin` and `/studio` only on this address, for example `127.0.0.1:8081`. */
    readonly adminListen?: Value<string>
    /** @default "n1" */
    readonly nodeId?: Value<string>
    /**
     * Proxies (addresses or CIDR ranges, IPv4 or IPv6) whose `X-Forwarded-For` is trusted, so the admin
     * allowlist, the audit log and built in auth see the client address behind them.
     */
    readonly trustedProxies?: Value<readonly string[]>
    /**
     * Which implementation of the core evaluates policies and matches change events (`CANOPY_ENGINE`).
     * `auto` runs the Node-API addon of the Rust core, else its WebAssembly build, else the TypeScript packages.
     * `native` and `wasm` run the Rust core and refuse to start when its build cannot load.
     * @default "auto"
     */
    readonly engine?: Value<Engine>
  }
  readonly log?: { readonly level?: Value<LogLevel> }
  /** Where `canopy gen types` writes, relative to the config file. */
  readonly types?: { readonly out?: string; readonly role?: string }
  /** Development only switches; refused in production. */
  readonly dev?: { readonly insecure?: Value<boolean> }
}

/** A config function, called with the mode and command. */
export type ConfigFunction = (context: ConfigContext) => CanopyConfigInput

/**
 * Declares a Canopy config with types and editor help. Takes the config object, or a function of
 * `{ mode, command }` returning it. Read variables with {@link env} rather than `process.env`, so missing
 * ones are reported together and secrets stay redacted.
 */
export function defineConfig(config: CanopyConfigInput): CanopyConfigInput
export function defineConfig(config: ConfigFunction): ConfigFunction
export function defineConfig(
  config: CanopyConfigInput | ConfigFunction,
): CanopyConfigInput | ConfigFunction {
  return config
}

/** Verified JWTs from an identity provider, ready for the authenticator. */
export interface ResolvedExternalAuth {
  readonly kind?: "external"
  readonly jwksUrl?: string
  readonly jwks?: { readonly keys: readonly Readonly<Record<string, unknown>>[] }
  readonly issuer: string
  readonly audience: string
  readonly algorithms?: readonly string[]
  readonly rolesClaim?: string
  readonly allowServiceRoleFromJwt?: boolean
  readonly clockToleranceSeconds?: number
}

/** How resolved built in auth sends email. */
export type ResolvedEmailTransport =
  | {
      readonly kind: "smtp"
      readonly host: string
      readonly port?: number
      readonly secure?: boolean
      readonly requireTls?: boolean
      readonly user?: string
      readonly pass?: string
    }
  | { readonly kind: "resend"; readonly apiKey: string }
  | { readonly kind: "postmark"; readonly serverToken: string; readonly messageStream?: string }
  | {
      readonly kind: "ses"
      readonly region: string
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly sessionToken?: string
    }
  | { readonly kind: "log" }

/** Built in auth with every default applied. */
export interface ResolvedBuiltinAuth {
  readonly kind: "builtin"
  readonly appName: string
  /** `undefined` in development without a secret or master key; the server then makes one per process. */
  readonly secret: string | undefined
  readonly accessTokenTtlSeconds: number
  readonly algorithm: "EdDSA" | "ES256"
  readonly keyRotation: { readonly intervalSeconds: number; readonly graceSeconds: number }
  readonly redirectUrls: readonly string[]
  readonly emailPassword:
    false | { readonly minPasswordLength: number; readonly requireEmailVerification: boolean }
  readonly magicLink: boolean
  readonly emailOtp: boolean
  readonly anonymous: boolean
  readonly twoFactor: boolean
  readonly passkeys: boolean
  readonly providers: Readonly<
    Record<
      string,
      { readonly clientId: string; readonly clientSecret: string; readonly tenantId?: string }
    >
  >
  readonly oidc: readonly {
    readonly id: string
    readonly discoveryUrl: string
    readonly clientId: string
    readonly clientSecret: string
    readonly scopes?: readonly string[]
  }[]
  readonly claims: ClaimsHookFunction | undefined
  readonly email: { readonly from: string; readonly transport: ResolvedEmailTransport }
  readonly trustedProxies: readonly string[]
  readonly identifierLimit: { readonly max: number; readonly windowSeconds: number }
  readonly session: { readonly expiresInSeconds: number; readonly updateAgeSeconds: number }
}

/** A resolved storage backend. */
export type ResolvedStorageBackend =
  | { readonly kind: "local"; readonly root: string }
  | {
      readonly kind: "r2"
      readonly accountId: string
      readonly bucket: string
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly jurisdiction: string | undefined
      readonly prefix: string
    }
  | {
      readonly kind: "s3"
      readonly endpoint: string | undefined
      readonly region: string
      readonly bucket: string
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly sessionToken: string | undefined
      readonly forcePathStyle: boolean
      readonly prefix: string
    }

/** Resolved image transformation settings. */
export interface ResolvedStorageImages {
  readonly enabled: boolean
  readonly maxDimension: number
  readonly maxSourceSize: number
}

/** A resolved storage bucket. */
export interface ResolvedBucket {
  readonly public: boolean
  readonly maxFileSize: number
  readonly allowedTypes: readonly string[]
}

/** A resolved trigger. */
export interface ResolvedTrigger {
  readonly collection: string
  readonly operations: readonly TriggerOperation[]
  readonly filter: Readonly<Record<string, unknown>> | undefined
  readonly url: string
}

/** A resolved schedule. */
export interface ResolvedSchedule {
  readonly cron: string
  readonly url: string
  readonly body: Readonly<Record<string, unknown>> | undefined
}

/** A validated config with every default applied. */
export interface ResolvedConfig {
  /** The config file, or `undefined` in zero config mode. */
  readonly file: string | undefined
  readonly environment: Environment
  readonly mongodb: {
    readonly uri: string
    readonly database: string
    readonly metaDatabase: string
    readonly authDatabase: string
  }
  readonly publicUrl: string | undefined
  readonly masterKey: string | undefined
  readonly previousMasterKeys: readonly string[]
  readonly auth: ResolvedExternalAuth | ResolvedBuiltinAuth | undefined
  readonly keys: { readonly publishable: readonly string[]; readonly secret: readonly string[] }
  readonly policies:
    | { readonly dir: string; readonly watch: boolean }
    | { readonly source: "database"; readonly watch: boolean }
  readonly rest:
    | false
    | {
        readonly defaultLimit: number
        readonly maxLimit: number
        readonly maxBodyBytes: number
        readonly mutationTtlMs: number
      }
  readonly graphql:
    | false
    | {
        readonly maxDepth: number
        readonly maxComplexity: number
        readonly maxAliases: number
        readonly maxBatch: number
        readonly introspection: GraphqlIntrospection
        readonly persisted: { readonly file: string; readonly only: boolean } | undefined
      }
  readonly realtime:
    | false
    | {
        readonly fullDocument: FullDocumentMode
        readonly transports: readonly Transport[]
        readonly resumeWindowMs: number
        readonly checkpoints: "meta" | "off"
        readonly drainWindowMs: number
        readonly echoTimeoutMs: number
        readonly server: RealtimeServer
      }
  readonly rateLimits:
    | false
    | {
        readonly requests: { readonly perSecond: number; readonly burst: number }
        readonly messages: { readonly perSecond: number; readonly burst: number }
        readonly anonymousConnectionsPerAddress: number
        readonly failedAuthentications: { readonly perSecond: number; readonly burst: number }
        readonly exemptService: boolean
      }
  readonly collections: Readonly<Record<string, ResolvedCollection>>
  readonly cors: { readonly origins: readonly string[] | "*" } | undefined
  readonly audit: { readonly dataWrites: boolean }
  readonly webhooks: {
    readonly secret: string | undefined
    readonly maxAttempts: number
    readonly timeoutMs: number
    readonly triggers: Readonly<Record<string, ResolvedTrigger>>
    readonly schedules: Readonly<Record<string, ResolvedSchedule>>
  }
  readonly telemetry: { readonly tracing: boolean }
  /** `false` without buckets. */
  readonly storage:
    | false
    | {
        readonly backend: ResolvedStorageBackend
        readonly maxUploadSize: number
        readonly images: ResolvedStorageImages
        readonly buckets: Readonly<Record<string, ResolvedBucket>>
      }
  readonly server: {
    readonly port: number
    readonly metricsPort: number
    readonly metricsHost: string
    readonly metricsToken: string | undefined
    readonly adminListen: string | undefined
    readonly nodeId: string
    readonly trustedProxies: readonly string[]
    readonly engine: Engine
  }
  readonly log: { readonly level: LogLevel }
  readonly types: { readonly out: string; readonly role: string | undefined }
  readonly dev: { readonly insecure: boolean }
}
