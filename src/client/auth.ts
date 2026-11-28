import { type CanopyError, errorFromWire, isErrorCode } from "../core/protocol/index.ts"
import type { Persister, TokenSource } from "./client-types.ts"

/** A refusal from `/auth/v1` with an engine code such as `INVALID_EMAIL_OR_PASSWORD` or `EMAIL_NOT_VERIFIED`. */
export class AuthError extends Error {
  readonly code: string
  readonly status: number
  /** The available methods when the code is `TWO_FACTOR_REQUIRED`. */
  readonly twoFactorMethods?: readonly string[]

  constructor(code: string, status: number, message: string, twoFactorMethods?: readonly string[]) {
    super(message)
    this.name = "AuthError"
    this.code = code
    this.status = status
    if (twoFactorMethods !== undefined) this.twoFactorMethods = twoFactorMethods
  }
}

/** The signed in user, read from the access token. */
export interface AuthUser {
  readonly id: string
  readonly email: string | undefined
  readonly emailVerified: boolean
  readonly isAnonymous: boolean
  readonly roles: readonly string[]
  readonly appMetadata: Readonly<Record<string, unknown>>
  readonly userMetadata: Readonly<Record<string, unknown>>
}

/** Options of {@link createAuth}. */
export interface AuthOptions {
  /** The Canopy base URL, for example `https://api.example.com`. */
  readonly url: string
  /** Keeps the session across reloads (scope `auth`), for example `indexedDbPersister()`. */
  readonly storage?: Persister
  /**
   * `bearer` (the default) keeps a session token in `storage` and works cross site and in native apps;
   * `cookie` relies on the httpOnly session cookie of a same site deployment.
   */
  readonly mode?: "bearer" | "cookie"
  readonly fetch?: typeof fetch
  /** @internal A clock for tests. */
  readonly now?: () => number
}

interface Stored {
  readonly token: string
}

interface Cached {
  readonly token: string
  readonly issuedAt: number
  readonly expiresAt: number
}

const KEY = "session"
const SIGN_UP = "sign-up"
const SIGN_UP_PROOFS = 5

type SecondFactorTransport = "header" | "cookie"

