import { stringify } from "../protocol/index.ts"
import {
  type Compiled,
  type ExplainedPolicy,
  type Explanation,
  type PolicyEngine,
  toFilter,
} from "./engine.ts"
import type { FieldAccess } from "./fields.ts"
import { type Operation, type RequestContext, Role } from "./model.ts"
import type { VariableIssue } from "./variables.ts"

/** What to explain: one operation on one collection for a stated request context. */
export interface ExplainRequest {
  readonly collection: string
  /** Defaults to `read`. */
  readonly op?: Operation
  readonly context: RequestContext
  /** For reads: the caller's filter, combined with `USING(read)` into the effective filter. */
  readonly filter?: Record<string, unknown>
}

/**
 * Why a request may or may not touch documents: every policy with its outcome, the effective filter and the
 * field rules. It describes the policy structure and resolved claim values, so it is for admins only: the
 * CLI, Studio and callers with a secret key, never app users.
 */
export interface AccessReport {
  readonly collection: string
  readonly op: Operation
  readonly roles: readonly string[]
  /** `service` bypasses DLS. */
  readonly bypass: boolean
  readonly exposed: boolean
  /** Whether any permissive policy grants the operation to these roles (a write without one is `403`). */
  readonly granted: boolean
  /** `USING(op)`: which existing documents the operation may touch. */
  readonly using: Explanation
  /** `CHECK(op)` for inserts and updates: what resulting documents must satisfy. */
  readonly check?: Explanation
  /**
   * The filter the operation runs with: for reads the caller's filter AND `USING(read)`, for updates and
   * deletes `USING(op)` AND `USING(read)`, for inserts `CHECK(insert)`.
   */
  readonly effective: Compiled
  readonly readable: FieldAccess
  /** The fields the operation may write, for inserts and updates. */
  readonly writable?: FieldAccess
  readonly immutable: readonly string[]
}

/** Explains how the engine decides one operation for a stated request context. Nothing is cached or logged. */
export function explainAccess(engine: PolicyEngine, request: ExplainRequest): AccessReport {
  const { collection, context } = request
  const op = request.op ?? "read"
  const using = engine.explain(collection, op, context, "using")
  const writes = op === "insert" || op === "update"
  const check = writes ? engine.explain(collection, op, context, "check") : undefined
  const effective =
    op === "read"
      ? engine.effectiveRead(collection, request.filter ?? {}, context)
      : op === "insert"
        ? engine.check(collection, "insert", context)
        : engine.target(collection, op, context)
  return {
    collection,
    op,
    roles: using.roles,
    bypass: using.bypass,
    exposed: using.exposed,
    granted: engine.hasGrant(collection, op, context),
    using,
    ...(check === undefined ? {} : { check }),
    effective,
    readable: engine.readable(collection, context),
    ...(writes ? { writable: engine.writable(collection, op, context) } : {}),
    immutable: engine.immutable(collection),
  }
}

function variableName(variable: string): string {
  if (variable.startsWith("$auth:")) return `claim ${variable.slice(6)}`
  if (variable.startsWith("$ctx:")) return `context lookup ${variable.slice(5)}`
  return "the request time"
}

/** Describes a variable issue in words, without the value that caused it. */
export function describeIssue(issue: VariableIssue): string {
  const name = variableName(issue.variable)
  switch (issue.kind) {
    case "missing":
      return `${name} is missing or null (fails closed)`
    case "shape":
      return `${name} has the wrong shape: a list under $in, $nin or $all, a single value elsewhere (fails closed)`
    case "coercion":
      return `${name} cannot be converted to the requested type (fails closed)`
  }
}

function render(value: unknown): string {
  return stringify(value)
}

function policyLines(explanation: Explanation): string[] {
  const relevant = explanation.policies.filter(
    (policy) => policy.applies || policy.issue !== undefined,
  )
  const skipped = explanation.policies.length - relevant.length
  const width = Math.max(0, ...relevant.map((policy) => policy.name.length + 2))
  const line = (policy: ExplainedPolicy): string => {
    const name = `"${policy.name}"`.padEnd(width)
    const outcome = policy.applies
      ? `matches   ${render(policy.resolved ?? {})}`
      : `no match  ${policy.issue === undefined ? policy.reason : describeIssue(policy.issue)}`
    return `  ${policy.kind.padEnd(11)} ${name}  ${outcome}`
  }
  const lines: string[] = []
  for (const kind of ["permissive", "restrictive"] as const) {
    const ofKind = relevant.filter((policy) => policy.kind === kind)
    if (ofKind.length === 0) lines.push(`  ${kind.padEnd(11)} (none)`)
    else lines.push(...ofKind.map(line))
  }
  if (skipped > 0)
    lines.push(
      `  (${skipped} ${skipped === 1 ? "policy does" : "policies do"} not cover ${explanation.op} for these roles)`,
    )
  return lines
}

