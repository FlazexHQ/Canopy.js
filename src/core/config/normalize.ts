import { normalizeBuiltin } from "./builtin.ts"
import { parseCron } from "./cron.ts"
import type { ResolveOptions } from "./resolution.ts"
import { get, isLocalHost, isPlainObject, quoted, type Resolver } from "./resolver.ts"
import { isDevelopmentKey, ROOT_FIELDS, TRIGGER_OPERATIONS } from "./spec.ts"
import type {
  Engine,
  Environment,
  FullDocumentMode,
  GraphqlIntrospection,
  IdType,
  LogLevel,
  RealtimeServer,
  ResolvedBucket,
  ResolvedBuiltinAuth,
  ResolvedCollection,
  ResolvedConfig,
  ResolvedExternalAuth,
  ResolvedRelation,
  ResolvedSchedule,
  ResolvedStorageBackend,
  ResolvedStorageImages,
  ResolvedTrigger,
  Transport,
  TriggerOperation,
} from "./types.ts"

/** The database in the path of a MongoDB connection string, if there is one. */
export function databaseFromUri(uri: string): string | undefined {
  try {
    const path = new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).pathname.replace(/^\//, "")
    return path === "" ? undefined : decodeURIComponent(path)
  } catch {
    return undefined
  }
}

const FORBIDDEN_ALGORITHMS = new Set(["none", "HS256", "HS384", "HS512"])

/** Names of triggers and schedules: they appear in delivery ids, the admin API and metrics. */
const HOOK_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Whether a webhook signing secret is usable: `whsec_` and base64 of 16 bytes or more, or 16 characters. */
function usableSecret(secret: string): boolean {
  if (!secret.startsWith("whsec_")) return secret.length >= 16
  const encoded = secret.slice("whsec_".length)
  return /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && Math.floor((encoded.length * 3) / 4) >= 16
}

/**
 * Resolves the `storage` section: off without buckets, on local disk unless R2 or S3 is given. A local root
 * is resolved against the folder of the config file, or the working directory when it comes from the
 * environment.
 */
