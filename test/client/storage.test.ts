import { describe, expect, it } from "vitest"

import { createStorage } from "../../src/client/index.ts"

interface Call {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Uint8Array | string | undefined
}

/** A storage server in memory: one resumable upload with a 4 byte part size. */
function fakeServer(script: { failPart?: number[] } = {}) {
  const calls: Call[] = []
  const parts = new Map<number, Uint8Array>()
  let size = 0
  const fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = String(input)
    const method = init.method ?? "GET"
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const raw = init.body
    const body =
      raw === undefined || raw === null
        ? undefined
        : typeof raw === "string"
          ? raw
          : new Uint8Array(await new Response(raw).arrayBuffer())
    calls.push({ method, url, headers, body })
    const path = new URL(url).pathname.replace("/storage/v1/", "")
    const state = () => ({
      id: "up1",
      size,
      partSize: 4,
      partCount: Math.ceil(size / 4),
      parts: [...parts.keys()].sort((a, b) => a - b),
    })
    if (method === "POST" && path.startsWith("upload/")) {
      size = (JSON.parse(String(body)) as { size: number }).size
      return Response.json(state(), { status: 201 })
    }
    if (method === "GET" && path === "uploads/up1") return Response.json(state())
    const part = /^uploads\/up1\/(\d+)$/.exec(path)
    if (method === "PUT" && part !== null) {
      const n = Number(part[1])
      if (script.failPart?.[0] === n) {
        script.failPart.shift()
        return Response.json({ code: "CANOPY_UNAVAILABLE", detail: "busy" }, { status: 503 })
      }
      parts.set(n, body as Uint8Array)
      return Response.json(state())
    }
    if (method === "POST" && path === "uploads/up1/complete") {
      const joined = [...parts.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes)
      return Response.json(
        { path: "big.bin", size: joined.reduce((n, b) => n + b.length, 0) },
        { status: 201 },
      )
    }
    if (method === "POST" && path.startsWith("sign/"))
      return Response.json({ url: "/storage/v1/signed/docs/a%20b.pdf?token=t" })
    if (method === "GET" && path.startsWith("object/"))
      return Response.json({ code: "CANOPY_NOT_FOUND", detail: "No such file" }, { status: 404 })
    return Response.json({ code: "CANOPY_INTERNAL", detail: "unexpected" }, { status: 500 })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls, parts }
}

describe("storage client", () => {
  const options = (fetch: typeof globalThis.fetch) => ({
    url: "https://api.example.com/",
    publishableKey: "pk",
    auth: { getToken: async () => "tok" },
    fetch,
  })

  it("uploads in parts with the caller's credentials, retrying a busy part, and reports progress", async () => {
    const server = fakeServer({ failPart: [2] })
    const progress: [number, number][] = []
    const started: string[] = []
    const result = await createStorage(options(server.fetch))
      .from("docs")
      .uploadResumable("big.bin", new TextEncoder().encode("0123456789"), {
        onProgress: (sent, total) => progress.push([sent, total]),
        onStart: (id) => started.push(id),
      })
    expect(result).toEqual({ path: "big.bin", size: 10 })
    expect(started).toEqual(["up1"])
    expect(progress).toEqual([
      [0, 10],
      [4, 10],
      [8, 10],
      [10, 10],
    ])
    expect(new TextDecoder().decode(server.parts.get(3))).toBe("89")
    const puts = server.calls.filter((c) => c.method === "PUT").map((c) => c.url.split("/").at(-1))
    expect(puts).toEqual(["1", "2", "2", "3"])
    const create = server.calls[0]
    expect(create?.url).toBe("https://api.example.com/storage/v1/upload/docs/big.bin")
    expect(create?.headers["authorization"]).toBe("Bearer tok")
    expect(create?.headers["apikey"]).toBe("pk")
    expect(JSON.parse(String(create?.body))).toEqual({
      size: 10,
      contentType: "application/octet-stream",
      upsert: false,
    })
  })

  it("resumes an upload, sending only the parts the server lacks", async () => {
    const server = fakeServer({ failPart: [2, 2, 2] })
    const bucket = createStorage(options(server.fetch)).from("docs")
    const data = new TextEncoder().encode("0123456789")
    let id = ""
    await expect(
      bucket.uploadResumable("big.bin", data, { onStart: (value) => (id = value), retries: 3 }),
    ).rejects.toMatchObject({ code: "CANOPY_UNAVAILABLE" })
    expect([...server.parts.keys()]).toEqual([1])
    const progress: number[] = []
    await bucket.uploadResumable("big.bin", data, {
      resume: id,
      onProgress: (sent) => progress.push(sent),
    })
    expect(progress).toEqual([4, 8, 10])
    const resumedPuts = server.calls
      .slice(server.calls.findIndex((c) => c.method === "GET"))
      .filter((c) => c.method === "PUT")
      .map((c) => c.url.split("/").at(-1))
    expect(resumedPuts).toEqual(["2", "3"])
    await expect(
      bucket.uploadResumable("big.bin", new Uint8Array(3), { resume: id }),
    ).rejects.toMatchObject({ code: "CANOPY_INVALID_QUERY" })
  })

  it("turns problem documents into Canopy errors and builds absolute URLs", async () => {
    const server = fakeServer()
    const bucket = createStorage(options(server.fetch)).from("docs")
    await expect(bucket.download("missing.txt")).rejects.toMatchObject({
      code: "CANOPY_NOT_FOUND",
      message: "No such file",
    })
    expect(await bucket.createSignedUrl("a b.pdf", 60)).toBe(
      "https://api.example.com/storage/v1/signed/docs/a%20b.pdf?token=t",
    )
    expect(bucket.publicUrl("dir/a b.png")).toBe(
      "https://api.example.com/storage/v1/public/docs/dir/a%20b.png",
    )
    expect(bucket.publicUrl("a.png", { download: "logo.png" })).toBe(
      "https://api.example.com/storage/v1/public/docs/a.png?download=logo.png",
    )
    expect(bucket.publicUrl("a.png", { download: true })).toBe(
      "https://api.example.com/storage/v1/public/docs/a.png?download",
    )
  })

  it("asks for transformed images on the render routes with the parameters in a fixed order", async () => {
    const server = fakeServer()
    const bucket = createStorage(options(server.fetch)).from("docs")
    expect(
      bucket.publicUrl("dir/a b.png", {
        transform: { format: "webp", width: 200, resize: "contain", quality: 70, height: 100 },
      }),
    ).toBe(
      "https://api.example.com/storage/v1/render/image/public/docs/dir/a%20b.png?width=200&height=100&resize=contain&quality=70&format=webp",
    )
    expect(bucket.publicUrl("a.png", { transform: { width: 20 }, download: true })).toBe(
      "https://api.example.com/storage/v1/render/image/public/docs/a.png?width=20&download",
    )
    expect(bucket.publicUrl("a.png", { transform: {} })).toBe(
      "https://api.example.com/storage/v1/render/image/public/docs/a.png",
    )
    expect(await bucket.createSignedUrl("a b.png", 60, { transform: { height: 50 } })).toBe(
      "https://api.example.com/storage/v1/render/image/signed/docs/a%20b.png?height=50&token=t",
    )
    await expect(
      bucket.download("missing.png", { transform: { width: 10, format: "png" } }),
    ).rejects.toThrow()
    const asked = server.calls.at(-1)
    expect(asked?.method).toBe("GET")
    expect(asked?.url).toBe(
      "https://api.example.com/storage/v1/render/image/object/docs/missing.png?width=10&format=png",
    )
  })
})
