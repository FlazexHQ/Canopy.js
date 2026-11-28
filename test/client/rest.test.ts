import { describe, expect, expectTypeOf, it, vi } from "vitest"

import {
  type CanopyError,
  type DocumentSchema,
  isCanopyError,
  NotFoundError,
  ObjectId,
  ValidationError,
} from "../../src/client/index.ts"
import { createRestClient, type RestClient, type RestPage } from "../../src/client/rest/index.ts"
import { freshGraph } from "../support/fresh.ts"

interface Todo {
  _id: ObjectId
  title: string
  done: boolean
  at: Date
}

type Db = DocumentSchema<{ todos: Todo; notes: { _id: string; body: string } }>

interface Sent {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly signal: AbortSignal | undefined
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function fakeFetch(...responses: (Response | ((sent: Sent) => Response | Promise<Response>))[]) {
  const sent: Sent[] = []
  const impl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const call: Sent = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        signal: init?.signal ?? undefined,
      }
      sent.push(call)
      const next = responses.shift()
      if (next === undefined) throw new Error("no response queued")
      return typeof next === "function" ? next(call) : next
    },
  )
  return { fetch: impl as unknown as typeof fetch, sent, impl }
}

const ID = "6728f0c2a1b2c3d4e5f60718"
const page1 = {
  data: [{ _id: { $oid: ID }, title: "a", done: false, at: { $date: { $numberLong: "0" } } }],
  page: { limit: 1, next: "cursor-1" },
  ct: "7300000000000000001",
}