function normalizeStorage(
  resolver: Resolver,
  tree: Record<string, unknown>,
  options: ResolveOptions,
): ResolvedConfig["storage"] {
  const rawBuckets = get(tree, "storage.buckets")
  if (!isPlainObject(rawBuckets) || Object.keys(rawBuckets).length === 0) return false
  const maxFileSize = get(tree, "storage.maxFileSize") as number
  const buckets: Record<string, ResolvedBucket> = {}
  for (const [name, value] of Object.entries(rawBuckets)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
      resolver.problem(
        `storage.buckets.${name}`,
        "Use a bucket name of lower case letters, digits, underscores and hyphens (at most 63 characters).",
      )
      continue
    }
    const entry = isPlainObject(value) ? value : {}
    const size = entry["maxFileSize"]
    if (typeof size === "number" && size < 1) {
      resolver.problem(`storage.buckets.${name}.maxFileSize`, "Use a size of at least 1 byte.")
      continue
    }
    const types = entry["allowedTypes"]
    buckets[name] = {
      public: entry["public"] === true,
      maxFileSize: typeof size === "number" ? size : maxFileSize,
      allowedTypes: Array.isArray(types) ? (types as string[]) : [],
    }
  }
  const raw = get(tree, "storage.backend")
  const chosen = isPlainObject(raw) ? raw : {}
  const text = (field: string): string | undefined =>
    typeof chosen[field] === "string" ? (chosen[field] as string) : undefined
  const required = (kind: string, fields: readonly string[]): void => {
    for (const field of fields)
      if (text(field) === undefined || text(field) === "")
        resolver.problem(`storage.backend.${field}`, `The ${kind} backend needs ${field}.`, true)
  }
  let backend: ResolvedStorageBackend
  if (chosen["kind"] === "r2") {
    required("R2", ["accountId", "bucket", "accessKeyId", "secretAccessKey"])
    const accountId = text("accountId") ?? ""
    if (accountId !== "" && !/^[0-9a-f]{32}$/i.test(accountId))
      resolver.problem(
        "storage.backend.accountId",
        `Received ${accountId}.
Expected the 32 hexadecimal characters of a Cloudflare account id.`,
      )
    const jurisdiction = text("jurisdiction")
    if (jurisdiction !== undefined && !/^[a-z]+$/.test(jurisdiction))
      resolver.problem(
        "storage.backend.jurisdiction",
        `Received ${jurisdiction}.
Expected a jurisdiction such as eu or fedramp.`,
      )
    backend = {
      kind: "r2",
      accountId,
      bucket: text("bucket") ?? "",
      accessKeyId: text("accessKeyId") ?? "",
      secretAccessKey: text("secretAccessKey") ?? "",
      jurisdiction,
      prefix: text("prefix") ?? "",
    }
  } else if (chosen["kind"] === "s3") {
    required("S3", ["region", "bucket", "accessKeyId", "secretAccessKey"])
    const endpoint = text("endpoint")
    backend = {
      kind: "s3",
      endpoint,
      region: text("region") ?? "",
      bucket: text("bucket") ?? "",
      accessKeyId: text("accessKeyId") ?? "",
      secretAccessKey: text("secretAccessKey") ?? "",
      sessionToken: text("sessionToken"),
      forcePathStyle:
        typeof chosen["forcePathStyle"] === "boolean"
          ? chosen["forcePathStyle"]
          : endpoint !== undefined,
      prefix: text("prefix") ?? "",
    }
  } else {
    const root = text("root")
    if (root === "") resolver.problem("storage.backend.root", "Use a folder for the stored files.")
    const base =
      resolver.sources.get("storage.backend.root")?.kind === "env" ? options.cwd : options.baseDir
    backend = {
      kind: "local",
      root: joinPath(base, root === undefined || root === "" ? "storage" : root),
    }
  }
  const images: ResolvedStorageImages = {
    enabled: get(tree, "storage.images.enabled") as boolean,
    maxDimension: get(tree, "storage.images.maxDimension") as number,
    maxSourceSize: get(tree, "storage.images.maxSourceSize") as number,
  }
  return {
    backend,
    maxUploadSize: get(tree, "storage.maxUploadSize") as number,
    images,
    buckets,
  }
}

