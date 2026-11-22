import { canonicalString, isDocument, parse, sha256Hex } from "../protocol/index.ts"
import {
  type CollectionFields,
  type CollectionPolicies,
  type ContextDefinitions,
  type ContextLookup,
  type FieldRule,
  type FieldRules,
  OPERATIONS,
  type Operation,
  type PolicyDefinition,
  type PolicyKind,
} from "./model.ts"

/** One policy as stored in `canopy.policies`. Clauses are canonical EJSON strings. */
export interface StoredPolicy {
  readonly name: string
  readonly kind: PolicyKind
  readonly ops: readonly Operation[]
  readonly roles: readonly string[]
  readonly using?: string
  readonly check?: string
}

/** The stored document of one collection, `_id` being the collection name. */
export interface StoredCollectionPolicies {
  readonly _id: string
  readonly version: number
  readonly exposed: boolean
  readonly realtime: boolean
  readonly policies: readonly StoredPolicy[]
  readonly fields?: CollectionFields
  readonly immutable?: readonly string[]
  readonly hash: string
  readonly updatedAt?: Date
  readonly updatedBy?: string
}

/** The `_id` of the stored context lookup declarations. */
export const CONTEXT_DOCUMENT_ID = "_context"

function storedPolicies(def: CollectionPolicies): StoredPolicy[] {
  return def.policies.map((policy) => ({
    name: policy.name,
    kind: policy.kind,
    ops: [...policy.ops],
    roles: [...policy.roles],
    ...(policy.using === undefined ? {} : { using: canonicalString(policy.using) }),
    ...(policy.check === undefined ? {} : { check: canonicalString(policy.check) }),
  }))
}

function body(def: CollectionPolicies): Record<string, unknown> {
  return {
    _id: def.collection,
    exposed: def.exposed,
    realtime: def.realtime,
    policies: storedPolicies(def),
    fields: def.fields ?? null,
    immutable: def.immutable ?? [],
  }
}

/** The SHA-256 of the canonical policy body of a collection, used as its version hash. */
export function hashCollection(def: CollectionPolicies): string {
  return `sha256:${sha256Hex(canonicalString(body(def)))}`
}

/** The bundle version over all collections and context lookups. */
export function hashPolicySet(
  hashes: ReadonlyMap<string, string>,
  contexts: ContextDefinitions,
): string {
  const entries = [...hashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `sha256:${sha256Hex(canonicalString({ collections: entries, contexts }))}`
}

/** Converts authoring form to the stored form. */
export function toStored(
  def: CollectionPolicies,
  meta: { readonly version: number; readonly updatedAt?: Date; readonly updatedBy?: string },
): StoredCollectionPolicies {
  return {
    _id: def.collection,
    version: meta.version,
    exposed: def.exposed,
    realtime: def.realtime,
    policies: storedPolicies(def),
    ...(def.fields === undefined ? {} : { fields: def.fields }),
    ...(def.immutable === undefined ? {} : { immutable: def.immutable }),
    hash: hashCollection(def),
    ...(meta.updatedAt === undefined ? {} : { updatedAt: meta.updatedAt }),
    ...(meta.updatedBy === undefined ? {} : { updatedBy: meta.updatedBy }),
  }
}

function clause(
  text: string | undefined,
  name: string,
  kind: string,
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  const value = parse(text)
  if (!isDocument(value))
    throw new TypeError(`Policy '${name}' has a ${kind} clause that is not a document`)
  return value
}

function isPolicyKind(value: unknown): value is PolicyKind {
  return value === "permissive" || value === "restrictive"
}

function isOperation(value: unknown): value is Operation {
  return OPERATIONS.some((op) => op === value)
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array of strings`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string") throw new TypeError(`${what} must be an array of strings`)
    out.push(item)
  }
  return out
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`)
  return value
}

function storedPolicy(raw: unknown, collection: string): StoredPolicy {
  if (!isDocument(raw)) throw new TypeError(`A stored policy of '${collection}' must be a document`)
  const name = raw["name"]
  if (typeof name !== "string")
    throw new TypeError(`A stored policy of '${collection}' needs a string name`)
  const kind = raw["kind"]
  if (!isPolicyKind(kind)) throw new TypeError(`Policy '${name}' has an unknown kind`)
  const ops: Operation[] = []
  for (const op of strings(raw["ops"] ?? [], `The operations of policy '${name}'`)) {
    if (!isOperation(op)) throw new TypeError(`Policy '${name}' has the unknown operation '${op}'`)
    ops.push(op)
  }
  const using = optionalString(raw["using"], `The using clause of policy '${name}'`)
  const check = optionalString(raw["check"], `The check clause of policy '${name}'`)
  return {
    name,
    kind,
    ops,
    roles: strings(raw["roles"] ?? [], `The roles of policy '${name}'`),
    ...(using === undefined ? {} : { using }),
    ...(check === undefined ? {} : { check }),
  }
}

function fieldRule(value: unknown, where: string): FieldRule {
  if (!isDocument(value)) throw new TypeError(`${where} must be a document`)
  const only = value["only"]
  const omit = value["omit"]
  if ((only === undefined) === (omit === undefined))
    throw new TypeError(`${where} needs exactly one of only or omit`)
  return only === undefined
    ? { omit: strings(omit, `${where}.omit`) }
    : { only: strings(only, `${where}.only`) }
}