function client(
  fetch: typeof globalThis.fetch,
  token?: () => string | undefined,
  timeoutMs?: number,
) {
  return createRestClient<Db>({
    url: "http://canopy.test/",
    publishableKey: "pk_test",
    fetch,
    ...(token === undefined ? {} : { token }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

describe("REST queries", () => {
  it("build without I/O and read a page with the caller's token, decoding EJSON", async () => {
    const { fetch, sent, impl } = fakeFetch(json(page1))
    let token = "t1"
    const query = client(fetch, () => token)
      .from("todos")
      .find({ done: false })
      .sort({ _id: 1 })
      .fields({ title: 1 })
      .limit(1)
    expect(impl).not.toHaveBeenCalled()
    token = "t2"
    const first = await query.page()
    expect(sent).toEqual([
      {
        url: "http://canopy.test/rest/v1/todos/_query",
        method: "POST",
        headers: {
          apikey: "pk_test",
          accept: "application/ejson",
          authorization: "Bearer t2",
          "content-type": "application/json",
        },
        body: {
          filter: { done: false },
          sort: { _id: { $numberInt: "1" } },
          fields: { title: { $numberInt: "1" } },
          limit: { $numberInt: "1" },
        },
        signal: undefined,
      },
    ])
    expect(first.data[0]?._id).toEqual(new ObjectId(ID))
    expect((first.data[0] as unknown as Todo).at).toEqual(new Date(0))
    expect(first.page).toEqual({ limit: 1, next: "cursor-1" })
    expect(first.ct).toBe("7300000000000000001")
    expectTypeOf(first).toEqualTypeOf<RestPage<{ _id: ObjectId; title: string }>>()
  })

  it("follows the cursor and asks for a total", async () => {
    const last = { data: [], page: { limit: 1, next: null, total: 1 }, ct: "7300000000000000002" }
    const { fetch, sent } = fakeFetch(json(page1), json(last))
    const query = client(fetch).from("todos").limit(1)
    const first = await query.page()
    const next = first.page.next
    if (next === null) throw new Error("expected a cursor")
    const second = await query.page({ after: next, count: "exact" })
    expect(sent[1]?.body).toEqual({
      filter: {},
      limit: { $numberInt: "1" },
      after: "cursor-1",
      count: "exact",
    })
    expect(sent[1]?.headers["authorization"]).toBeUndefined()
    expect(second.page).toEqual({ limit: 1, next: null, total: 1 })
  })

  it("replaces the filter on a second find", async () => {
    const { fetch, sent } = fakeFetch(json({ ...page1, page: { limit: 20, next: null } }))
    await client(fetch).from("todos").find({ done: true }).find({ title: "x" }).page()
    expect(sent[0]?.body).toEqual({ filter: { title: "x" } })
  })

  it("rejects an envelope it does not recognize", async () => {
    const { fetch } = fakeFetch(
      json({ data: [], page: { limit: 1, next: null } }),
      json({ data: [1], page: { limit: 1, next: null }, ct: "1" }),
      json({ data: [], page: { limit: 1, next: 3 }, ct: "1" }),
    )
    const todos = client(fetch).from("todos")
    for (const message of ["ct is not a cluster time", "data is not a list", "page.next"]) {
      const error = await todos.page().catch((reason: unknown) => reason)
      expect(isCanopyError(error, "CANOPY_PROTOCOL_ERROR")).toBe(true)
      expect((error as Error).message).toContain(message)
    }
  })
})

describe("REST reads by id and counts", () => {
  it("encodes every id as canonical EJSON, so a string that looks like an ObjectId stays a string", async () => {
    const doc = (id: unknown) => json({ data: { _id: id, body: "b" }, ct: "1" })
    const { fetch, sent } = fakeFetch(
      json({ data: { _id: { $oid: ID }, title: "a" }, ct: "1" }),
      doc(ID),
      doc({ $numberInt: "0" }),
    )
    const rest = client(fetch)
    const found = await rest
      .from("todos")
      .findById(new ObjectId(ID), { fields: { title: 1, _id: 1 } })
    await rest.from("notes").findById(ID)
    await (rest.from("notes").findById as (id: unknown) => Promise<unknown>)(0)
    expect(sent.map((call) => decodeURIComponent(call.url))).toEqual([
      `http://canopy.test/rest/v1/todos/{"$oid":"${ID}"}?fields=title,_id`,
      `http://canopy.test/rest/v1/notes/"${ID}"`,
      `http://canopy.test/rest/v1/notes/{"$numberInt":"0"}`,
    ])
    expect(found.data).toEqual({ _id: new ObjectId(ID), title: "a" })
    expectTypeOf(found.data).toEqualTypeOf<{ _id: ObjectId; title: string }>()
    const wrongId = () =>
      // @ts-expect-error notes have string ids
      rest.from("notes").findById(new ObjectId(ID))
    void wrongId
  })

  it("keeps the server's typed 404 with its request id and details", async () => {
    const { fetch } = fakeFetch(
      json(
        {
          type: "urn:canopy:error:not-found",
          title: "Not found",
          status: 404,
          code: "CANOPY_NOT_FOUND",
          detail: "Document not found",
          instance: "/rest/v1/todos/x",
          requestId: "req-1",
          hint: "Check the id",
        },
        404,
        { "content-type": "application/problem+json" },
      ),
    )
    const error = await client(fetch)
      .from("todos")
      .findById(new ObjectId(ID))
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toMatchObject({
      code: "CANOPY_NOT_FOUND",
      message: "Document not found",
      hint: "Check the id",
      details: { requestId: "req-1", status: 404 },
    })
  })

  it("counts with the requested mode and reports exactness", async () => {
    const { fetch, sent } = fakeFetch(
      json({ data: { count: 42, exact: false }, ct: "9" }),
      json({ data: { count: 1, exact: true }, ct: "9" }),
    )
    const todos = client(fetch).from("todos")
    const estimated = await todos.count({ done: false }, { mode: "estimated" })
    const exact = await todos.count()
    expect(estimated).toEqual({ data: { count: 42, exact: false }, ct: "9" })
    expect(exact.data).toEqual({ count: 1, exact: true })
    expect(sent.map((call) => [call.url, call.headers["prefer"], call.body])).toEqual([
      ["http://canopy.test/rest/v1/todos/_count", "count=estimated", { filter: { done: false } }],
      ["http://canopy.test/rest/v1/todos/_count", "count=exact", { filter: {} }],
    ])
  })
})

describe("REST failures", () => {
  it("maps a response that is not Problem Details to CANOPY_UNAVAILABLE with the status", async () => {
    const { fetch } = fakeFetch(
      new Response("bad gateway", { status: 502, headers: { "x-request-id": "r2" } }),
    )
    const error = (await client(fetch)
      .from("todos")
      .page()
      .catch((reason: unknown) => reason)) as CanopyError
    expect(isCanopyError(error, "CANOPY_UNAVAILABLE")).toBe(true)
    expect(error.details).toEqual({ status: 502, requestId: "r2" })
  })

  it("reports an unreachable server as CANOPY_UNAVAILABLE", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed")
    })
    const error = await client(fetch)
      .from("todos")
      .page()
      .catch((reason: unknown) => reason)
    expect(isCanopyError(error, "CANOPY_UNAVAILABLE")).toBe(true)
  })

  it("passes the caller's signal to fetch and rejects with its reason when aborted", async () => {
    const controller = new AbortController()
    const { fetch, sent } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason))
        }),
    )
    const pending = client(fetch).from("todos").page({ signal: controller.signal })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const reason = new Error("left the page")
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(sent[0]?.signal?.aborted).toBe(true)
  })

  it("sends nothing when the signal is already aborted", async () => {
    const { fetch, impl } = fakeFetch(json(page1))
    const controller = new AbortController()
    controller.abort(new Error("gone"))
    await expect(
      client(fetch).from("todos").count({}, { signal: controller.signal }),
    ).rejects.toThrow("gone")
    expect(impl).not.toHaveBeenCalled()
  })

  it("times out with CANOPY_TIMEOUT and aborts the request", async () => {
    const { fetch, sent } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason))
        }),
    )
    const error = await client(fetch, undefined, 20)
      .from("todos")
      .page()
      .catch((reason: unknown) => reason)
    expect(isCanopyError(error, "CANOPY_TIMEOUT")).toBe(true)
    expect(sent[0]?.signal?.aborted).toBe(true)
  })
})

