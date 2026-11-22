import { get, isLocalHost, isPlainObject, type Resolver } from "./resolver.ts"
import type { ResolvedBuiltinAuth, ResolvedConfig, ResolvedEmailTransport } from "./types.ts"

/** Checks a resolved email transport; returns the problem as a string when it is not valid. */
function emailTransport(raw: Record<string, unknown>): ResolvedEmailTransport | string {
  const text = (name: string): string | undefined =>
    typeof raw[name] === "string" ? String(raw[name]) : undefined
  const missing = (names: string): string => `The ${String(raw["kind"])} transport needs ${names}.`
  const optionalText = (name: string): Record<string, string> => {
    const value = text(name)
    return value === undefined ? {} : { [name]: value }
  }
  switch (raw["kind"]) {
    case "log":
      return { kind: "log" }
    case "resend": {
      const apiKey = text("apiKey")
      return apiKey === undefined ? missing("an apiKey") : { kind: "resend", apiKey }
    }
    case "postmark": {
      const serverToken = text("serverToken")
      return serverToken === undefined
        ? missing("a serverToken")
        : { kind: "postmark", serverToken, ...optionalText("messageStream") }
    }
    case "ses": {
      const region = text("region")
      const accessKeyId = text("accessKeyId")
      const secretAccessKey = text("secretAccessKey")
      return region === undefined || accessKeyId === undefined || secretAccessKey === undefined
        ? missing("region, accessKeyId and secretAccessKey")
        : { kind: "ses", region, accessKeyId, secretAccessKey, ...optionalText("sessionToken") }
    }
    case "smtp": {
      const host = text("host")
      if (host === undefined) return missing("a host")
      const port = raw["port"]
      if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port)))
        return "The smtp port must be a whole number."
      const flags: { secure?: boolean; requireTls?: boolean } = {}
      for (const name of ["secure", "requireTls"] as const) {
        const value = raw[name]
        if (value === undefined) continue
        if (typeof value !== "boolean") return `The smtp ${name} option must be true or false.`
        flags[name] = value
      }
      return {
        kind: "smtp",
        host,
        ...(typeof port === "number" ? { port } : {}),
        ...flags,
        ...optionalText("user"),
        ...optionalText("pass"),
      }
    }
    default:
      return `Unknown email transport ${JSON.stringify(raw["kind"])}; use email.smtp(), email.resend(), email.postmark(), email.ses() or email.log().`
  }
}

const EXTERNAL_ONLY = [
  "jwksUrl",
  "jwks",
  "issuer",
  "audience",
  "algorithms",
  "rolesClaim",
  "allowServiceRoleFromJwt",
  "clockToleranceSeconds",
]
const PROVIDER_IDS = ["google", "github", "apple", "microsoft", "discord"]

function isHttps(value: string): boolean {
  const parsed = new URL(value)
  return parsed.protocol === "https:" || isLocalHost(parsed.hostname)
}

