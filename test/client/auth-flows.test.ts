import { afterEach, describe, expect, it, vi } from "vitest"

import { createAuth } from "../../src/client/auth.ts"
import { memoryPersister } from "../../src/client/persist.ts"

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  return `${part({ alg: "none" })}.${part({ iat: 1, exp: 4_000_000_000, ...claims })}.sig`
}

interface Seen {
  readonly path: string
  readonly authorization: string | null
  readonly ceremony: string | null
  readonly credentials: RequestInit["credentials"]
  readonly body: Record<string, unknown> | undefined
}

const SESSION = { "set-auth-token": "session-token" }
const CEREMONY = "canopy.two_factor=signed"

function server(
  seen: Seen[],
  state: { redirected: boolean; aal: string; secondFactor: "header" | "cookie" | undefined },
): typeof fetch {
  return async (input, init = {}) => {
    const path = new URL(String(input)).pathname.replace("/auth/v1", "")
    const headers = new Headers(init.headers)
    const authorization = headers.get("authorization")
    const ceremony = headers.get("x-canopy-ceremony")
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    seen.push({ path, authorization, ceremony, credentials: init.credentials, body })
    const signedIn = authorization === "Bearer session-token"
    const refused = (code: string) => Response.json({ code, message: code }, { status: 401 })
    const hasCeremony =
      state.secondFactor === undefined ||
      (state.secondFactor === "header" ? ceremony === CEREMONY : init.credentials === "include")
    switch (path) {
      case "/two-factor/verify-backup-code":
        if (!hasCeremony) return refused("INVALID_TWO_FACTOR_COOKIE")
        return body?.["code"] === "backup-1"
          ? Response.json({ token: "session-token" }, { headers: SESSION })
          : refused("INVALID_BACKUP_CODE")
      case "/two-factor/enable":
        if (!signedIn) return refused("UNAUTHORIZED")
        return Response.json({
          totpURI: "otpauth://totp/App:a@test.io?secret=ABC",
          backupCodes: ["backup-1", 2],
        })
      case "/two-factor/verify-totp":
        if (!hasCeremony) return refused("INVALID_TWO_FACTOR_COOKIE")
        if (body?.["code"] !== "123456") return refused("INVALID_CODE")
        state.aal = "aal2"
        return Response.json({ token: "session-token" }, { headers: SESSION })
      case "/two-factor/disable":
        return signedIn ? Response.json({ status: true }) : refused("UNAUTHORIZED")
      case "/sign-in/magic-link":
      case "/email-otp/send-verification-otp":
        return new Response(null, { status: 200 })
      case "/sign-in/email-otp":
        if (body?.["otp"] !== "654321") return refused("INVALID_OTP")
        if (state.secondFactor === "header")
          return Response.json(
            { twoFactorRedirect: true, twoFactorMethods: ["totp"] },
            { headers: { "set-auth-ceremony": CEREMONY } },
          )
        return Response.json({ token: "session-token" }, { headers: SESSION })
      case "/sign-in/social":
        return body?.["provider"] === "github"
          ? Response.json({ url: "https://github.test/login/oauth", redirect: false })
          : Response.json({ redirect: false })
      case "/get-session":
        return state.redirected
          ? Response.json({ session: {} }, { headers: SESSION })
          : Response.json(null)
      case "/token":
        return signedIn
          ? Response.json({
              access_token: jwt({ sub: "u1", aal: state.aal }),
              token_type: "bearer",
            })
          : refused("UNAUTHORIZED")
      default:
        return Response.json({ message: "Not found" }, { status: 404 })
    }
  }
}

function setup(redirected = false, secondFactor?: "header" | "cookie") {
  const seen: Seen[] = []
  const state = { redirected, aal: "aal1", secondFactor }
  const auth = createAuth({
    url: "https://api.test/",
    storage: memoryPersister(),
    fetch: server(seen, state),
  })
  return { auth, seen, state }
}

const aalOf = (token: string | null): unknown =>
  JSON.parse(atob((token ?? "").split(".")[1] ?? ""))["aal"]

const locationOf = globalThis as { location?: unknown }
const originalLocation = locationOf.location
/**
 * A page's own `location` cannot be replaced, and assigning it would navigate away from the test page, so
 * the navigation is only observable where the runtime has no fixed `location` (Bun, Node.js, Deno).
 */
const replaceableLocation =
  Object.getOwnPropertyDescriptor(globalThis, "location")?.configurable !== false

function callbackPage(search: string): { href(): string; restore(): void } {
  const browser = globalThis as typeof globalThis & {
    readonly location?: { readonly href: string }
    readonly history?: {
      readonly state: unknown
      replaceState(state: unknown, title: string, url: string): void
    }
  }
  const location = browser.location
  const history = browser.history
  if (location !== undefined && history !== undefined) {
    const original = location.href
    const state = history.state
    history.replaceState(state, "", `${new URL(original).pathname}${search}`)
    return {
      href: () => location.href,
      restore: () => history.replaceState(state, "", original),
    }
  }
  const url = new URL(`https://app.test/callback${search}`)
  vi.stubGlobal("location", {
    get href() {
      return url.href
    },
  })
  vi.stubGlobal("history", {
    state: null,
    replaceState(_state: unknown, _title: string, href: string) {
      url.href = new URL(href, url).href
    },
  })
  return { href: () => url.href, restore: () => vi.unstubAllGlobals() }
}

afterEach(() => {
  if (replaceableLocation)
    Object.defineProperty(globalThis, "location", { value: originalLocation, configurable: true })
})