describe("the REST entry point", () => {
  it("imports and reads where no WebSocket exists", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
    Reflect.deleteProperty(globalThis, "WebSocket")
    try {
      expect("WebSocket" in globalThis).toBe(false)
      const graph = freshGraph()
      const rest =
        await graph.load<typeof import("../../src/client/rest/index.ts")>("client/rest/index.ts")
      const { fetch } = fakeFetch(json(page1))
      const result = await rest
        .createRestClient({ url: "http://canopy.test", publishableKey: "pk", fetch })
        .from("todos")
        .page()
      expect(result.data).toHaveLength(1)
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, "WebSocket", original)
    }
  })
})

describe("REST distinct and aggregate", () => {
  interface Tagged {
    _id: ObjectId
    tags: string[]
    rank: number | null
  }
  type Tags = DocumentSchema<{ tagged: Tagged }>

  it("reads distinct values of a typed path", async () => {
    const { fetch, sent } = fakeFetch(json({ data: ["a", "b"], ct: "5" }))
    const rest = createRestClient<Tags>({ url: "http://canopy.test", publishableKey: "pk", fetch })
    const tags = await rest.from("tagged").distinct("tags", { rank: { $gt: 1 } })
    expect(tags).toEqual({ data: ["a", "b"], ct: "5" })
    expect(sent[0]).toMatchObject({
      url: "http://canopy.test/rest/v1/tagged/_distinct",
      method: "POST",
      body: { field: "tags", filter: { rank: { $gt: { $numberInt: "1" } } } },
    })
    expectTypeOf(tags.data).toEqualTypeOf<readonly string[]>()
    const ranks = () => rest.from("tagged").distinct("rank")
    expectTypeOf<Awaited<ReturnType<typeof ranks>>["data"]>().toEqualTypeOf<
      readonly (number | null)[]
    >()
    const unknownField = () =>
      // @ts-expect-error not a path of the documents
      rest.from("tagged").distinct("tag")
    void unknownField
  })

  it("returns aggregation output as unknown without a decoder", async () => {
    const { fetch, sent } = fakeFetch(json({ data: [{ _id: "a", n: 2 }], ct: "6" }))
    const rest = createRestClient<Tags>({ url: "http://canopy.test", publishableKey: "pk", fetch })
    const pipeline = [{ $unwind: "$tags" }, { $group: { _id: "$tags", n: { $sum: 1 } } }]
    const result = await rest.from("tagged").aggregate(pipeline)
    expect(result.data).toEqual([{ _id: "a", n: 2 }])
    expectTypeOf(result.data).toEqualTypeOf<readonly unknown[]>()
    expect(sent[0]?.url).toBe("http://canopy.test/rest/v1/tagged/_aggregate")
    expect(sent[0]?.body).toEqual({
      pipeline: [
        { $unwind: "$tags" },
        { $group: { _id: "$tags", n: { $sum: { $numberInt: "1" } } } },
      ],
    })
  })

  it("checks aggregation output with a Standard Schema decoder", async () => {
    const counts = {
      "~standard": {
        validate(value: unknown) {
          if (
            typeof value === "object" &&
            value !== null &&
            "_id" in value &&
            typeof value._id === "string" &&
            "n" in value &&
            typeof value.n === "number" &&
            Number.isInteger(value.n)
          ) {
            return { value: { _id: value._id, n: value.n } }
          }
          return { issues: [{ message: "Expected an integer", path: ["n"] }] }
        },
      },
    }
    const { fetch } = fakeFetch(
      json({ data: [{ _id: "a", n: 2 }], ct: "7" }),
      json({
        data: [
          { _id: "a", n: 2 },
          { _id: "b", n: "two" },
        ],
        ct: "7",
      }),
    )
    const rest = createRestClient<Tags>({ url: "http://canopy.test", publishableKey: "pk", fetch })
    const typed = await rest.from("tagged").aggregate([], { decode: counts })
    expect(typed.data).toEqual([{ _id: "a", n: 2 }])
    expectTypeOf(typed.data).toEqualTypeOf<readonly { _id: string; n: number }[]>()
    const error = await rest
      .from("tagged")
      .aggregate([], { decode: counts })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe(
      "Output document 1 does not match: Expected an integer at n",
    )
  })
})