/** Validates built in auth, whose defaults are already applied. Durations arrive in milliseconds. */
export function normalizeBuiltin(
  resolver: Resolver,
  raw: Record<string, unknown>,
  context: {
    readonly production: boolean
    readonly publicUrl: string | undefined
    readonly masterKey: string | undefined
    readonly rotatingMasterKey: boolean
    readonly cors: ResolvedConfig["cors"]
  },
): ResolvedBuiltinAuth {
  const { production } = context
  const at = <T>(path: string): T => get(raw, path) as T
  for (const key of EXTERNAL_ONLY)
    if (raw[key] !== undefined)
      resolver.problem(
        `auth.${key}`,
        "Applies to external identity providers only; built in auth issues its own tokens.\nRemove it (or the CANOPY_JWT_* variable that sets it).",
      )
  resolver.secrets.add("auth.secret")
  const secret = (raw["secret"] as string | undefined) ?? context.masterKey
  if (raw["secret"] === undefined && context.rotatingMasterKey)
    resolver.problem(
      "auth.secret",
      "Built in auth uses the master key as its secret, so rotating the master key would make its signing keys unreadable.\nSet auth.secret to the previous master key first.",
    )
  if (secret !== undefined && secret.length < 32)
    resolver.problem("auth.secret", "The auth secret needs at least 32 characters.")
  if (secret === undefined && production)
    resolver.problem(
      "auth.secret",
      "Built in auth needs a secret: set CANOPY_MASTER_KEY or auth.secret.",
      true,
    )
  if (context.publicUrl === undefined && production)
    resolver.problem(
      "publicUrl",
      "Built in auth needs the external URL for token issuers and links (CANOPY_PUBLIC_URL).",
      true,
    )
  else if (context.publicUrl !== undefined && production && !isHttps(context.publicUrl))
    resolver.problem("publicUrl", "Built in auth needs an https public URL in production.")

  const ttl = at<number>("accessTokenTtl")
  const interval = at<number>("keyRotation.interval")
  const grace = at<number>("keyRotation.grace")
  if (grace < ttl)
    resolver.problem(
      "auth.keyRotation.grace",
      "The grace period must cover the access token lifetime, or tokens stop verifying early.",
    )

  const corsOrigins =
    context.cors !== undefined && context.cors.origins !== "*" ? context.cors.origins : []
  const redirectUrls = (raw["redirectUrls"] as string[] | undefined) ?? [...corsOrigins]
  for (const entry of redirectUrls) {
    if (!URL.canParse(entry) || !/^https?:$/.test(new URL(entry).protocol))
      resolver.problem("auth.redirectUrls", `${JSON.stringify(entry)} is not an http(s) URL.`)
    else if (production && !isHttps(entry))
      resolver.problem(
        "auth.redirectUrls",
        `${JSON.stringify(entry)} must use https in production.`,
      )
  }

  const emailPassword: ResolvedBuiltinAuth["emailPassword"] =
    raw["emailPassword"] === false
      ? false
      : {
          minPasswordLength: at<number>("emailPassword.minPasswordLength"),
          requireEmailVerification: at<boolean>("emailPassword.requireEmailVerification"),
        }

  const providers: Record<string, { clientId: string; clientSecret: string; tenantId?: string }> =
    {}
  const rawProviders = raw["providers"]
  if (isPlainObject(rawProviders)) {
    for (const id of PROVIDER_IDS) {
      const provider = rawProviders[id]
      if (!isPlainObject(provider)) continue
      resolver.secrets.add(`auth.providers.${id}.clientSecret`)
      const clientId = provider["clientId"]
      const clientSecret = provider["clientSecret"]
      if (typeof clientId !== "string" || typeof clientSecret !== "string") {
        resolver.problem(`auth.providers.${id}`, "Set clientId and clientSecret.", true)
        continue
      }
      providers[id] = {
        clientId,
        clientSecret,
        ...(typeof provider["tenantId"] === "string" ? { tenantId: provider["tenantId"] } : {}),
      }
    }
  }

  const oidc: ResolvedBuiltinAuth["oidc"][number][] = []
  const rawOidc = raw["oidc"]
  const ids = new Set<string>(PROVIDER_IDS)
  if (Array.isArray(rawOidc)) {
    rawOidc.forEach((item: unknown, index) => {
      const path = `auth.oidc.${index}`
      resolver.secrets.add(`${path}.clientSecret`)
      if (!isPlainObject(item)) return
      const { id, discoveryUrl, clientId, clientSecret, scopes } = item
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
        resolver.problem(`${path}.id`, "Use lower case letters, digits, _ and -.")
        return
      }
      if (ids.has(id)) {
        resolver.problem(`${path}.id`, `The provider id ${JSON.stringify(id)} is used twice.`)
        return
      }
      ids.add(id)
      if (
        typeof discoveryUrl !== "string" ||
        typeof clientId !== "string" ||
        typeof clientSecret !== "string"
      ) {
        resolver.problem(path, "Set discoveryUrl, clientId and clientSecret.", true)
        return
      }
      if (production && !isHttps(discoveryUrl))
        resolver.problem(`${path}.discoveryUrl`, "Use https in production.")
      oidc.push({
        id,
        discoveryUrl,
        clientId,
        clientSecret,
        ...(Array.isArray(scopes) ? { scopes: scopes as string[] } : {}),
      })
    })
  }

  let email: ResolvedBuiltinAuth["email"] = {
    from: "Canopy <auth@localhost>",
    transport: { kind: "log" },
  }
  const rawEmail = raw["email"]
  for (const key of ["pass", "apiKey", "serverToken", "secretAccessKey", "sessionToken"])
    resolver.secrets.add(`auth.email.transport.${key}`)
  if (isPlainObject(rawEmail)) {
    const transport = rawEmail["transport"]
    if (typeof rawEmail["from"] !== "string")
      resolver.problem("auth.email.from", "Set the sender address.", true)
    if (!isPlainObject(transport)) {
      if (!resolver.problems.some((problem) => problem.path.startsWith("auth.email.transport")))
        resolver.problem("auth.email.transport", "Set a transport such as email.resend().", true)
    } else {
      if (transport["kind"] === "log" && production)
        resolver.problem("auth.email.transport", "email.log() is refused in production.")
      const resolved = emailTransport(transport)
      if (typeof resolved === "string") {
        if (!resolver.problems.some((problem) => problem.path.startsWith("auth.email.transport")))
          resolver.problem("auth.email.transport", resolved, true)
      } else
        email = {
          from: typeof rawEmail["from"] === "string" ? rawEmail["from"] : email.from,
          transport: resolved,
        }
    }
  } else if (production) {
    resolver.problem(
      "auth.email",
      "Built in auth sends verification, reset and sign in emails; configure auth.email.",
      true,
    )
  }

  const claims = raw["claims"]
  const appName = raw["appName"]
  if (typeof appName !== "string" || appName.trim() === "" || appName.length > 100)
    resolver.problem("auth.appName", "Use 1 to 100 characters.")
  return {
    kind: "builtin",
    appName: typeof appName === "string" ? appName : "Canopy",
    secret,
    accessTokenTtlSeconds: Math.round(ttl / 1000),
    algorithm: at<"EdDSA" | "ES256">("algorithm"),
    keyRotation: {
      intervalSeconds: Math.round(interval / 1000),
      graceSeconds: Math.round(grace / 1000),
    },
    redirectUrls,
    emailPassword,
    magicLink: at<boolean>("magicLink"),
    emailOtp: at<boolean>("emailOtp"),
    anonymous: at<boolean>("anonymous"),
    twoFactor: at<boolean>("twoFactor"),
    passkeys: at<boolean>("passkeys"),
    providers,
    oidc,
    claims: typeof claims === "function" ? (claims as ResolvedBuiltinAuth["claims"]) : undefined,
    email,
    trustedProxies: at<string[]>("trustedProxies"),
    identifierLimit: {
      max: at<number>("identifierLimit.max"),
      windowSeconds: Math.round(at<number>("identifierLimit.window") / 1000),
    },
    session: {
      expiresInSeconds: Math.round(at<number>("session.expiresIn") / 1000),
      updateAgeSeconds: Math.round(at<number>("session.updateAge") / 1000),
    },
  }
}
