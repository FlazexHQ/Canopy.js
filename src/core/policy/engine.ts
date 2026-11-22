import { CanopyError, canonicalString, ErrorCode, isDocument } from "../protocol/index.ts"
import { contextNames } from "./context.ts"
import { type FieldAccess, fieldAccess } from "./fields.ts"
import {
  type CollectionPolicies,
  type ContextDefinitions,
  type FieldRules,
  type Operation,
  type PolicyDefinition,
  type RequestContext,
  Role,
  STORAGE_COLLECTION,
} from "./model.ts"
import { hashCollection, hashPolicySet } from "./stored.ts"
import { validateCollectionPolicies, validateContexts } from "./validate.ts"
import { resolveClause, type VariableIssue } from "./variables.ts"

/** The filter that matches no document. Cheap for the planner. */
export const DENY_FILTER: Readonly<Record<string, unknown>> = Object.freeze({
  _id: Object.freeze({ $in: [] }),
})

/** The result of compiling a clause set for one request. */
export type Compiled =
  | { readonly kind: "all" }
  | { readonly kind: "deny" }
  | { readonly kind: "filter"; readonly filter: Record<string, unknown> }

const ALL: Compiled = { kind: "all" }
const DENY: Compiled = { kind: "deny" }

/** Converts a compiled result into a MongoDB filter. */
export function toFilter(compiled: Compiled): Record<string, unknown> {
  switch (compiled.kind) {
    case "all":
      return {}
    case "deny":
      return { _id: { $in: [] } }
    case "filter":
      return compiled.filter
  }
}

/** A validated, immutable set of policies with its bundle hash. */
export interface PolicySet {
  readonly collections: ReadonlyMap<string, CollectionPolicies>
  readonly contexts: ContextDefinitions
  /** Per collection hashes of the canonical bodies. */
  readonly hashes: ReadonlyMap<string, string>
  /** The bundle version: a hash over every collection hash and the context lookups. */
  readonly version: string
}

/** Validates policy definitions and builds a {@link PolicySet}. */
export function createPolicySet(
  definitions: readonly CollectionPolicies[],
  contexts: ContextDefinitions = {},
): PolicySet {
  validateContexts(contexts)
  const collections = new Map<string, CollectionPolicies>()
  const hashes = new Map<string, string>()
  for (const definition of definitions) {
    if (collections.has(definition.collection)) {
      throw new CanopyError(
        ErrorCode.InvalidQuery,
        `Policies for '${definition.collection}' are defined twice`,
      )
    }
    validateCollectionPolicies(definition, contexts)
    collections.set(definition.collection, definition)
    hashes.set(definition.collection, hashCollection(definition))
  }
  return { collections, contexts, hashes, version: hashPolicySet(hashes, contexts) }
}

/** Hooks for observability. They must not throw. */
export interface EngineHooks {
  /** Called when a variable makes its policy non matching. */
  readonly onVariableIssue?: (
    issue: VariableIssue & { readonly collection: string; readonly policy: string },
  ) => void
  /** Called when evaluation fails and the result is forced to DENY. */
  readonly onEvaluationError?: (error: unknown, collection: string, op: Operation) => void
}

interface Applicable {
  readonly permissive: readonly PolicyDefinition[]
  readonly restrictive: readonly PolicyDefinition[]
}

/** One line of an {@link Explanation}. */
export interface ExplainedPolicy {
  readonly name: string
  readonly kind: PolicyDefinition["kind"]
  readonly applies: boolean
  readonly reason: string
  /** The resolved clause, when the policy applies. */
  readonly resolved?: Record<string, unknown>
  /** The variable that made the policy drop out, when one did. */
  readonly issue?: VariableIssue
}

/** A human readable account of how a decision was reached, used by Studio and `canopy policies test`. */
export interface Explanation {
  readonly collection: string
  readonly op: Operation
  readonly clause: "using" | "check"
  readonly roles: readonly string[]
  readonly bypass: boolean
  readonly exposed: boolean
  readonly policies: readonly ExplainedPolicy[]
  readonly result: Compiled
}

function isEmptyFilter(filter: Record<string, unknown>): boolean {
  return Object.keys(filter).length === 0
}

/**
 * Drops filters equal to an earlier one. Equal filters have the same keys in the same order, so only filters
 * whose key lists collide are compared by their canonical text.
 */
function dedupe(filters: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  if (filters.length < 2) return [...filters]
  const shapes = filters.map((filter) => Object.keys(filter).join("\u0000"))
  const repeated = new Set(shapes.filter((shape, index) => shapes.indexOf(shape) !== index))
  if (repeated.size === 0) return [...filters]
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const [index, filter] of filters.entries()) {
    if (!repeated.has(shapes[index] ?? "")) {
      out.push(filter)
      continue
    }
    const key = canonicalString(filter)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(filter)
  }
  return out
}