function describeFields(label: string, access: FieldAccess): string | undefined {
  if (access.kind === "all") return undefined
  return access.kind === "omit"
    ? `${label} hidden: ${access.paths.join(", ")}`
    : `${label} limited to: ${access.paths.join(", ")}`
}

function verdict(report: AccessReport): string {
  if (report.bypass) return "service bypasses DLS: every document and field"
  if (!report.exposed)
    return `${report.collection} is not exposed: denied for every role but service`
  if (!report.granted) return `no permissive policy grants ${report.op} to these roles: denied`
  return report.effective.kind === "deny" ? "no policy matches: denied" : "allowed"
}

/**
 * Formats an {@link AccessReport} for a terminal:
 *
 * ```text
 * todos, read, roles [authenticated]
 *   permissive  "read own"                matches   {"ownerId":"u_alice"}
 *   permissive  "read shared in my orgs"  no match  claim org_ids is missing or null (fails closed)
 *   restrictive (none)
 * Effective filter: {"$and":[{"status":"active"},{"ownerId":"u_alice"}]}
 * Fields hidden: internalNotes
 * ```
 */
export function formatAccessReport(report: AccessReport): string {
  const lines = [`${report.collection}, ${report.op}, roles [${report.roles.join(", ")}]`]
  if (!report.bypass && report.exposed) {
    if (report.check !== undefined && report.op === "insert") {
      lines.push("check:", ...policyLines(report.check))
    } else {
      if (report.check !== undefined) lines.push("using:")
      lines.push(...policyLines(report.using))
      if (report.check !== undefined) lines.push("check:", ...policyLines(report.check))
    }
  }
  lines.push(`Result: ${verdict(report)}`)
  lines.push(`Effective filter: ${render(toFilter(report.effective))}`)
  const read = describeFields("Fields", report.readable)
  if (read !== undefined) lines.push(read)
  const write =
    report.writable === undefined ? undefined : describeFields("Writable fields", report.writable)
  if (write !== undefined) lines.push(write)
  if (report.op === "update" && report.immutable.length > 0 && !report.bypass)
    lines.push(`Immutable: ${report.immutable.join(", ")}`)
  return lines.join("\n")
}

/** Builds the request context of a stated caller: `anon` without claims, else `authenticated` plus roles. */
export function explainContext(options: {
  readonly claims: Readonly<Record<string, unknown>> | null
  readonly roles?: readonly string[]
  readonly ctx?: Readonly<Record<string, unknown>>
  readonly now?: Date
}): RequestContext {
  const extra = options.roles ?? []
  const roles = extra.includes(Role.Service)
    ? [Role.Service]
    : [options.claims === null ? Role.Anon : Role.Authenticated, ...extra]
  return {
    roles: new Set(roles),
    claims: options.claims,
    ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
    now: options.now ?? new Date(),
  }
}

/** A variable issue together with the policy it made drop out, as {@link EngineHooks} reports it. */
export type PolicyVariableIssue = VariableIssue & {
  readonly collection: string
  readonly policy: string
}

/**
 * Builds an `onVariableIssue` hook for development servers that reports each distinct issue once: the
 * collection, the policy, the variable and the kind of problem, never the claim or context value. At most
 * `limit` distinct issues are remembered (default 1000), so a flood of new ones cannot grow memory.
 */
export function onceVariableIssue(
  report: (message: string, issue: PolicyVariableIssue) => void,
  limit = 1000,
): (issue: PolicyVariableIssue) => void {
  const seen = new Set<string>()
  return (issue) => {
    const key = `${issue.collection}\u0000${issue.policy}\u0000${issue.variable}\u0000${issue.kind}`
    if (seen.has(key)) return
    if (seen.size >= limit) seen.clear()
    seen.add(key)
    report(
      `policy "${issue.policy}" on ${issue.collection} did not match: ${describeIssue(issue)}`,
      issue,
    )
  }
}