/** Resolves the `webhooks` section: names, collections, URLs and cron expressions. */
function normalizeWebhooks(
  resolver: Resolver,
  tree: Record<string, unknown>,
): ResolvedConfig["webhooks"] {
  const triggers: Record<string, ResolvedTrigger> = {}
  const schedules: Record<string, ResolvedSchedule> = {}
  const httpUrl = (path: string, value: unknown): string | undefined => {
    if (typeof value !== "string") {
      resolver.problem(path, "The endpoint URL is required.", true)
      return undefined
    }
    if (!/^https?:$/.test(new URL(value).protocol)) {
      resolver.problem(path, "The endpoint must be an http or https URL.")
      return undefined
    }
    return value
  }
  const named = (kind: string, name: string): boolean => {
    if (HOOK_NAME.test(name)) return true
    resolver.problem(
      `webhooks.${kind}.${name}`,
      "Use a name that starts with a letter and holds only letters, digits, underscores and hyphens (at most 64 characters).",
    )
    return false
  }
  const rawTriggers = get(tree, "webhooks.triggers")
  if (isPlainObject(rawTriggers))
    for (const [name, value] of Object.entries(rawTriggers)) {
      if (!named("triggers", name) || !isPlainObject(value)) continue
      const path = `webhooks.triggers.${name}`
      const collection = value["collection"]
      if (
        typeof collection !== "string" ||
        !/^[A-Za-z_][\w.-]{0,119}$/.test(collection) ||
        collection.startsWith("system.")
      ) {
        resolver.problem(
          `${path}.collection`,
          "A trigger needs the name of an app collection.",
          true,
        )
        continue
      }
      const url = httpUrl(`${path}.url`, value["url"])
      if (url === undefined) continue
      const operations = value["operations"]
      const filter = value["filter"]
      triggers[name] = {
        collection,
        operations: Array.isArray(operations)
          ? (operations as TriggerOperation[])
          : [...TRIGGER_OPERATIONS],
        filter: isPlainObject(filter) ? filter : undefined,
        url,
      }
    }
  const rawSchedules = get(tree, "webhooks.schedules")
  if (isPlainObject(rawSchedules))
    for (const [name, value] of Object.entries(rawSchedules)) {
      if (!named("schedules", name) || !isPlainObject(value)) continue
      const path = `webhooks.schedules.${name}`
      if (Object.hasOwn(triggers, name)) {
        resolver.problem(
          path,
          `A trigger is also named ${name}; triggers and schedules share names.`,
        )
        continue
      }
      const cron = value["cron"]
      if (typeof cron !== "string") {
        resolver.problem(`${path}.cron`, "A schedule needs a cron expression.", true)
        continue
      }
      try {
        parseCron(cron)
      } catch (error: unknown) {
        resolver.problem(`${path}.cron`, error instanceof Error ? error.message : String(error))
        continue
      }
      const url = httpUrl(`${path}.url`, value["url"])
      if (url === undefined) continue
      const body = value["body"]
      schedules[name] = { cron, url, body: isPlainObject(body) ? body : undefined }
    }
  const secret = get(tree, "webhooks.secret") as string | undefined
  const hooks = Object.keys(triggers).length + Object.keys(schedules).length
  if (secret === undefined && hooks > 0)
    resolver.problem(
      "webhooks.secret",
      "Webhooks need a signing secret.\nSet CANOPY_WEBHOOK_SECRET or webhooks.secret.",
      true,
    )
  else if (secret !== undefined && !usableSecret(secret))
    resolver.problem(
      "webhooks.secret",
      "Use whsec_ followed by base64 of at least 16 bytes, or a secret of at least 16 characters.",
    )
  return {
    secret,
    maxAttempts: get(tree, "webhooks.maxAttempts") as number,
    timeoutMs: get(tree, "webhooks.timeout") as number,
    triggers,
    schedules,
  }
}

