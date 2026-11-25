import { builtin, defineConfig, email, env, external } from "canopy.js/config"
import {
  AuthoringError,
  collectionSchemaDocument,
  configDocument,
  type PolicyInput,
  policySetDocument,
  policyTestDocument,
} from "canopy.js/emit"
import {
  as,
  describePolicies,
  type PolicySuite,
  type PolicyTestCase,
  takeRegisteredSuites,
} from "canopy.js/policy/testing"
import { collection, defineSchema, t } from "canopy.js/schema"
import { afterEach, describe, expect, it } from "vitest"
import { evaluateExpression, evaluateModule, vectors } from "./support.ts"

interface PolicyVectors {
  readonly sets: readonly { name: string; source: string; document: unknown }[]
  readonly suites: readonly { name: string; policy: string; source: string; documents: unknown[] }[]
  readonly filterTests: readonly { name: string; source: string; document: unknown }[]
  readonly invalid: readonly {
    name: string
    kind: "set" | "test"
    source: string
    error: { code: string; path: string }
  }[]
}

interface ConfigVector {
  readonly name: string
  readonly source: string
  readonly context?: { mode: "development" | "production"; command: string }
  readonly bindings?: Record<string, unknown>
  readonly document?: unknown
  readonly emissionError?: { code: string; path: string; message: string }
}

interface SchemaVectors {
  readonly authored: readonly { name: string; source: string; document: unknown }[]
  readonly invalid: readonly {
    name: string
    source: string
    path: string
    error: { code: string; message: string }
  }[]
  readonly pull: { source: string; document: unknown; editableDocument: unknown }
  readonly typegen: { document: { collections: unknown[] } }
}

const policy = vectors<PolicyVectors>("policy/vectors.json")
const publishing = vectors<{ name: string; bundleHash: string }[]>("policy/publishing.json")
const config = vectors<ConfigVector[]>("config/vectors.json")
const schema = vectors<SchemaVectors>("schema/vectors.json")

function refusal(run: () => unknown): AuthoringError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof AuthoringError) return error
    throw error
  }
  throw new Error("Expected an authoring refusal")
}

afterEach(() => {
  takeRegisteredSuites()
})

describe("policy authoring vectors", () => {
  it.each(policy.sets.map((set) => [set.name, set] as const))("%s", (name, set) => {
    const { document, version } = policySetDocument(evaluateModule<PolicyInput>(set.source))
    expect(document).toEqual(set.document)
    expect(JSON.stringify(document)).toBe(JSON.stringify(set.document))
    expect(version).toBe(publishing.find((entry) => entry.name === name)?.bundleHash)
  })

  it.each(policy.suites.map((suite) => [suite.name, suite] as const))("suite %s", (_, suite) => {
    const exported = evaluateModule<PolicySuite>(suite.source)
    const documents = exported.cases.map(policyTestDocument)
    expect(documents).toEqual(suite.documents)
    expect(JSON.stringify(documents)).toBe(JSON.stringify(suite.documents))
  })

  it("encodes a filter case given as data", () => {
    for (const vector of policy.filterTests)
      expect(policyTestDocument(evaluateModule<PolicyTestCase>(vector.source))).toEqual(
        vector.document,
      )
  })

  it("builds the same filter case with where() in describePolicies", () => {
    const [vector] = policy.filterTests
    const suite = describePolicies(
      "notes",
      ({ expect: expectThat, where }) => {
        expectThat(as.anon()).can.read(where({ public: true, priority: { $gte: 2 } }))
      },
      "notes filters",
    )
    expect(suite.cases.map(policyTestDocument)).toEqual([vector?.document])
  })

  it("refuses a filter case for an insert, which needs a document", () => {
    const [vector] = policy.filterTests
    const document = vector?.document as Record<string, unknown>
    const testCase = evaluateModule<PolicyTestCase>(
      policy.filterTests[0]?.source.replace('action: "read"', 'action: "insert"') ?? "",
    )
    expect(document["action"]).toBe("read")
    const error = refusal(() => policyTestDocument(testCase))
    expect(error.code).toBe("CANOPY_INVALID_QUERY")
    expect(error.path).toBe("/doc")
  })

  it.each(policy.invalid.map((vector) => [vector.name, vector] as const))(
    "refuses %s with the recorded code and path",
    (_, vector) => {
      const error = refusal(() =>
        vector.kind === "set"
          ? policySetDocument(evaluateModule<PolicyInput>(vector.source))
          : policyTestDocument(evaluateModule<PolicyTestCase>(vector.source)),
      )
      expect({ code: error.code, path: error.path }).toEqual(vector.error)
      expect(error.part).toBe(vector.kind === "set" ? "policies" : "tests")
    },
  )
})

describe("config authoring vectors", () => {
  const mongo = "mongodb://127.0.0.1:27017/authoring?replicaSet=rs0"
  it.each(config.map((vector) => [vector.name, vector] as const))("%s", (_, vector) => {
    const bindings = { defineConfig, env, builtin, email, external, mongo, ...vector.bindings }
    const context = vector.context ?? { mode: "development", command: "start" }
    const exported = evaluateExpression(vector.source, bindings)
    const input = typeof exported === "function" ? exported(context) : exported
    if (vector.emissionError !== undefined) {
      const error = refusal(() => configDocument(input))
      expect({ code: error.code, path: error.path, message: error.message }).toEqual(
        vector.emissionError,
      )
      expect(error.part).toBe("config")
      return
    }
    expect(configDocument(input)).toEqual(vector.document)
    expect(JSON.stringify(configDocument(input))).toBe(JSON.stringify(vector.document))
  })

  it("covers every recorded config, two of them refusals", () => {
    expect(config.length).toBe(51)
    expect(config.filter((vector) => vector.emissionError !== undefined).length).toBe(2)
  })

  it("refuses a config the Rust schema rejects, at its path", () => {
    const error = refusal(() => configDocument({ server: { port: "eighty" } }))
    expect(error.code).toBe("CANOPY_CONFIG_INVALID")
    expect(error.path.startsWith("/config/server/port")).toBe(true)
  })
})

describe("collection schema authoring vectors", () => {
  const builders = { collection, defineSchema, t }

  it.each(schema.authored.map((vector) => [vector.name, vector] as const))("%s", (_, vector) => {
    expect(collectionSchemaDocument(evaluateExpression(vector.source, builders))).toEqual(
      vector.document,
    )
  })

  it.each(schema.invalid.map((vector) => [vector.name, vector] as const))(
    "refuses %s with the recorded code, path and message",
    (_, vector) => {
      const error = refusal(() =>
        collectionSchemaDocument(evaluateExpression(vector.source, builders)),
      )
      expect({ code: error.code, message: error.reason }).toEqual(vector.error)
      expect(error.path).toBe(vector.path)
      expect(error.part).toBe("schema")
    },
  )

  it("evaluates the pulled schema file back to its editable document", () => {
    const body = `${schema.pull.source
      .replace(/^import .*\n/gm, "")
      .replaceAll("export const ", "const ")}\nreturn schema`
    const evaluated: unknown = new Function(...Object.keys(builders), body)(
      ...Object.values(builders),
    )
    expect(collectionSchemaDocument(evaluated)).toEqual(schema.pull.editableDocument)
  })
})