function flattenAnd(filters: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const filter of filters) {
    const keys = Object.keys(filter)
    if (keys.length === 1 && keys[0] === "$and" && Array.isArray(filter["$and"])) {
      out.push(...flattenAnd(filter["$and"] as Record<string, unknown>[]))
    } else if (!isEmptyFilter(filter)) {
      out.push(filter)
    }
  }
  return out
}

/** Combines filters with AND, dropping empty ones and flattening nested `$and`. */
export function and(...parts: readonly Compiled[]): Compiled {
  if (parts.some((part) => part.kind === "deny")) return DENY
  const filters = dedupe(
    flattenAnd(parts.filter((part) => part.kind === "filter").map((part) => toFilter(part))),
  )
  if (filters.length === 0) return ALL
  if (filters.length === 1) return { kind: "filter", filter: filters[0] as Record<string, unknown> }
  return { kind: "filter", filter: { $and: filters } }
}

function combine(
  permissive: readonly Record<string, unknown>[],
  restrictive: readonly Record<string, unknown>[],
): Compiled {
  if (permissive.length === 0) return DENY
  const anyOf: Compiled = permissive.some(isEmptyFilter)
    ? ALL
    : (() => {
        const unique = dedupe(permissive)
        return unique.length === 1
          ? { kind: "filter", filter: unique[0] as Record<string, unknown> }
          : { kind: "filter", filter: { $or: unique } }
      })()
  return and(anyOf, ...restrictive.map((filter): Compiled => ({ kind: "filter", filter })))
}

/**
 * Evaluates DLS for every entry point. Compilation is cached per `(collection, op, role set)`;
 * each request only substitutes variables. Any error yields DENY.
 */
export class PolicyEngine {
  readonly set: PolicySet
  private readonly hooks: EngineHooks
  private readonly cache = new Map<string, Applicable>()
  private readonly contextCache = new Map<string, string[]>()

  constructor(set: PolicySet, hooks: EngineHooks = {}) {
    this.set = set
    this.hooks = hooks
  }

  /** The bundle version of the loaded policies. */
  get version(): string {
    return this.set.version
  }

  /** Returns the policies of a collection, if any are defined. */
  collection(name: string): CollectionPolicies | undefined {
    return this.set.collections.get(name)
  }

  /** Whether non service callers may reach the collection at all. */
  isExposed(name: string): boolean {
    return name !== STORAGE_COLLECTION && this.set.collections.get(name)?.exposed === true
  }

  /** Whether the collection may be subscribed to. */
  isRealtime(name: string): boolean {
    const def = this.set.collections.get(name)
    return name !== STORAGE_COLLECTION && def?.exposed === true && def.realtime
  }