describe("REST merge patches", () => {
  /** Type checks run by `tsc -b`; never called. */
  function checks(rest: RestClient<Db>): void {
    const todos = rest.from("todos")
    void todos.patch(new ObjectId(), { title: "x" })
    // @ts-expect-error null removes a field, and title is required
    void todos.patch(new ObjectId(), { title: null })
    // @ts-expect-error _id cannot change
    void todos.patch(new ObjectId(), { _id: new ObjectId() })
    // @ts-expect-error notes have string ids
    void rest.from("notes").patch(new ObjectId(), { body: "x" })
    type Patched = Awaited<ReturnType<typeof todos.patch>>["data"]
    expectTypeOf<Patched>().toEqualTypeOf<Todo | null>()
  }
  void checks

  it("sends a merge patch with its precondition and idempotency key, and reads the result", async () => {
    const { fetch, sent } = fakeFetch(
      json({ data: { _id: "n1", body: "new" }, ct: "7300000000000000009", replayed: false }),
    )
    const result = await client(fetch)
      .from("notes")
      .patch("n1", { body: "new" }, { where: { body: "old" }, idempotencyKey: "k-1" })
    expect(result).toEqual({
      data: { _id: "n1", body: "new" },
      ct: "7300000000000000009",
      replayed: false,
    })
    const [call] = sent
    expect(call?.method).toBe("PATCH")
    expect(call?.headers["content-type"]).toBe("application/merge-patch+json")
    expect(call?.headers["idempotency-key"]).toBe("k-1")
    expect(call?.body).toEqual({ body: "new" })
    const url = new URL(call?.url ?? "")
    expect(url.pathname).toBe(`/rest/v1/notes/${encodeURIComponent('"n1"')}`)
    expect(url.searchParams.get("where")).toBe('{"body":"old"}')
  })

  it("rejects a result without a cluster time or a replay flag", async () => {
    const { fetch } = fakeFetch(json({ data: null, ct: "7300000000000000009" }))
    await expect(client(fetch).from("notes").patch("n1", { body: "x" })).rejects.toMatchObject({
      code: "CANOPY_PROTOCOL_ERROR",
    })
  })
})

