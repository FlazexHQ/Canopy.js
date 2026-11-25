import { isEnvMarker } from "../config/env.ts"
import { canonicalString, isDocument, toCanonical } from "../core/protocol/index.ts"
import type { CollectionPolicies, ContextDefinitions } from "../policy/model.ts"
import type { PolicyTestCase } from "../policy/testing.ts"
import { declaredCollections } from "../schema/declared.ts"
import { isFieldBuilder } from "../schema/fields.ts"
import type { AnyCollectionDefinition } from "../schema/index.ts"
import { toCollectionSchema } from "../schema/to-shape.ts"
import { checkCollectionSchema, checkConfig, checkPolicySet, checkPolicyTest } from "./authoring.ts"
import { AuthoringError, type BundlePart, PART_CODES, pointer } from "./errors.ts"

/** The policies of a project before encoding: collection definitions and context lookups. */
export interface PolicyInput {
  readonly collections: readonly CollectionPolicies[]
  readonly contexts: ContextDefinitions
}

/** A version 1 policy set document. */
export interface PolicySetDocument {
  readonly version: 1
  readonly collections: readonly Record<string, unknown>[]
  readonly contexts: Readonly<Record<string, Record<string, unknown>>>
}

/** A version 1 policy test case document. */
export type PolicyTestDocument = Readonly<Record<string, unknown>> & { readonly version: 1 }

/** A version 1 unresolved config document. */
export interface ConfigDocument {
  readonly version: 1
  readonly config: unknown
}

/** A version 1 collection schema document. */
export interface CollectionSchemaDocument {
  readonly version: 1
  readonly collections: readonly unknown[]
}

function refuse(part: BundlePart, path: string, reason: string): AuthoringError {
  return new AuthoringError(PART_CODES[part], part, path, reason)
}

/** Refuses values that cannot be data: functions, symbols, accessors, cycles and class instances. */
function checkData(part: BundlePart, value: unknown, path = "", active = new Set<object>()): void {
  if (typeof value === "function" || typeof value === "symbol")
    throw refuse(part, path, "Expected data")
  if (!Array.isArray(value) && !isDocument(value)) return
  if (active.has(value)) throw refuse(part, path, "Cyclic data")
  if (!Array.isArray(value)) {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype)
      throw refuse(part, path, "Expected a plain document or a BSON value")
  }
  active.add(value)
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string") throw refuse(part, path, "Symbol keys are unsupported")
    const child = pointer(path, field)
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      throw refuse(part, child, "Accessors are unsupported")
    if (descriptor.enumerable) checkData(part, descriptor.value, child, active)
  }
  active.delete(value)
}

function ejson(part: BundlePart, value: unknown, path: string): unknown {
  try {
    return JSON.parse(canonicalString(value))
  } catch (error: unknown) {
    throw refuse(part, path, error instanceof Error ? error.message : "Expected a BSON value")
  }
}

/** Encodes and validates the policy set of a project. */
export function policySetDocument(input: PolicyInput): {
  readonly document: PolicySetDocument
  readonly version: string
} {
  checkData("policies", input)
  const document: PolicySetDocument = {
    version: 1,
    collections: input.collections.map((definition, index) => ({
      ...definition,
      policies: definition.policies.map(({ using, check, ...item }, position) => {
        const at = `/collections/${index}/policies/${position}`
        return {
          ...item,
          ...(using === undefined ? {} : { using: ejson("policies", using, `${at}/using`) }),
          ...(check === undefined ? {} : { check: ejson("policies", check, `${at}/check`) }),
        }
      }),
    })),
    contexts: Object.fromEntries(
      Object.entries(input.contexts).map(([name, lookup]) => [
        name,
        {
          ...lookup,
          where: ejson("policies", lookup.where, pointer(pointer("/contexts", name), "where")),
        },
      ]),
    ),
  }
  return { document, version: checkPolicySet(document) }
}