function fieldsFromStored(value: unknown, collection: string): CollectionFields | undefined {
  if (value === undefined || value === null) return undefined
  if (!isDocument(value))
    throw new TypeError(`The field rules of '${collection}' must be a document`)
  const fields: { read?: FieldRules; write?: FieldRules; update?: FieldRules } = {}
  for (const [kind, rules] of Object.entries(value)) {
    if (kind !== "read" && kind !== "write" && kind !== "update")
      throw new TypeError(`The field rules of '${collection}' have the unknown kind '${kind}'`)
    if (rules === undefined) continue
    if (!isDocument(rules))
      throw new TypeError(`fields.${kind} of '${collection}' must be a document`)
    const byRole: Record<string, FieldRule> = {}
    for (const [role, rule] of Object.entries(rules))
      byRole[role] = fieldRule(rule, `fields.${kind}.${role} of '${collection}'`)
    fields[kind] = byRole
  }
  return fields
}

interface StoredParts {
  readonly collection: string
  readonly exposed: boolean
  readonly realtime: boolean
  readonly policies: readonly StoredPolicy[]
  readonly fields: CollectionFields | undefined
  readonly immutable: readonly string[] | undefined
}

function storedParts(stored: Record<string, unknown>, collection: string): StoredParts {
  const policies = stored["policies"]
  if (!Array.isArray(policies)) throw new TypeError(`Policies for '${collection}' must be an array`)
  const immutable = stored["immutable"]
  return {
    collection,
    exposed: stored["exposed"] === true,
    realtime: stored["realtime"] === true,
    policies: policies.map((raw) => storedPolicy(raw, collection)),
    fields: fieldsFromStored(stored["fields"], collection),
    immutable:
      immutable === undefined || immutable === null
        ? undefined
        : strings(immutable, `The immutable fields of '${collection}'`),
  }
}

function storedDocument(stored: unknown): {
  readonly doc: Record<string, unknown>
  readonly collection: string
} {
  if (!isDocument(stored)) throw new TypeError("A stored policy document must be a document")
  const collection = stored["_id"]
  if (typeof collection !== "string")
    throw new TypeError("A stored policy document needs a string _id")
  return { doc: stored, collection }
}

/**
 * Converts a stored document back to authoring form. Its structure is checked here (a `TypeError` on a
 * malformed document); the result still has to pass validation (through `createPolicySet`) before it is
 * used, so a tampered document is rejected rather than trusted.
 */
export function fromStored(stored: unknown): CollectionPolicies {
  const { doc, collection } = storedDocument(stored)
  const parts = storedParts(doc, collection)
  return {
    collection,
    exposed: parts.exposed,
    realtime: parts.realtime,
    policies: parts.policies.map((policy): PolicyDefinition => {
      const using = clause(policy.using, policy.name, "using")
      const check = clause(policy.check, policy.name, "check")
      return {
        name: policy.name,
        kind: policy.kind,
        ops: policy.ops,
        roles: policy.roles,
        ...(using === undefined ? {} : { using }),
        ...(check === undefined ? {} : { check }),
      }
    }),
    ...(parts.fields === undefined ? {} : { fields: parts.fields }),
    ...(parts.immutable === undefined ? {} : { immutable: parts.immutable }),
  }
}

/**
 * Checks the structure of a document read from `canopy.policies` and returns it in its stored form,
 * version and hash included. Throws a `TypeError` on a malformed document. The policies themselves are
 * validated when they are compiled.
 */
export function readStored(stored: unknown): StoredCollectionPolicies {
  const { doc, collection } = storedDocument(stored)
  const parts = storedParts(doc, collection)
  const version = doc["version"]
  const hash = doc["hash"]
  const updatedAt = doc["updatedAt"]
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
    throw new TypeError(`The stored policies of '${collection}' need a version`)
  if (typeof hash !== "string")
    throw new TypeError(`The stored policies of '${collection}' need a hash`)
  if (updatedAt !== undefined && updatedAt !== null && !(updatedAt instanceof Date))
    throw new TypeError(`updatedAt of '${collection}' must be a date`)
  const updatedBy = optionalString(doc["updatedBy"], `updatedBy of '${collection}'`)
  return {
    _id: collection,
    version,
    exposed: parts.exposed,
    realtime: parts.realtime,
    policies: parts.policies,
    ...(parts.fields === undefined ? {} : { fields: parts.fields }),
    ...(parts.immutable === undefined ? {} : { immutable: parts.immutable }),
    hash,
    ...(updatedAt instanceof Date ? { updatedAt } : {}),
    ...(updatedBy === undefined ? {} : { updatedBy }),
  }
}

function contextLookup(value: unknown, name: string): ContextLookup {
  if (!isDocument(value)) throw new TypeError(`The context lookup '${name}' must be a document`)
  const { from, where, select, max, ttl } = value
  if (typeof from !== "string")
    throw new TypeError(`The context lookup '${name}' needs a string from`)
  if (!isDocument(where)) throw new TypeError(`The context lookup '${name}' needs a where document`)
  if (typeof select !== "string")
    throw new TypeError(`The context lookup '${name}' needs a string select`)
  if (typeof max !== "number")
    throw new TypeError(`The context lookup '${name}' needs a number max`)
  if (typeof ttl !== "string")
    throw new TypeError(`The context lookup '${name}' needs a string ttl`)
  return { from, where, select, max, ttl }
}

/**
 * Checks the structure of context lookup declarations read from storage (the `lookups` field of the
 * `_context` document). Missing declarations are an empty set; anything else that is not a document of
 * lookups throws a `TypeError`. The lookups are validated when they are compiled.
 */
export function contextsFromStored(lookups: unknown): ContextDefinitions {
  if (lookups === undefined || lookups === null) return {}
  if (!isDocument(lookups)) throw new TypeError("The context lookups must be a document")
  const out: Record<string, ContextLookup> = {}
  for (const [name, lookup] of Object.entries(lookups)) out[name] = contextLookup(lookup, name)
  return out
}