/** Turns a resolved tree into the {@link ResolvedConfig}, checking the rules that span settings. */
export function normalize(
  resolver: Resolver,
  tree: Record<string, unknown>,
  options: ResolveOptions,
): ResolvedConfig {
  resolver.fillDefaults(ROOT_FIELDS, tree, "")
  const at = <T>(path: string): T => get(tree, path) as T
  const environment = at<Environment>("environment")
  const production = environment === "production"

  const uri = get(tree, "mongodb.uri")
  let mongodb: ResolvedConfig["mongodb"] = {
    uri: "",
    database: "",
    metaDatabase: "canopy",
    authDatabase: "canopy_auth",
  }
  if (typeof uri !== "string") {
    if (!resolver.problems.some((problem) => problem.path === "mongodb.uri"))
      resolver.problem(
        "mongodb.uri",
        "No MongoDB connection string.\nSet MONGODB_URI, or mongodb.uri in the config file.",
        true,
      )
  } else if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    resolver.problem(
      "mongodb.uri",
      'Expected a connection string starting with "mongodb://" or "mongodb+srv://".',
    )
  } else {
    const database = (get(tree, "mongodb.database") as string | undefined) ?? databaseFromUri(uri)
    if (database === undefined)
      resolver.problem(
        "mongodb.database",
        "No app database.\nSet CANOPY_DB or mongodb.database, or put the database in the URI path.",
      )
    mongodb = {
      uri,
      database: database ?? "",
      metaDatabase: at<string>("mongodb.metaDatabase"),
      authDatabase: at<string>("mongodb.authDatabase"),
    }
    const names = [mongodb.database, mongodb.metaDatabase, mongodb.authDatabase]
    if (database !== undefined && new Set(names).size !== names.length)
      resolver.problem(
        "mongodb",
        `The app, meta and auth databases must differ; received ${quoted(names)}.`,
      )
  }

  let auth: ResolvedExternalAuth | ResolvedBuiltinAuth | undefined
  const rawAuth = tree["auth"]
  if (isPlainObject(rawAuth) && rawAuth["kind"] !== "builtin") {
    const issuer = rawAuth["issuer"]
    const audience = rawAuth["audience"]
    const jwksUrl = rawAuth["jwksUrl"]
    const jwks = rawAuth["jwks"]
    if (typeof issuer !== "string")
      resolver.problem("auth.issuer", "The token issuer is required (CANOPY_JWT_ISSUER).", true)
    if (typeof audience !== "string")
      resolver.problem(
        "auth.audience",
        "The token audience is required (CANOPY_JWT_AUDIENCE), so tokens minted for other APIs are refused.",
        true,
      )
    if (jwksUrl === undefined && jwks === undefined)
      resolver.problem(
        "auth.jwksUrl",
        "Set the JWKS URL of the identity provider (CANOPY_JWT_JWKS_URL).",
        true,
      )
    if (typeof jwksUrl === "string" && URL.canParse(jwksUrl)) {
      const parsed = new URL(jwksUrl)
      if (parsed.protocol !== "https:" && !isLocalHost(parsed.hostname))
        resolver.problem("auth.jwksUrl", "The JWKS URL must use HTTPS outside localhost.")
    }
    const keys = isPlainObject(jwks) ? jwks["keys"] : undefined
    const jwkList =
      Array.isArray(keys) && keys.every(isPlainObject) ? keys.filter(isPlainObject) : undefined
    if (jwks !== undefined && jwkList === undefined)
      resolver.problem("auth.jwks", "A key set needs a keys array of JSON Web Keys.", true)
    const algorithms = rawAuth["algorithms"]
    if (Array.isArray(algorithms)) {
      for (const algorithm of algorithms)
        if (FORBIDDEN_ALGORITHMS.has(String(algorithm)))
          resolver.problem(
            "auth.algorithms",
            `The algorithm ${String(algorithm)} is never accepted.`,
          )
    }
    if (typeof issuer === "string" && typeof audience === "string") {
      auth = {
        issuer,
        audience,
        ...(typeof jwksUrl === "string" ? { jwksUrl } : {}),
        ...(jwkList === undefined ? {} : { jwks: { keys: jwkList } }),
        ...(Array.isArray(algorithms) ? { algorithms: algorithms as string[] } : {}),
        ...(typeof rawAuth["rolesClaim"] === "string" ? { rolesClaim: rawAuth["rolesClaim"] } : {}),
        ...(rawAuth["allowServiceRoleFromJwt"] === true ? { allowServiceRoleFromJwt: true } : {}),
        ...(typeof rawAuth["clockToleranceSeconds"] === "number"
          ? { clockToleranceSeconds: rawAuth["clockToleranceSeconds"] }
          : {}),
      }
    }
  }

  const policiesTree = tree["policies"]
  let policies: ResolvedConfig["policies"] = { source: "database", watch: true }
  if (isPlainObject(policiesTree) && typeof policiesTree["dir"] === "string") {
    const source = resolver.sources.get("policies.dir")
    const base = source?.kind === "env" ? options.cwd : options.baseDir
    policies = { dir: joinPath(base, policiesTree["dir"]), watch: policiesTree["watch"] !== false }
  } else {
    if (policiesTree === undefined) resolver.sources.set("policies.source", { kind: "default" })
    policies = {
      source: "database",
      watch: !(isPlainObject(policiesTree) && policiesTree["watch"] === false),
    }
  }

  const rest: ResolvedConfig["rest"] =
    tree["rest"] === false
      ? false
      : {
          defaultLimit: at<number>("rest.defaultLimit"),
          maxLimit: at<number>("rest.maxLimit"),
          maxBodyBytes: at<number>("rest.maxBodyBytes"),
          mutationTtlMs: at<number>("rest.mutationTtl"),
        }
  if (rest !== false && rest.defaultLimit > rest.maxLimit)
    resolver.problem("rest.defaultLimit", `Must not exceed rest.maxLimit (${rest.maxLimit}).`)

  const realtime: ResolvedConfig["realtime"] =
    tree["realtime"] === false
      ? false
      : {
          fullDocument: at<FullDocumentMode>("realtime.fullDocument"),
          transports: at<Transport[]>("realtime.transports"),
          resumeWindowMs: at<number>("realtime.resumeWindow"),
          checkpoints: at<"meta" | "off">("realtime.checkpoints"),
          drainWindowMs: at<number>("realtime.drainWindow"),
          echoTimeoutMs: at<number>("realtime.echoTimeout"),
          server:
            options.command === "dev" && resolver.sources.get("realtime.server")?.kind === "default"
              ? "auto"
              : at<RealtimeServer>("realtime.server"),
        }

  const rateLimits: ResolvedConfig["rateLimits"] =
    tree["rateLimits"] === false || get(tree, "rateLimits.enabled") === false
      ? false
      : {
          requests: {
            perSecond: at<number>("rateLimits.requests.perSecond"),
            burst: at<number>("rateLimits.requests.burst"),
          },
          messages: {
            perSecond: at<number>("rateLimits.messages.perSecond"),
            burst: at<number>("rateLimits.messages.burst"),
          },
          anonymousConnectionsPerAddress: at<number>("rateLimits.anonymousConnectionsPerAddress"),
          failedAuthentications: {
            perSecond: at<number>("rateLimits.failedAuthentications.perSecond"),
            burst: at<number>("rateLimits.failedAuthentications.burst"),
          },
          exemptService: at<boolean>("rateLimits.exemptService"),
        }

  const graphqlTree = tree["graphql"]
  const persistedFile = get(tree, "graphql.persisted.file")
  const persistedOnly = get(tree, "graphql.persisted.only") === true
  if (typeof persistedFile !== "string" && persistedOnly)
    resolver.problem(
      "graphql.persisted.file",
      "Allowing only persisted operations needs a file of them.",
    )
  const graphql: ResolvedConfig["graphql"] =
    graphqlTree === false || rest === false
      ? false
      : {
          maxDepth: at<number>("graphql.maxDepth"),
          maxComplexity: at<number>("graphql.maxComplexity"),
          maxAliases: at<number>("graphql.maxAliases"),
          maxBatch: at<number>("graphql.maxBatch"),
          introspection:
            (get(tree, "graphql.introspection") as GraphqlIntrospection | undefined) ??
            (production ? "authenticated" : "always"),
          persisted:
            typeof persistedFile === "string"
              ? { file: joinPath(options.baseDir, persistedFile), only: persistedOnly }
              : undefined,
        }

  const collections: Record<string, ResolvedCollection> = {}
  const rawCollections = tree["collections"]
  if (isPlainObject(rawCollections)) {
    for (const [name, value] of Object.entries(rawCollections)) {
      const entry = isPlainObject(value) ? value : {}
      const idType = entry["idType"]
      const typeName = entry["typeName"]
      if (typeof typeName === "string" && !/^[_A-Za-z][_0-9A-Za-z]*$/.test(typeName))
        resolver.problem(`collections.${name}.typeName`, "Must be a valid GraphQL name.")
      const relations: Record<string, ResolvedRelation> = {}
      const rawRelations = entry["relations"]
      if (isPlainObject(rawRelations)) {
        for (const [field, relation] of Object.entries(rawRelations)) {
          if (!isPlainObject(relation)) continue
          const { to, local, foreign, many } = relation
          if (typeof to !== "string" || typeof local !== "string") {
            resolver.problem(
              `collections.${name}.relations.${field}`,
              "A relation needs to (the target collection) and local (the field holding the key).",
            )
            continue
          }
          relations[field] = {
            to,
            local,
            foreign: typeof foreign === "string" ? foreign : "_id",
            many: many === true,
          }
        }
      }
      collections[name] = {
        idType: (typeof idType === "string" ? idType : "auto") as IdType,
        ...(typeof typeName === "string" ? { typeName } : {}),
        ...(Object.keys(relations).length === 0 ? {} : { relations }),
        ...(entry["search"] === true ? { search: true } : {}),
      }
    }
  }

  const publicUrl = get(tree, "publicUrl") as string | undefined
  const origins = get(tree, "cors.origins") as readonly string[] | "*" | undefined
  let cors: ResolvedConfig["cors"]
  if (origins !== undefined) cors = { origins }
  else if (publicUrl !== undefined) {
    cors = { origins: [new URL(publicUrl).origin] }
    resolver.sources.set("cors.origins", { kind: "default" })
  }
  if (production && origins === "*")
    resolver.problem(
      "cors.origins",
      'Any origin ("*") is refused in production. List the allowed origins.',
    )

  if (isPlainObject(rawAuth) && rawAuth["kind"] === "builtin")
    auth = normalizeBuiltin(resolver, rawAuth, {
      production,
      publicUrl,
      masterKey: get(tree, "masterKey") as string | undefined,
      rotatingMasterKey:
        ((get(tree, "previousMasterKeys") as string[] | undefined) ?? []).length > 0,
      cors,
    })

  const insecure = at<boolean>("dev.insecure")
  if (production && insecure)
    resolver.problem(
      "dev.insecure",
      "Development mode switches are refused when CANOPY_ENV is production.",
    )
  if (production)
    for (const kind of ["publishable", "secret"] as const) {
      const keys = (get(tree, `keys.${kind}`) as readonly string[] | undefined) ?? []
      if (keys.some(isDevelopmentKey))
        resolver.problem(
          `keys.${kind}`,
          "Development API keys (such as pk_dev or sk_dev_change_me from the compose file, or keys made by canopy dev) are refused in production. Generate new keys.",
        )
    }
  const metricsToken = get(tree, "server.metricsToken")
  if (typeof metricsToken === "string" && metricsToken.length < 16)
    resolver.problem("server.metricsToken", "The metrics token must have at least 16 characters.")
  const masterKey = get(tree, "masterKey") as string | undefined
  if (
    production &&
    masterKey === undefined &&
    (options.command === "start" || options.command === "dev")
  )
    resolver.problem("masterKey", "CANOPY_MASTER_KEY is required in production.", true)

  const typesOut = get(tree, "types.out")
  return {
    file: options.file,
    environment,
    mongodb,
    publicUrl,
    masterKey,
    previousMasterKeys: (get(tree, "previousMasterKeys") as string[] | undefined) ?? [],
    auth,
    keys: {
      publishable: at<string[]>("keys.publishable"),
      secret: at<string[]>("keys.secret"),
    },
    policies,
    rest,
    graphql,
    realtime,
    rateLimits,
    collections,
    cors,
    audit: { dataWrites: at<boolean>("audit.dataWrites") },
    webhooks: normalizeWebhooks(resolver, tree),
    storage: normalizeStorage(resolver, tree, options),
    telemetry: { tracing: at<boolean>("telemetry.tracing") },
    server: {
      port: at<number>("server.port"),
      metricsPort: at<number>("server.metricsPort"),
      metricsHost: at<string>("server.metricsHost"),
      metricsToken: at<string | undefined>("server.metricsToken"),
      adminListen: at<string | undefined>("server.adminListen"),
      nodeId: at<string>("server.nodeId"),
      trustedProxies: at<string[]>("server.trustedProxies"),
      engine: at<Engine>("server.engine"),
    },
    log: { level: at<LogLevel>("log.level") },
    types: {
      out:
        typeof typesOut === "string"
          ? joinPath(options.baseDir, typesOut)
          : joinPath(options.cwd, "src/canopy.gen.ts"),
      role: get(tree, "types.role") as string | undefined,
    },
    dev: { insecure },
  }
}

/** Joins a possibly relative POSIX or Windows path onto a base directory, without `node:path`. */
export function joinPath(base: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/"
  const parts = base.split(/[\\/]/)
  for (const segment of path.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") parts.pop()
    else parts.push(segment)
  }
  return parts.join(separator)
}