/** Encodes and validates one policy test case. */
export function policyTestDocument(input: PolicyTestCase): PolicyTestDocument {
  checkData("tests", input)
  const { actor, doc, filter, update, ...fields } = input
  const document = {
    version: 1 as const,
    ...fields,
    actor: {
      ...actor,
      claims: ejson("tests", actor.claims, "/actor/claims"),
      ...(actor.ctx === undefined ? {} : { ctx: ejson("tests", actor.ctx, "/actor/ctx") }),
    },
    ...(doc === undefined ? {} : { doc: ejson("tests", doc, "/doc") }),
    ...(filter === undefined ? {} : { filter: ejson("tests", filter, "/filter") }),
    ...(update === undefined ? {} : { update: ejson("tests", update, "/update") }),
  }
  checkPolicyTest(document)
  return document
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Config settings whose values are BSON, carried in a `$ejson` envelope. */
function bsonSetting(path: string): boolean {
  return (
    path === "/config/auth/jwks" ||
    /^\/config\/webhooks\/(?:triggers\/[^/]+\/filter|schedules\/[^/]+\/body)$/.test(path)
  )
}

function configValue(value: unknown, path: string, ancestors: Set<object>, raw: boolean): unknown {
  if (typeof value === "function")
    throw refuse(
      "config",
      path,
      path === "/config/auth/claims"
        ? "Use an HTTPS claims hook with a secret reference"
        : "Functions cannot be emitted",
    )
  if (typeof value === "symbol") throw refuse("config", path, "Symbols cannot be emitted")
  if (isEnvMarker(value)) {
    if (raw) throw refuse("config", path, "Environment references belong at config settings")
    const { name, kind, secret, optional, fallback } = value
    return {
      $env: {
        name,
        type: kind,
        secret,
        optional,
        ...(fallback === undefined
          ? {}
          : {
              default: configValue(
                fallback,
                pointer(pointer(path, "$env"), "default"),
                ancestors,
                false,
              ),
            }),
      },
    }
  }
  if (typeof value === "object" && value !== null) {
    if (ancestors.has(value)) throw refuse("config", path, "Cycles cannot be emitted")
    ancestors.add(value)
    try {
      if (Array.isArray(value))
        return Array.from(value, (item: unknown, index) => {
          const child = pointer(path, String(index))
          if (item === undefined && !raw)
            throw refuse("config", child, "Array elements must have values")
          return configValue(item, child, ancestors, raw)
        })
      if (plain(value)) {
        if (!raw && (Object.hasOwn(value, "$env") || Object.hasOwn(value, "$ejson")))
          throw refuse("config", path, "Reserved authoring key")
        const fields = Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .map(([key, item]) => {
              const child = pointer(path, key)
              const envelope = !raw && bsonSetting(child)
              const converted = configValue(item, child, ancestors, raw || envelope)
              return [key, envelope ? { $ejson: converted } : converted]
            }),
        )
        return raw && Object.keys(fields).some((key) => key.startsWith("$"))
          ? { $literal: fields }
          : fields
      }
      if (!raw) throw refuse("config", path, "Expected a plain config object")
    } finally {
      ancestors.delete(value)
    }
  }
  if (raw) {
    try {
      return toCanonical(value)
    } catch (error: unknown) {
      throw refuse("config", path, error instanceof Error ? error.message : "Expected a BSON value")
    }
  }
  if (typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value)))
    throw refuse("config", path, "Expected a JSON value")
  return value
}

/**
 * Encodes and validates a config as `defineConfig` returned it (after a config function was called):
 * `env()` references stay symbolic, so no environment value reaches the document.
 */
export function configDocument(input: unknown): ConfigDocument {
  const document: ConfigDocument = {
    version: 1,
    config: configValue(input, "/config", new Set(), false),
  }
  checkConfig(document)
  return document
}

function checkFieldBuilders(fields: unknown, path: string): void {
  if (!plain(fields)) return
  for (const [name, field] of Object.entries(fields)) {
    const at = pointer(pointer(path, "fields"), name)
    if (!isFieldBuilder(field))
      throw refuse("schema", at, `Field ${JSON.stringify(name)} is not a field builder from t`)
    if (field.fill !== undefined && typeof field.fill !== "function")
      throw refuse("schema", at, "generate() takes a function that returns a new value")
    if (field.fields !== undefined) checkFieldBuilders(field.fields, pointer(at, "shape"))
  }
}

function byName(a: AnyCollectionDefinition, b: AnyCollectionDefinition): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Encodes and validates a schema: a `defineSchema(...)` result, or a single `collection(...)` definition.
 * Collections are ordered by name, as type generation and `canopy pull` order them.
 */
export function collectionSchemaDocument(schema: unknown): CollectionSchemaDocument {
  if (typeof schema !== "object" || schema === null)
    throw refuse("schema", "", "Expected a defineSchema(...) result")
  const single = "shape" in schema && "name" in schema && "fields" in schema
  const definitions = single
    ? [schema as AnyCollectionDefinition]
    : (declaredCollections(schema) ?? (Object.values(schema) as AnyCollectionDefinition[]))
  const sorted = [...definitions].sort(byName)
  sorted.forEach((definition, index) => {
    checkFieldBuilders(definition.fields, `/collections/${index}/shape`)
  })
  const document: CollectionSchemaDocument = {
    version: 1,
    collections: sorted.map((definition) =>
      JSON.parse(JSON.stringify(toCollectionSchema(definition))),
    ),
  }
  checkCollectionSchema(document)
  return document
}
