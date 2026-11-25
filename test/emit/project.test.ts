import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Bundle, EXIT, emitProject, runEmit } from "canopy.js/emit"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { validateBundle } from "../../src/core/wasm/authoring/canopy_authoring.js"
import { vectors } from "./support.ts"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const NOTES = fileURLToPath(new URL("./fixtures/notes/", import.meta.url))
const GENERATED = join(ROOT, ".canopy", "emit-tests")
const CANOPY = join(ROOT, "..", "Canopy")
const CANARY = "emit-canary-value-that-must-never-reach-a-bundle"

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function run(argv: readonly string[]): Promise<Run> {
  let stdout = ""
  let stderr = ""
  const code = await runEmit(argv, {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

function lastLine(text: string): unknown {
  const lines = text.trimEnd().split("\n")
  return JSON.parse(lines[lines.length - 1] ?? "")
}

let generated = 0
function project(files: Readonly<Record<string, string>>): string {
  const dir = join(GENERATED, `project-${process.pid}-${++generated}`)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

beforeEach(() => {
  process.env["CANOPY_EMIT_CANARY"] = CANARY
})

afterAll(() => {
  delete process.env["CANOPY_EMIT_CANARY"]
  rmSync(GENERATED, { recursive: true, force: true })
})

describe("emitting a project", () => {
  it("prints the bundle on stdout and never a resolved secret", async () => {
    const result = await run(["--root", NOTES, "--command", "dev"])
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout.endsWith("\n")).toBe(true)
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1)
    expect(result.stdout).not.toContain(CANARY)
    expect(result.stderr).toContain("evaluating the config for development dev")
    const bundle = lastLine(result.stdout) as Bundle
    expect(bundle.context).toEqual({ mode: "development", command: "dev" })
    expect(bundle.files).toEqual({
      config: "canopy.config.ts",
      policies: "policies",
      tests: ["policies/notes.test.ts"],
      schema: "canopy.schema.ts",
    })
    const config = bundle.config?.config as Record<string, unknown>
    expect(config["masterKey"]).toEqual({
      $env: { name: "CANOPY_EMIT_CANARY", type: "string", secret: true, optional: false },
    })
    expect(config["log"]).toEqual({ level: "debug" })
    expect(validateBundle(result.stdout.trimEnd())).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("follows the policy folder rules: sorted files, stored JSON, context lookups", async () => {
    const bundle = await emitProject({ root: NOTES })
    expect(bundle.policies?.collections.map((entry) => entry["collection"])).toEqual([
      "archive",
      "notes",
    ])
    expect(bundle.policies?.collections[0]).toEqual({
      collection: "archive",
      exposed: false,
      realtime: false,
      policies: [
        {
          name: "owners read",
          kind: "permissive",
          ops: ["read"],
          roles: ["authenticated"],
          using: { owner: { $auth: "sub" } },
        },
      ],
    })
    expect(bundle.policies?.contexts).toEqual({
      projectIds: {
        from: "memberships",
        where: { member: { $auth: "sub" } },
        select: "project",
        max: 50,
        ttl: "30s",
      },
    })
  })

  it("emits test cases in declaration order, with the filter form", async () => {
    const bundle = await emitProject({ root: NOTES })
    expect(
      bundle.tests.map((test) => [test["action"], test["expected"], "filter" in test]),
    ).toEqual([
      ["read", true, false],
      ["insert", false, false],
      ["read", true, true],
      ["delete", false, true],
    ])
    expect(bundle.tests[2]).toEqual({
      version: 1,
      suite: "notes",
      collection: "notes",
      actor: {
        label: "alice",
        roles: ["authenticated"],
        claims: { sub: "alice" },
        ctx: { projectIds: ["p1"] },
      },
      action: "read",
      filter: { project: "p1" },
      expected: true,
    })
  })

  it("emits the schema ordered by name", async () => {
    const bundle = await emitProject({ root: NOTES })
    expect(bundle.schema?.collections.map((entry) => (entry as { name: string }).name)).toEqual([
      "archive",
      "notes",
    ])
  })

  it("calls the config function once with the mode and command", async () => {
    const bundle = await emitProject({ root: NOTES, mode: "production", command: "gen" })
    const config = bundle.config?.config as Record<string, unknown>
    expect(config["environment"]).toBe("production")
    expect(config["log"]).toEqual({ level: "info" })
  })

  it("finds the policy folder through a non secret env() reference", async () => {
    const empty = project({ "policies/.keep": "" })
    const bundle = await emitProject({
      root: NOTES,
      env: { NOTES_POLICIES: join(empty, "policies") },
    })
    expect(bundle.policies).toEqual({ version: 1, collections: [], contexts: {} })
  })

  it("emits a project without config, policies or schema", async () => {
    const result = await run(["--root", project({ "README.md": "" })])
    expect(result.code).toBe(EXIT.ok)
    expect(lastLine(result.stdout)).toMatchObject({
      config: null,
      policies: null,
      tests: [],
      schema: null,
    })
  })
})

describe("refusals", () => {
  it("names the code, part, path and file of an invalid policy", async () => {
    const dir = project({
      "canopy.config.ts": 'export default { policies: { dir: "./policies" } }\n',
      "policies/a.ts":
        'import { allow, collection } from "canopy.js/policy"\nexport default collection("a", { policies: [allow.read("anon")] })\n',
      "policies/b.ts":
        'import { allow, collection } from "canopy.js/policy"\nexport default collection("b", { policies: [allow.read("service")] })\n',
    })
    const result = await run(["--root", dir])
    expect(result.code).toBe(EXIT.invalid)
    expect(result.stdout).toBe("")
    expect(lastLine(result.stderr)).toEqual({
      error: {
        code: "CANOPY_INVALID_QUERY",
        message: expect.stringMatching(/^\/collections\/1\/policies\/0\/roles\/0: /),
        part: "policies",
        path: "/collections/1/policies/0/roles/0",
        file: "policies/b.ts",
      },
    })
  })

  it("refuses a function in the config", async () => {
    const dir = project({
      "canopy.config.ts":
        'import { defineConfig } from "canopy.js/config"\nexport default defineConfig({ webhooks: { schedules: { "a/b~c": { body: { values: [() => 1] } } } } })\n',
    })
    const result = await run(["--root", dir])
    expect(result.code).toBe(EXIT.invalid)
    expect(lastLine(result.stderr)).toMatchObject({
      error: {
        code: "CANOPY_CONFIG_INVALID",
        part: "config",
        path: "/config/webhooks/schedules/a~1b~0c/body/values/0",
        file: "canopy.config.ts",
      },
    })
  })

  it("refuses a custom assertion in a test file", async () => {
    const dir = project({
      "policies/notes.test.ts":
        'import { as, describePolicies } from "canopy.js/policy/testing"\nconst suite = describePolicies("notes", ({ expect }) => { expect(as.anon()).can.read({ public: true }) })\nexport default { ...suite.cases[0], assert: "custom" }\n',
    })
    const result = await run(["--root", dir, "--policies", "policies"])
    expect(result.code).toBe(EXIT.invalid)
    expect(lastLine(result.stderr)).toMatchObject({
      error: {
        code: "CANOPY_INVALID_QUERY",
        part: "tests",
        path: "/assert",
        file: "policies/notes.test.ts",
      },
    })
  })

  it("refuses a duplicate collection in the schema", async () => {
    const dir = project({
      "canopy.schema.ts":
        'import { collection, defineSchema } from "canopy.js/schema"\nexport const schema = defineSchema(collection("notes", {}), collection("notes", {}))\n',
    })
    const result = await run(["--root", dir])
    expect(result.code).toBe(EXIT.invalid)
    expect(lastLine(result.stderr)).toMatchObject({
      error: { code: "CANOPY_SCHEMA_INVALID", part: "schema", path: "/collections/1/name" },
    })
  })

  it("reports a project module that throws with an empty path", async () => {
    const dir = project({ "canopy.config.ts": 'throw new Error("broken config")\n' })
    const result = await run(["--root", dir])
    expect(result.code).toBe(EXIT.invalid)
    expect(lastLine(result.stderr)).toMatchObject({
      error: { code: "CANOPY_CONFIG_INVALID", part: "config", path: "", file: "canopy.config.ts" },
    })
  })

  it.each([[["--mode", "staging"]], [["--command", "push"]], [["--root"]], [["--unknown", "x"]]])(
    "exits 2 on the usage error %j",
    async (argv) => {
      const result = await run(argv)
      expect(result.code).toBe(EXIT.usage)
      expect(lastLine(result.stderr)).toMatchObject({ error: { code: "CANOPY_INTERNAL" } })
    },
  )
})

describe("fixture projects", () => {
  const sets = vectors<{ sets: { name: string; document: unknown }[] }>("policy/vectors.json").sets
  const configs = vectors<{ name: string; document?: unknown }[]>("config/vectors.json")

  it("emits the Canopy.js template as the scaffold writes it", async () => {
    const dir = join(GENERATED, "template")
    mkdirSync(join(dir, "policies"), { recursive: true })
    copyFileSync(join(ROOT, "templates", "cli", "config.txt"), join(dir, "canopy.config.ts"))
    copyFileSync(join(ROOT, "templates", "cli", "policy.txt"), join(dir, "policies", "notes.ts"))
    const bundle = await emitProject({ root: dir, env: {} })
    expect(bundle.config?.config).toEqual({
      mongodb: {
        uri: {
          $env: {
            name: "MONGODB_URI",
            type: "string",
            secret: false,
            optional: false,
            default: "mongodb://localhost:27017/?directConnection=true",
          },
        },
        database: {
          $env: {
            name: "CANOPY_DB",
            type: "string",
            secret: false,
            optional: false,
            default: "app",
          },
        },
      },
      policies: {
        dir: {
          $env: {
            name: "CANOPY_POLICIES",
            type: "string",
            secret: false,
            optional: false,
            default: "./policies",
          },
        },
      },
    })
    expect(bundle.policies?.collections.map((entry) => entry["policies"])).toEqual([
      [
        {
          name: "permissive read #1",
          kind: "permissive",
          ops: ["read"],
          roles: ["authenticated"],
          using: { ownerId: { $auth: "sub" } },
        },
        {
          name: "permissive insert #2",
          kind: "permissive",
          ops: ["insert"],
          roles: ["authenticated"],
          check: { ownerId: { $auth: "sub" } },
        },
        {
          name: "permissive update #3",
          kind: "permissive",
          ops: ["update"],
          roles: ["authenticated"],
          using: { ownerId: { $auth: "sub" } },
          check: { ownerId: { $auth: "sub" } },
        },
        {
          name: "permissive delete #4",
          kind: "permissive",
          ops: ["delete"],
          roles: ["authenticated"],
          using: { ownerId: { $auth: "sub" } },
        },
      ],
    ])
  })

  it.runIf(existsSync(join(CANOPY, "deploy", "dev", "canopy.config.ts")))(
    "emits Canopy's deploy/dev as its authoring vectors",
    async () => {
      const bundle = await emitProject({ root: join(CANOPY, "deploy", "dev") })
      expect(bundle.config).toEqual(
        configs.find((vector) => vector.name === "deploy/dev/canopy.config.ts")?.document,
      )
      expect(bundle.policies).toEqual(
        sets.find((set) => set.name === "deploy/dev/policies/notes.ts")?.document,
      )
      expect(bundle.files).toEqual({
        config: "canopy.config.ts",
        policies: "policies",
        tests: [],
        schema: null,
      })
    },
  )
})
