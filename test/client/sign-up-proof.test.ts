import { describe, expect, it } from "vitest"

import { createAuth } from "../../src/client/auth.ts"
import { memoryPersister } from "../../src/client/persist.ts"
import type { Persister } from "../../src/client/client-types.ts"

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  return `${part({ alg: "none" })}.${part({ iat: 1, exp: 4_000_000_000, ...claims })}.sig`
}

interface Seen {
  readonly path: string
  readonly proof: string | null
}

function server(seen: Seen[]): typeof fetch {
  let signUps = 0
  return async (input, init = {}) => {
    const path = new URL(String(input)).pathname.replace("/auth/v1", "")
    const headers = new Headers(init.headers)
    seen.push({ path, proof: headers.get("x-canopy-sign-up") })
    switch (path) {
      case "/sign-up/email":
        signUps += 1
        return Response.json(
          { token: null, user: null, verification: "sent" },
          { headers: { "set-auth-sign-up": `sign-up-proof-${signUps}` } },
        )
      case "/email-otp/send-verification-otp":
        return new Response(null, { status: 200 })
      case "/email-otp/verify-email":
        return Response.json(
          { status: true, token: "session-token" },
          { headers: { "set-auth-token": "session-token" } },
        )
      case "/token":
        return headers.get("authorization") === "Bearer session-token" ||
          init.credentials === "include"
          ? Response.json({ access_token: jwt({ sub: "u1" }), token_type: "bearer" })
          : Response.json({ code: "UNAUTHORIZED", message: "UNAUTHORIZED" }, { status: 401 })
      default:
        return Response.json({ message: "Not found" }, { status: 404 })
    }
  }
}

function client(storage: Persister, seen: Seen[]) {
  return createAuth({ url: "https://api.test", storage, fetch: server(seen) })
}

const signUp = { email: "a@test.io", password: "correct horse battery" }

describe("sign up proofs", () => {
  it("presents the proofs of its sign ups when it verifies an address with a code", async () => {
    const seen: Seen[] = []
    const auth = client(memoryPersister(), seen)
    expect(await auth.signUp(signUp)).toEqual({ verification: "sent" })
    await auth.signUp({ ...signUp, email: "b@test.io" })
    await auth.sendVerificationOtp({ email: "a@test.io" })
    const user = await auth.verifyEmailWithOtp({ email: "a@test.io", otp: "123456" })
    expect(user.id).toBe("u1")
    expect(seen.map(({ path, proof }) => [path, proof])).toEqual([
      ["/sign-up/email", null],
      ["/sign-up/email", null],
      ["/email-otp/send-verification-otp", null],
      ["/email-otp/verify-email", "sign-up-proof-2, sign-up-proof-1"],
      ["/token", null],
    ])
  })

  it("keeps the proofs across a reload and presents none it never received", async () => {
    const storage = memoryPersister()
    const before: Seen[] = []
    await client(storage, before).signUp(signUp)
    const after: Seen[] = []
    await client(storage, after).verifyEmailWithOtp({ email: "a@test.io", otp: "123456" })
    expect(after[0]).toEqual({ path: "/email-otp/verify-email", proof: "sign-up-proof-1" })

    const fresh: Seen[] = []
    await client(memoryPersister(), fresh).verifyEmailWithOtp({ email: "a@test.io", otp: "123456" })
    expect(fresh[0]).toEqual({ path: "/email-otp/verify-email", proof: null })
  })

  it("keeps the five newest proofs", async () => {
    const seen: Seen[] = []
    const auth = client(memoryPersister(), seen)
    for (let index = 0; index < 7; index += 1)
      await auth.signUp({ ...signUp, email: `${index}@test.io` })
    await auth.verifyEmailWithOtp({ email: "6@test.io", otp: "123456" })
    expect(seen.find(({ path }) => path === "/email-otp/verify-email")?.proof).toBe(
      "sign-up-proof-7, sign-up-proof-6, sign-up-proof-5, sign-up-proof-4, sign-up-proof-3",
    )
  })

  it.each([
    { mode: "bearer", credentials: "omit" },
    { mode: "cookie", credentials: "include" },
  ] as const)("verifies with an in memory proof in $mode mode", async ({ mode, credentials }) => {
    const seen: Seen[] = []
    const requests: RequestInit["credentials"][] = []
    const respond = server(seen)
    const auth = createAuth({
      url: "https://api.test",
      mode,
      fetch: (input, init) => {
        requests.push(init?.credentials)
        return respond(input, init)
      },
    })
    await auth.signUp(signUp)
    const user = await auth.verifyEmailWithOtp({ email: signUp.email, otp: "123456" })
    expect(user.id).toBe("u1")
    expect(seen[1]).toEqual({ path: "/email-otp/verify-email", proof: "sign-up-proof-1" })
    expect(requests).toEqual([credentials, credentials, credentials])
  })

  it("limits restored proofs to five distinct values safe to send as a header", async () => {
    const storage = memoryPersister()
    await storage.set(
      "auth",
      "sign-up",
      JSON.stringify(["", "bad\nproof", "a,b", "p1", "p1", "p2", "p3", "p4", "p5", "p6"]),
    )
    const seen: Seen[] = []
    await client(storage, seen).verifyEmailWithOtp({ email: signUp.email, otp: "123456" })
    expect(seen[0]).toEqual({ path: "/email-otp/verify-email", proof: "p1, p2, p3, p4, p5" })
  })
})