describe("REST batches", () => {
  const ops = [
    { op: "insert", c: "notes", doc: { _id: "n2", body: "two" } },
    { op: "delete", c: "notes", id: "n9" },
  ] as const

  it("sends an atomic batch with one idempotency key and reads every result", async () => {
    const { fetch, sent } = fakeFetch(
      json({
        data: [
          { data: { _id: "n2", body: "two" }, matched: 0 },
          { data: null, matched: 1 },
        ],
        ct: "7300000000000000010",
        replayed: false,
      }),
    )
    const result = await client(fetch).batch(ops, { atomic: true, idempotencyKey: "batch-one" })
    expect(result).toEqual({
      results: [
        { data: { _id: "n2", body: "two" }, matched: 0 },
        { data: null, matched: 1 },
      ],
      ct: "7300000000000000010",
      replayed: false,
    })
    expect(sent[0]?.url).toBe("http://canopy.test/rest/v1/_batch")
    expect(sent[0]?.headers["idempotency-key"]).toBe("batch-one")
    expect(sent[0]?.body).toEqual({ atomic: true, ops })
  })

  it("gives each operation of a batch that is not atomic its own key and typed outcome", async () => {
    const { fetch, sent } = fakeFetch(
      json({
        data: [
          {
            status: 200,
            data: { _id: "n2", body: "two" },
            ct: "7300000000000000011",
            replayed: true,
          },
          {
            status: 404,
            error: { code: "CANOPY_NOT_FOUND", detail: "Document not found", requestId: "r-7" },
          },
        ],
      }),
    )
    const result = await client(fetch).batch(ops, { atomic: false, idempotencyKey: "batch-two" })
    expect(sent[0]?.headers["idempotency-key"]).toBeUndefined()
    expect(sent[0]?.body).toEqual({
      atomic: false,
      ops: [
        { ...ops[0], mid: "batch-two-0" },
        { ...ops[1], mid: "batch-two-1" },
      ],
    })
    const [first, second] = result.results
    expect(first).toEqual({
      ok: true,
      data: { _id: "n2", body: "two" },
      ct: "7300000000000000011",
      replayed: true,
    })
    expect(second?.ok).toBe(false)
    const error = second?.ok === false ? second.error : undefined
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error?.message).toBe("Document not found")
    expect(error?.details).toMatchObject({ status: 404, requestId: "r-7" })
  })

  it("rejects a result that does not have one entry per operation", async () => {
    const { fetch } = fakeFetch(json({ data: [], ct: "7300000000000000010", replayed: false }))
    await expect(client(fetch).batch(ops, { atomic: true })).rejects.toMatchObject({
      code: "CANOPY_PROTOCOL_ERROR",
    })
  })

  /** Type checks run by `tsc -b`; never called. */
  function checks(rest: RestClient<Db>): void {
    // @ts-expect-error notes have string ids
    void rest.batch([{ op: "delete", c: "notes", id: new ObjectId() }], { atomic: true })
    // @ts-expect-error not a collection of the schema
    void rest.batch([{ op: "delete", c: "todo", id: "x" }], { atomic: false })
    // @ts-expect-error a batch says whether it is atomic
    void rest.batch(ops, {})
    void rest.batch(
      [{ op: "update", c: "todos", id: new ObjectId(), update: { $set: { done: true } } }],
      {
        atomic: true,
      },
    )
  }
  void checks
})