  private applicable(
    def: CollectionPolicies,
    op: Operation,
    roles: ReadonlySet<string>,
  ): Applicable {
    const key = `${def.collection}\u0000${op}\u0000${[...roles].sort().join(",")}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const policies = def.policies.filter(
      (policy) =>
        policy.ops.includes(op) &&
        (policy.roles.includes(Role.Public) || policy.roles.some((role) => roles.has(role))),
    )
    const result: Applicable = {
      permissive: policies.filter((policy) => policy.kind === "permissive"),
      restrictive: policies.filter((policy) => policy.kind === "restrictive"),
    }
    this.cache.set(key, result)
    return result
  }

  /** Whether any permissive policy grants `op` to the request's roles. Without one, writes are `403`. */
  hasGrant(collection: string, op: Operation, ctx: RequestContext): boolean {
    if (ctx.roles.has(Role.Service)) return true
    const def = this.set.collections.get(collection)
    if (def === undefined || !def.exposed) return false
    return this.applicable(def, op, ctx.roles).permissive.length > 0
  }

  /** `USING(op)` for one request: which existing documents the operation may touch. */
  using(collection: string, op: Operation, ctx: RequestContext): Compiled {
    return this.evaluate(collection, op, ctx, "using")
  }

  /** `CHECK(op)` for one request: what resulting documents must satisfy. */
  check(collection: string, op: "insert" | "update", ctx: RequestContext): Compiled {
    return this.evaluate(collection, op, ctx, "check")
  }

  /**
   * The target of an update or delete: `USING(op) AND USING(read)`, because a caller cannot modify what it
   * cannot see.
   */
  target(collection: string, op: "update" | "delete", ctx: RequestContext): Compiled {
    return and(this.using(collection, op, ctx), this.using(collection, "read", ctx))
  }

  /** The effective read filter: the caller's filter AND `USING(read)`. */
  effectiveRead(
    collection: string,
    userFilter: Record<string, unknown>,
    ctx: RequestContext,
  ): Compiled {
    return and({ kind: "filter", filter: userFilter }, this.using(collection, "read", ctx))
  }

  /** The fields the request may read. */
  readable(collection: string, ctx: RequestContext): FieldAccess {
    if (ctx.roles.has(Role.Service)) return { kind: "all" }
    return fieldAccess(this.set.collections.get(collection)?.fields?.read, ctx.roles)
  }

  /** The fields the request may write. `update` rules override `write` rules for updates. */
  writable(collection: string, op: "insert" | "update", ctx: RequestContext): FieldAccess {
    if (ctx.roles.has(Role.Service)) return { kind: "all" }
    const fields = this.set.collections.get(collection)?.fields
    const rules: FieldRules | undefined =
      op === "update" ? (fields?.update ?? fields?.write) : fields?.write
    return fieldAccess(rules, ctx.roles)
  }

  /**
   * The context lookups the policies of `collections` may use for a request with these roles, or of every
   * collection when `collections` is omitted (aggregations and batches). Empty for `service`.
   */
  contextNames(collections: Iterable<string> | undefined, roles: ReadonlySet<string>): string[] {
    if (roles.has(Role.Service) || Object.keys(this.set.contexts).length === 0) return []
    const names = collections === undefined ? [...this.set.collections.keys()] : [...collections]
    const key = `${[...roles].sort().join(",")}\u0000${names.sort().join(",")}`
    const cached = this.contextCache.get(key)
    if (cached !== undefined) return cached
    const out = new Set<string>()
    for (const name of names) {
      for (const policy of this.set.collections.get(name)?.policies ?? []) {
        if (!policy.roles.includes(Role.Public) && !policy.roles.some((role) => roles.has(role)))
          continue
        for (const ctx of contextNames([policy.using, policy.check])) out.add(ctx)
      }
    }
    const result = [...out].sort()
    if (this.contextCache.size >= 1024) this.contextCache.clear()
    this.contextCache.set(key, result)
    return result
  }

  /** The immutable paths of a collection, which only `service` may change after insert. */
  immutable(collection: string): readonly string[] {
    return this.set.collections.get(collection)?.immutable ?? []
  }

  private evaluate(
    collection: string,
    op: Operation,
    ctx: RequestContext,
    clause: "using" | "check",
  ): Compiled {
    if (ctx.roles.has(Role.Service)) return ALL
    try {
      const def = this.set.collections.get(collection)
      if (def === undefined || !def.exposed) return DENY
      const applicable = this.applicable(def, op, ctx.roles)
      const permissive: Record<string, unknown>[] = []
      for (const policy of applicable.permissive) {
        const resolved = this.resolve(def, policy, clause, ctx)
        if (resolved !== undefined) permissive.push(resolved)
      }
      if (permissive.length === 0) return DENY
      const restrictive: Record<string, unknown>[] = []
      for (const policy of applicable.restrictive) {
        const resolved = this.resolve(def, policy, clause, ctx)
        if (resolved === undefined) return DENY
        restrictive.push(resolved)
      }
      return combine(permissive, restrictive)
    } catch (error: unknown) {
      this.hooks.onEvaluationError?.(error, collection, op)
      return DENY
    }
  }

  private resolve(
    def: CollectionPolicies,
    policy: PolicyDefinition,
    clause: "using" | "check",
    ctx: RequestContext,
  ): Record<string, unknown> | undefined {
    const template =
      clause === "check" ? (policy.check ?? policy.using ?? {}) : (policy.using ?? {})
    if (!isDocument(template)) return undefined
    const resolved = resolveClause(template, ctx)
    if (!resolved.ok) {
      this.hooks.onVariableIssue?.({
        ...resolved.issue,
        collection: def.collection,
        policy: policy.name,
      })
      return undefined
    }
    return resolved.filter
  }

  /** Explains how `USING(op)` or `CHECK(op)` is reached for a request. */
  explain(
    collection: string,
    op: Operation,
    ctx: RequestContext,
    clause: "using" | "check" = "using",
  ): Explanation {
    const roles = [...ctx.roles].sort()
    const def = this.set.collections.get(collection)
    const bypass = ctx.roles.has(Role.Service)
    const result = this.evaluate(collection, op, ctx, clause)
    const policies: ExplainedPolicy[] = []
    if (def !== undefined && !bypass) {
      for (const policy of def.policies) {
        const forOp = policy.ops.includes(op)
        const forRole =
          policy.roles.includes(Role.Public) || policy.roles.some((role) => ctx.roles.has(role))
        if (!forOp || !forRole) {
          policies.push({
            name: policy.name,
            kind: policy.kind,
            applies: false,
            reason: forOp ? `not granted to roles ${roles.join(", ")}` : `does not cover ${op}`,
          })
          continue
        }
        const template =
          clause === "check" ? (policy.check ?? policy.using ?? {}) : (policy.using ?? {})
        const resolved = resolveClause(template, ctx)
        policies.push(
          resolved.ok
            ? {
                name: policy.name,
                kind: policy.kind,
                applies: true,
                reason: "applies",
                resolved: resolved.filter,
              }
            : {
                name: policy.name,
                kind: policy.kind,
                applies: false,
                issue: resolved.issue,
                reason: `variable ${resolved.issue.variable} is ${resolved.issue.kind === "missing" ? "missing or null" : `invalid (${resolved.issue.kind})`}`,
              },
        )
      }
    }
    return {
      collection,
      op,
      clause,
      roles,
      bypass,
      exposed: def?.exposed === true,
      policies,
      result,
    }
  }
}