function claimsOf(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? ""
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = Uint8Array.from(json, (char) => char.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function userOf(token: string): AuthUser {
  const claims = claimsOf(token)
  return {
    id: String(claims["sub"] ?? ""),
    email: typeof claims["email"] === "string" ? claims["email"] : undefined,
    emailVerified: claims["email_verified"] === true,
    isAnonymous: claims["is_anonymous"] === true,
    roles: Array.isArray(claims["roles"])
      ? claims["roles"].filter((role): role is string => typeof role === "string")
      : [],
    appMetadata: record(claims["app_metadata"]),
    userMetadata: record(claims["user_metadata"]),
  }
}

/**
 * Built in auth for the browser and native apps. Pass it as `auth` to `createClient`: the client takes
 * access tokens from it, refreshes them at 80 % of their lifetime, sends them on the socket, and reconnects
 * as the new user after a sign in or sign out. A failing claims hook surfaces as `AuthHookFailedError`
 * (`CANOPY_AUTH_HOOK_FAILED`).
 */
export class CanopyAuth implements TokenSource {
  private readonly options: AuthOptions
  private readonly base: string
  private readonly http: typeof fetch
  private readonly now: () => number
  private session: Stored | undefined
  private cached: Cached | undefined
  private refreshing: Promise<string | null> | undefined
  private readonly listeners = new Set<() => void>()
  private subject: string | undefined
  /** The signed cookies of a sign in waiting for its second step (a second factor or a passkey). */
  private ceremony: string | undefined
  private secondFactorTransport: SecondFactorTransport | undefined
  private signUpProofs: readonly string[] = []
  /** Resolves once the stored session is loaded. */
  readonly ready: Promise<void>

  constructor(options: AuthOptions) {
    this.options = options
    this.base = `${options.url.replace(/\/$/, "")}/auth/v1`
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
    this.ready = this.load()
  }

  private get bearer(): boolean {
    return (this.options.mode ?? "bearer") === "bearer"
  }

  private async load(): Promise<void> {
    const proofs = await this.options.storage?.get("auth", SIGN_UP)
    if (proofs !== undefined) {
      try {
        const parsed: unknown = JSON.parse(proofs)
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(
            (proof): proof is string =>
              typeof proof === "string" && /^[!-~]+$/.test(proof) && !proof.includes(","),
          )
          this.signUpProofs = [...new Set(valid)].slice(0, SIGN_UP_PROOFS)
        }
      } catch {
        await this.options.storage?.delete("auth", SIGN_UP)
      }
    }
    const text = await this.options.storage?.get("auth", KEY)
    if (text === undefined) return
    try {
      const parsed: unknown = JSON.parse(text)
      const token = (parsed as { token?: unknown }).token
      if (typeof token === "string" && token !== "") this.session = { token }
    } catch {
      await this.options.storage?.delete("auth", KEY)
    }
  }

  /** Calls `listener` when the user changes (sign in, sign out, upgrade, a revoked session). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(token: string | null): void {
    const subject = token === null ? undefined : userOf(token).id
    const anonymous = token === null ? undefined : userOf(token).isAnonymous
    const key = `${subject ?? ""}|${String(anonymous)}`
    if (key === this.subject) return
    this.subject = key
    for (const listener of this.listeners) listener()
  }

  /** The signed in user, from the last access token. `undefined` when signed out or not loaded yet. */
  get user(): AuthUser | undefined {
    return this.cached === undefined ? undefined : userOf(this.cached.token)
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    secondFactor?: SecondFactorTransport,
  ): Promise<Response> {
    await this.ready
    const headers: Record<string, string> = {}
    if (body !== undefined) headers["content-type"] = "application/json"
    if (this.bearer && this.session !== undefined && secondFactor === undefined)
      headers["authorization"] = `Bearer ${this.session.token}`
    if (this.ceremony !== undefined) headers["x-canopy-ceremony"] = this.ceremony
    if (path === "/email-otp/verify-email" && this.signUpProofs.length > 0)
      headers["x-canopy-sign-up"] = this.signUpProofs.join(", ")
    const response = await this.http(`${this.base}${path}`, {
      method,
      headers,
      credentials: !this.bearer || secondFactor === "cookie" ? "include" : "omit",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const rolled = response.headers.get("set-auth-token")
    if (this.bearer && rolled !== null && rolled !== "") await this.store(rolled)
    const ceremony = response.headers.get("set-auth-ceremony")
    if (ceremony !== null && ceremony !== "") this.ceremony = ceremony
    const proof = response.headers.get("set-auth-sign-up")
    if (proof !== null && proof !== "") await this.keepSignUpProof(proof)
    return response
  }

  private async keepSignUpProof(proof: string): Promise<void> {
    this.signUpProofs = [proof, ...this.signUpProofs.filter((kept) => kept !== proof)].slice(
      0,
      SIGN_UP_PROOFS,
    )
    await this.options.storage?.set("auth", SIGN_UP, JSON.stringify(this.signUpProofs))
  }

  private async failure(response: Response): Promise<AuthError | CanopyError> {
    let code = "UNKNOWN"
    let message = `The auth server answered ${response.status}`
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown }
      if (typeof body.code === "string") code = body.code
      if (typeof body.message === "string") message = body.message
    } catch {
      code = "UNKNOWN"
    }
    return isErrorCode(code)
      ? errorFromWire({ code, msg: message })
      : new AuthError(code, response.status, message)
  }

  private async expect(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) throw await this.failure(response)
    const text = await response.text()
    if (text === "") return {}
    const value: unknown = JSON.parse(text)
    return record(value) as Record<string, unknown>
  }

  private async store(token: string): Promise<void> {
    this.session = { token }
    await this.options.storage?.set("auth", KEY, JSON.stringify({ token }))
  }

  private async forget(): Promise<void> {
    this.session = undefined
    this.cached = undefined
    await this.options.storage?.delete("auth", KEY)
    this.changed(null)
  }

  /** After a sign in: drop the old access token and fetch one for the new session. */
  private async signedIn(): Promise<AuthUser> {
    if (this.secondFactorTransport !== undefined) {
      this.secondFactorTransport = undefined
      this.ceremony = undefined
    }
    this.cached = undefined
    const token = await this.refresh()
    if (token === null)
      throw new AuthError("NO_SESSION", 401, "The sign in did not create a session")
    return userOf(token)
  }

  private requireSecondFactor(methods: readonly string[], transport: SecondFactorTransport): never {
    this.secondFactorTransport = transport
    throw new AuthError(
      "TWO_FACTOR_REQUIRED",
      401,
      "Enter the code of the authenticator app",
      methods,
    )
  }

  private async finishFirstFactor(response: Response): Promise<AuthUser> {
    const body = await this.expect(response)
    if (body["twoFactorRedirect"] === true) {
      const methods: unknown = body["twoFactorMethods"]
      this.ceremony = response.headers.get("set-auth-ceremony") || undefined
      this.requireSecondFactor(
        Array.isArray(methods)
          ? methods.filter((method): method is string => typeof method === "string")
          : [],
        "header",
      )
    }
    return this.signedIn()
  }

  /**
   * The current access token, or `null` when signed out. A cached token is reused until 80 % of its
   * lifetime has passed. Throws `AuthHookFailedError` when the claims hook fails.
   */
  async getToken(): Promise<string | null> {
    await this.ready
    const cached = this.cached
    if (cached !== undefined) {
      const refreshAt = cached.issuedAt + (cached.expiresAt - cached.issuedAt) * 0.8
      if (this.now() < refreshAt) return cached.token
    }
    return this.refresh()
  }

  /** Fetches a new access token now. */
  refresh(): Promise<string | null> {
    this.refreshing ??= this.mint().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async mint(): Promise<string | null> {
    await this.ready
    if (this.bearer && this.session === undefined) {
      this.changed(null)
      return null
    }
    const response = await this.call("GET", "/token")
    if (response.status === 401) {
      await response.body?.cancel()
      await this.forget()
      return null
    }
    const body = await this.expect(response)
    const token = body["access_token"]
    if (typeof token !== "string") throw new AuthError("INVALID_RESPONSE", 500, "No access token")
    const claims = claimsOf(token)
    const now = this.now()
    const issuedAt = typeof claims["iat"] === "number" ? claims["iat"] * 1000 : now
    const expiresAt = typeof claims["exp"] === "number" ? claims["exp"] * 1000 : now
    this.cached = { token, issuedAt: Math.min(issuedAt, now), expiresAt }
    this.changed(token)
    return token
  }

  /**
   * Creates an account. With email verification on (the default) the answer is the same whether or not
   * the address was taken, `{ verification: "sent" }`, and the user signs in after following the link.
   */
  async signUp(input: {
    readonly email: string
    readonly password: string
    readonly name?: string
    readonly callbackURL?: string
  }): Promise<{ readonly verification: "sent" } | { readonly user: AuthUser }> {
    const body = await this.expect(
      await this.call("POST", "/sign-up/email", { name: input.name ?? "", ...input }),
    )
    if (body["token"] === null || body["token"] === undefined) return { verification: "sent" }
    if (this.bearer && typeof body["token"] === "string") await this.store(body["token"])
    return { user: await this.signedIn() }
  }

  /**
   * Signs in with an email address and password. When the user has a second factor, it rejects with an
   * `AuthError` whose code is `TWO_FACTOR_REQUIRED`; finish with {@link verifyTotp} or
   * {@link verifyBackupCode}.
   */
  async signInWithPassword(input: {
    readonly email: string
    readonly password: string
  }): Promise<AuthUser> {
    return this.finishFirstFactor(await this.call("POST", "/sign-in/email", input))
  }

  private async verifySecondFactor(path: string, input: unknown): Promise<AuthUser> {
    await this.expect(await this.call("POST", path, input, this.secondFactorTransport))
    this.ceremony = undefined
    return this.signedIn()
  }

  /** Completes a sign in with the authenticator app's code. `trustDevice` skips it here for 30 days. */
  async verifyTotp(input: {
    readonly code: string
    readonly trustDevice?: boolean
  }): Promise<AuthUser> {
    return this.verifySecondFactor("/two-factor/verify-totp", input)
  }

  /** Completes a sign in with one of the single use backup codes. */
  async verifyBackupCode(input: { readonly code: string }): Promise<AuthUser> {
    return this.verifySecondFactor("/two-factor/verify-backup-code", input)
  }

  /**
   * Starts enrolling an authenticator app for the signed in user: show `totpURI` as a QR code and keep the
   * backup codes, then confirm with {@link confirmTwoFactor}.
   */
  async enableTwoFactor(input: {
    readonly password: string
  }): Promise<{ readonly totpURI: string; readonly backupCodes: readonly string[] }> {
    const body = await this.expect(await this.call("POST", "/two-factor/enable", input))
    const codes = body["backupCodes"]
    return {
      totpURI: String(body["totpURI"] ?? ""),
      backupCodes: Array.isArray(codes) ? codes.map(String) : [],
    }
  }

  /** Turns the second factor on with a first code from the app; the new session counts as `aal2`. */
  async confirmTwoFactor(input: { readonly code: string }): Promise<AuthUser> {
    await this.expect(await this.call("POST", "/two-factor/verify-totp", input))
    return this.signedIn()
  }

  /** Turns the second factor off. */
  async disableTwoFactor(input: { readonly password: string }): Promise<void> {
    await this.expect(await this.call("POST", "/two-factor/disable", input))
  }

  /** Registers a passkey of this device for the signed in user. Needs WebAuthn (`navigator.credentials`). */
  async addPasskey(input: { readonly name?: string } = {}): Promise<void> {
    const options = await this.expect(await this.call("GET", "/passkey/generate-register-options"))
    const credential = await webauthn().create({ publicKey: creationOptions(options) })
    await this.expect(
      await this.call("POST", "/passkey/verify-registration", {
        response: credentialJson(credential),
        ...(input.name === undefined ? {} : { name: input.name }),
      }),
    )
  }

  /** Signs in with a passkey; the session counts as `aal2`. Needs WebAuthn (`navigator.credentials`). */
  async signInWithPasskey(): Promise<AuthUser> {
    const options = await this.expect(
      await this.call("GET", "/passkey/generate-authenticate-options"),
    )
    const credential = await webauthn().get({ publicKey: requestOptions(options) })
    await this.expect(
      await this.call("POST", "/passkey/verify-authentication", {
        response: credentialJson(credential),
      }),
    )
    this.ceremony = undefined
    return this.signedIn()
  }

  /** Emails a sign in link that lands on `callbackURL` (which must be in the redirect allowlist). */
  async sendMagicLink(input: {
    readonly email: string
    readonly callbackURL?: string
  }): Promise<void> {
    await this.expect(await this.call("POST", "/sign-in/magic-link", input))
  }

  /** Emails a 6 digit sign in code. */
  async sendOtp(input: { readonly email: string }): Promise<void> {
    await this.expect(
      await this.call("POST", "/email-otp/send-verification-otp", {
        email: input.email,
        type: "sign-in",
      }),
    )
  }

  /** Emails a 6 digit code that verifies the address, for {@link verifyEmailWithOtp}. */
  async sendVerificationOtp(input: { readonly email: string }): Promise<void> {
    await this.expect(
      await this.call("POST", "/email-otp/send-verification-otp", {
        email: input.email,
        type: "email-verification",
      }),
    )
  }

  /**
   * Verifies the address with the emailed code and signs in. The client presents the proof Canopy gave it
   * when it signed the account up, so the password chosen at sign up stays. The proof survives a reload
   * when `storage` is configured. Verified
   * without that proof, for example after signing up on another device, Canopy removes the account's
   * password, because whoever chose it may not control the address. The user then sets a new one with a
   * password reset.
   */
  async verifyEmailWithOtp(input: {
    readonly email: string
    readonly otp: string
  }): Promise<AuthUser> {
    await this.expect(await this.call("POST", "/email-otp/verify-email", input))
    return this.signedIn()
  }

  /** Signs in with the emailed code. Rejects with `TWO_FACTOR_REQUIRED` when a second factor is needed. */
  async signInWithOtp(input: { readonly email: string; readonly otp: string }): Promise<AuthUser> {
    return this.finishFirstFactor(await this.call("POST", "/sign-in/email-otp", input))
  }

  /**
   * Starts an OAuth or OIDC sign in and returns the provider URL; in a browser it also navigates there. The
   * provider redirects back through Canopy to `callbackURL`, where {@link completeRedirect} picks the session up.
   */
  async signInWithOAuth(input: {
    readonly provider: string
    readonly callbackURL: string
    readonly errorCallbackURL?: string
  }): Promise<string> {
    const body = await this.expect(
      await this.call("POST", "/sign-in/social", { ...input, disableRedirect: true }),
    )
    const url = body["url"]
    if (typeof url !== "string") throw new AuthError("INVALID_RESPONSE", 500, "No provider URL")
    const location: unknown = Reflect.get(globalThis, "location")
    const assign: unknown =
      typeof location === "object" && location !== null
        ? Reflect.get(location, "assign")
        : undefined
    if (typeof assign === "function") Reflect.apply(assign, location, [url])
    return url
  }

  /**
   * After an OAuth redirect or a magic link: turns the session cookie the redirect set into this client's
   * session. Returns the user, or `undefined` when there is no session. Rejects with
   * `TWO_FACTOR_REQUIRED` when the redirect requests a second factor. Finish with
   * {@link verifyTotp} or {@link verifyBackupCode}.
   */
  async completeRedirect(): Promise<AuthUser | undefined> {
    const browser = globalThis as typeof globalThis & {
      readonly location?: { readonly href?: string }
      readonly history?: {
        readonly state: unknown
        replaceState(state: unknown, title: string, url: string): void
      }
    }
    const href = browser.location?.href
    if (href !== undefined) {
      const url = new URL(href)
      if (url.searchParams.get("twoFactorRedirect") === "true") {
        const methods = url.searchParams.get("twoFactorMethods")?.split(",").filter(Boolean) ?? []
        url.searchParams.delete("twoFactorRedirect")
        url.searchParams.delete("twoFactorMethods")
        browser.history?.replaceState(browser.history.state, "", url.href)
        this.requireSecondFactor(methods, "cookie")
      }
    }
    await this.ready
    const response = await this.http(`${this.base}/get-session`, { credentials: "include" })
    const rolled = response.headers.get("set-auth-token")
    await response.body?.cancel()
    if (this.bearer && rolled !== null && rolled !== "") await this.store(rolled)
    if (!response.ok || (this.bearer && this.session === undefined)) return undefined
    this.cached = undefined
    const token = await this.refresh()
    return token === null ? undefined : userOf(token)
  }

  /** Signs in as a new anonymous user. Their data stays theirs after {@link upgrade}. */
  async signInAnonymously(): Promise<AuthUser> {
    await this.expect(await this.call("POST", "/sign-in/anonymous", {}))
    return this.signedIn()
  }

  /**
   * Gives the current anonymous user an email address (and a password), keeping their id. A verification
   * email follows; the answer is the same whether or not the address was taken.
   */
  async upgrade(input: {
    readonly email: string
    readonly password?: string
    readonly callbackURL?: string
  }): Promise<AuthUser> {
    await this.expect(await this.call("POST", "/upgrade", input))
    return this.signedIn()
  }

  /** Ends this session on the server and forgets it here. */
  async signOut(): Promise<void> {
    try {
      const response = await this.call("POST", "/sign-out", {})
      await response.body?.cancel()
    } finally {
      this.ceremony = undefined
      this.secondFactorTransport = undefined
      await this.forget()
    }
  }
}

interface CredentialsContainerLike {
  create(options: { publicKey: unknown }): Promise<unknown>
  get(options: { publicKey: unknown }): Promise<unknown>
}

function webauthn(): CredentialsContainerLike {
  const credentials = (globalThis as { navigator?: { credentials?: CredentialsContainerLike } })
    .navigator?.credentials
  if (credentials === undefined)
    throw new AuthError("WEBAUTHN_UNAVAILABLE", 400, "This environment has no WebAuthn support")
  return credentials
}

function fromBase64url(text: string): ArrayBuffer {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer
}

function toBase64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

type Json = Readonly<Record<string, unknown>>

function withIds(list: unknown): unknown {
  return Array.isArray(list)
    ? list.map((entry: Json) => ({ ...entry, id: fromBase64url(String(entry["id"])) }))
    : list
}

/** WebAuthn creation options from their JSON form (base64url buffers). */
function creationOptions(options: Json): unknown {
  const user = record(options["user"])
  return {
    ...options,
    challenge: fromBase64url(String(options["challenge"])),
    user: { ...user, id: fromBase64url(String(user["id"])) },
    excludeCredentials: withIds(options["excludeCredentials"]),
  }
}

/** WebAuthn request options from their JSON form. */
function requestOptions(options: Json): unknown {
  return {
    ...options,
    challenge: fromBase64url(String(options["challenge"])),
    allowCredentials: withIds(options["allowCredentials"]),
  }
}

/** A WebAuthn credential in its JSON form, as the server verifies it. */
function credentialJson(credential: unknown): Json {
  const value = credential as {
    toJSON?: () => Json
    id: string
    rawId: ArrayBuffer
    type: string
    authenticatorAttachment?: string | null
    response: Record<string, unknown> & { getTransports?: () => string[] }
    getClientExtensionResults?: () => Json
  }
  if (typeof value.toJSON === "function") return value.toJSON()
  const response: Record<string, unknown> = {}
  for (const key of [
    "clientDataJSON",
    "attestationObject",
    "authenticatorData",
    "signature",
    "userHandle",
  ]) {
    const part = value.response[key]
    if (part instanceof ArrayBuffer || ArrayBuffer.isView(part)) response[key] = toBase64url(part)
  }
  if (typeof value.response.getTransports === "function")
    response["transports"] = value.response.getTransports()
  return {
    id: value.id,
    rawId: toBase64url(value.rawId),
    type: value.type,
    response,
    authenticatorAttachment: value.authenticatorAttachment ?? undefined,
    clientExtensionResults: value.getClientExtensionResults?.() ?? {},
  }
}

/** Creates the built in auth handle; pass it as `auth` to `createClient`. */
export function createAuth(options: AuthOptions): CanopyAuth {
  return new CanopyAuth(options)
}
