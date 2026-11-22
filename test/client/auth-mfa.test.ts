import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../../src/client/auth.ts"
import { memoryPersister } from "../../src/client/persist.ts"

const b64url = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => b64url([...new TextEncoder().encode(JSON.stringify(value))])
  return `${part({ alg: "none" })}.${part({ iat: 1, exp: 4_000_000_000, ...claims })}.sig`
}

interface Seen {
  readonly path: string
  readonly method: string
  readonly headers: Headers
  readonly body: unknown
}

/** A fake auth server: password sign in needs TOTP 123456, and passkeys answer with fixed options. */
function server(seen: Seen[]): typeof fetch {
  let aal = "aal1"
  return async (input, init = {}) => {
    const url = new URL(String(input))
    const path = url.pathname.replace("/auth/v1", "")
    const headers = new Headers(init.headers)
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    seen.push({ path, method: init.method ?? "GET", headers, body })
    const session = { "set-auth-token": "session-token" }
    switch (path) {
      case "/sign-in/email":
        return Response.json(
          { twoFactorRedirect: true, twoFactorMethods: ["totp"] },
          { headers: { "set-auth-ceremony": "canopy.two_factor=signed" } },
        )
      case "/two-factor/verify-totp":
        if (
          headers.get("x-canopy-ceremony") !== "canopy.two_factor=signed" ||
          body?.["code"] !== "123456"
        )
          return Response.json({ code: "INVALID_CODE", message: "Invalid code" }, { status: 401 })
        aal = "aal2"
        return Response.json({ token: "session-token" }, { headers: session })
      case "/token":
        if (headers.get("authorization") !== "Bearer session-token")
          return Response.json({ message: "No session" }, { status: 401 })
        return Response.json({ access_token: jwt({ sub: "u1", aal }), token_type: "bearer" })
      case "/passkey/generate-register-options":
        return Response.json({
          challenge: b64url([1, 2, 3]),
          rp: { id: "app.test", name: "App" },
          user: { id: b64url([9, 9]), name: "u1", displayName: "u1" },
          excludeCredentials: [{ id: b64url([7]), type: "public-key" }],
        })
      case "/passkey/generate-authenticate-options":
        return Response.json(
          { challenge: b64url([4, 5]), allowCredentials: [] },
          { headers: { "set-auth-ceremony": "canopy.better-auth-passkey=pk" } },
        )
      case "/passkey/verify-registration":
        return Response.json({ id: "pk1" })
      case "/passkey/verify-authentication":
        aal = "aal2"
        return Response.json({ session: {} }, { headers: session })
      default:
        return Response.json({ message: "Not found" }, { status: 404 })
    }
  }
}

const navigatorOf = globalThis as { navigator?: unknown }
const original = navigatorOf.navigator
afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: original, configurable: true })
})

describe("second factors and passkeys in the client", () => {
  it("asks for the code, then completes the sign in with the ceremony cookie", async () => {
    const seen: Seen[] = []
    const auth = createAuth({
      url: "https://api.test",
      storage: memoryPersister(),
      fetch: server(seen),
    })
    await expect(
      auth.signInWithPassword({ email: "a@test.io", password: "pw" }),
    ).rejects.toMatchObject({ code: "TWO_FACTOR_REQUIRED" })
    await expect(auth.verifyTotp({ code: "000000" })).rejects.toMatchObject({
      code: "INVALID_CODE",
    })
    const user = await auth.verifyTotp({ code: "123456" })
    expect(user.id).toBe("u1")
    const token = await auth.getToken()
    expect(JSON.parse(atob((token ?? "").split(".")[1] ?? ""))["aal"]).toBe("aal2")
    const verify = seen.filter((request) => request.path === "/two-factor/verify-totp")
    expect(verify.map((request) => request.headers.get("x-canopy-ceremony"))).toEqual([
      "canopy.two_factor=signed",
      "canopy.two_factor=signed",
    ])
    expect(seen.at(-1)?.headers.get("x-canopy-ceremony")).toBeNull()
  })

  it("converts WebAuthn options and credentials between JSON and buffers", async () => {
    const seen: Seen[] = []
    const created: unknown[] = []
    const credential = (kind: "create" | "get") => ({
      id: "cred",
      rawId: new Uint8Array([1, 255]).buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      response:
        kind === "create"
          ? {
              clientDataJSON: new Uint8Array([123]).buffer,
              attestationObject: new Uint8Array([0, 1]).buffer,
              getTransports: () => ["internal"],
            }
          : {
              clientDataJSON: new Uint8Array([123]).buffer,
              authenticatorData: new Uint8Array([2]).buffer,
              signature: new Uint8Array([3]).buffer,
              userHandle: new Uint8Array([9, 9]).buffer,
            },
      getClientExtensionResults: () => ({}),
    })
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        credentials: {
          create: async (options: { publicKey: Record<string, unknown> }) => {
            created.push(options.publicKey)
            return credential("create")
          },
          get: async () => credential("get"),
        },
      },
    })
    const auth = createAuth({
      url: "https://api.test",
      storage: memoryPersister(),
      fetch: server(seen),
    })
    await auth.addPasskey({ name: "Laptop" })
    const options = created[0] as {
      challenge: ArrayBuffer
      user: { id: ArrayBuffer }
      excludeCredentials: { id: ArrayBuffer }[]
    }
    expect([...new Uint8Array(options.challenge)]).toEqual([1, 2, 3])
    expect([...new Uint8Array(options.user.id)]).toEqual([9, 9])
    expect([...new Uint8Array(options.excludeCredentials[0]?.id ?? new ArrayBuffer(0))]).toEqual([
      7,
    ])
    expect(seen.find((request) => request.path === "/passkey/verify-registration")?.body).toEqual({
      name: "Laptop",
      response: {
        id: "cred",
        rawId: "Af8",
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: { clientDataJSON: "ew", attestationObject: "AAE", transports: ["internal"] },
      },
    })
    const user = await auth.signInWithPasskey()
    expect(user.id).toBe("u1")
    const verify = seen.find((request) => request.path === "/passkey/verify-authentication")
    if (verify === undefined) throw new Error("no verify request")
    expect(verify.headers.get("x-canopy-ceremony")).toBe("canopy.better-auth-passkey=pk")
    expect(
      (verify.body as { response: { response: Record<string, string> } }).response.response,
    ).toEqual({
      clientDataJSON: "ew",
      authenticatorData: "Ag",
      signature: "Aw",
      userHandle: "CQk",
    })
  })
})