describe("auth flows of the client", () => {
  it("signs in with a backup code and refuses a wrong one", async () => {
    const { auth } = setup()
    await expect(auth.verifyBackupCode({ code: "nope" })).rejects.toMatchObject({
      code: "INVALID_BACKUP_CODE",
      status: 401,
    })
    expect(await auth.getToken()).toBeNull()
    const user = await auth.verifyBackupCode({ code: "backup-1" })
    expect(user.id).toBe("u1")
  })

  it("enrolls, confirms and turns off a second factor for the signed in user", async () => {
    const { auth, seen } = setup()
    await expect(auth.enableTwoFactor({ password: "pw" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    await auth.signInWithOtp({ email: "a@test.io", otp: "654321" })
    expect(await auth.enableTwoFactor({ password: "pw" })).toEqual({
      totpURI: "otpauth://totp/App:a@test.io?secret=ABC",
      backupCodes: ["backup-1", "2"],
    })
    await expect(auth.confirmTwoFactor({ code: "000000" })).rejects.toMatchObject({
      code: "INVALID_CODE",
    })
    const user = await auth.confirmTwoFactor({ code: "123456" })
    expect(user.id).toBe("u1")
    expect(aalOf(await auth.getToken())).toBe("aal2")
    await auth.disableTwoFactor({ password: "pw" })
    const disable = seen.find((request) => request.path === "/two-factor/disable")
    expect(disable).toMatchObject({
      authorization: "Bearer session-token",
      body: { password: "pw" },
    })
  })

  it("sends magic links and emailed codes, and signs in with the code", async () => {
    const { auth, seen } = setup()
    await auth.sendMagicLink({ email: "a@test.io", callbackURL: "https://app.test/done" })
    await auth.sendOtp({ email: "a@test.io" })
    await expect(auth.signInWithOtp({ email: "a@test.io", otp: "111111" })).rejects.toMatchObject({
      code: "INVALID_OTP",
    })
    expect((await auth.signInWithOtp({ email: "a@test.io", otp: "654321" })).id).toBe("u1")
    expect(seen.map((request) => [request.path, request.body])).toEqual(
      expect.arrayContaining([
        ["/sign-in/magic-link", { email: "a@test.io", callbackURL: "https://app.test/done" }],
        ["/email-otp/send-verification-otp", { email: "a@test.io", type: "sign-in" }],
      ]),
    )
  })

  it("finishes email code sign in with the second factor header bridge", async () => {
    const { auth, seen } = setup(false, "header")
    await expect(auth.signInWithOtp({ email: "a@test.io", otp: "654321" })).rejects.toMatchObject({
      code: "TWO_FACTOR_REQUIRED",
      status: 401,
      twoFactorMethods: ["totp"],
    })
    expect(seen.map(({ path }) => path)).toEqual(["/sign-in/email-otp"])
    expect((await auth.verifyTotp({ code: "123456" })).id).toBe("u1")
    expect(aalOf(await auth.getToken())).toBe("aal2")
    expect(seen.slice(1)).toMatchObject([
      { path: "/two-factor/verify-totp", credentials: "omit", ceremony: CEREMONY },
      { path: "/token", credentials: "omit", ceremony: null },
    ])
  })

  it.each(["totp", "backup code"] as const)(
    "finishes a redirect with %s using the ceremony cookie only on verification",
    async (method) => {
      const page = callbackPage("?keep=1&twoFactorRedirect=true&twoFactorMethods=totp#done")
      try {
        const url = new URL(page.href())
        const { auth, seen } = setup(false, "cookie")
        await expect(auth.completeRedirect()).rejects.toMatchObject({
          code: "TWO_FACTOR_REQUIRED",
          status: 401,
          twoFactorMethods: ["totp"],
        })
        expect(page.href()).toBe(new URL(`${url.pathname}?keep=1#done`, url).href)
        expect(seen).toEqual([])
        const user =
          method === "totp"
            ? await auth.verifyTotp({ code: "123456" })
            : await auth.verifyBackupCode({ code: "backup-1" })
        expect(user.id).toBe("u1")
        expect(seen).toMatchObject([
          {
            path: method === "totp" ? "/two-factor/verify-totp" : "/two-factor/verify-backup-code",
            credentials: "include",
            ceremony: null,
          },
          { path: "/token", credentials: "omit", ceremony: null },
        ])
      } finally {
        page.restore()
      }
    },
  )

  it.runIf(replaceableLocation)(
    "starts an OAuth sign in, navigating when a browser location exists",
    async () => {
      const { auth, seen } = setup()
      expect(
        await auth.signInWithOAuth({ provider: "github", callbackURL: "https://app.test/cb" }),
      ).toBe("https://github.test/login/oauth")
      expect(seen.at(-1)?.body).toEqual({
        provider: "github",
        callbackURL: "https://app.test/cb",
        disableRedirect: true,
      })
      const visited: string[] = []
      const location = {
        assign(this: unknown, url: string) {
          expect(this).toBe(location)
          visited.push(url)
        },
      }
      Object.defineProperty(globalThis, "location", { value: location, configurable: true })
      await auth.signInWithOAuth({ provider: "github", callbackURL: "https://app.test/cb" })
      expect(visited).toEqual(["https://github.test/login/oauth"])
      await expect(
        auth.signInWithOAuth({ provider: "unknown", callbackURL: "https://app.test/cb" }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 500 })
    },
  )

  it("picks up the session after a redirect, and reports none without one", async () => {
    expect(await setup(false).auth.completeRedirect()).toBeUndefined()
    const { auth, seen } = setup(true)
    const user = await auth.completeRedirect()
    expect(user?.id).toBe("u1")
    expect(await auth.getToken()).not.toBeNull()
    expect(seen).toMatchObject([
      { path: "/get-session", credentials: "include", ceremony: null },
      { path: "/token", credentials: "omit", authorization: "Bearer session-token" },
    ])
  })
})
