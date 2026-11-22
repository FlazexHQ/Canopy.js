import { Binary, InvalidQueryError, isDocument, ObjectId } from "../protocol/index.ts"
import { isVariable } from "../query/index.ts"
import type { RequestContext } from "./model.ts"

/** Why a variable made its policy non matching. */
export type VariableIssueKind = "missing" | "shape" | "coercion"

/** Reported for every variable that fails to resolve (feeds `canopy_policy_variable_errors_total`). */
export interface VariableIssue {
  readonly kind: VariableIssueKind
  readonly variable: string
}

/** The largest array a variable may resolve to under `$in`, `$nin` or `$all`. */
export const MAX_VARIABLE_LIST = 1000

const LIST_OPERATORS = new Set(["$in", "$nin", "$all"])
const DURATION =
  /^([+-])?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2}):(\d{2})))?$/

class Unresolvable {
  readonly issue: VariableIssue
  constructor(issue: VariableIssue) {
    this.issue = issue
  }
}

/** Reads a dotted path from a claims object, following only own properties of plain objects. */
export function readClaim(claims: Readonly<Record<string, unknown>> | null, path: string): unknown {
  let value: unknown = claims
  for (const segment of path.split(".")) {
    if (!isDocument(value) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

/**
 * Shifts a date by an ISO 8601 duration such as `-P7D` or `PT24H`, using UTC calendar arithmetic. The result
 * is an invalid date when it falls outside the range of dates.
 */
export function shiftDate(date: Date, duration: string): Date {
  const match = DURATION.exec(duration)
  if (match === null) throw new TypeError(`Invalid ISO 8601 duration: ${duration}`)
  const sign = match[1] === "-" ? -1 : 1
  const n = (index: number): number => Number(match[index] ?? 0)
  const out = new Date(date.getTime())
  out.setUTCFullYear(out.getUTCFullYear() + sign * n(2))
  out.setUTCMonth(out.getUTCMonth() + sign * n(3))
  const ms = ((n(4) * 7 + n(5)) * 86_400 + n(6) * 3600 + n(7) * 60 + n(8)) * 1000
  return new Date(out.getTime() + sign * ms)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/**
 * Reads `YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DDTHH:mm[:ss[.fraction]]` with `Z` or a `±HH:mm` offset, as
 * milliseconds since the epoch, or NaN. Other forms are refused: without an offset JavaScript reads a time in
 * the local time zone, and the formats `Date.parse` accepts beyond ISO 8601 differ between engines.
 */
function isoDateMs(text: string): number {
  const match = ISO_DATE.exec(text)
  if (match === null) return Number.NaN
  const part = (index: number): number => Number(match[index] ?? 0)
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(part) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const offset = (part(9) * 60 + part(10)) * (match[8] === "-" ? -1 : 1)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return Number.NaN
  if (hour > 23 || minute > 59 || second > 59 || part(9) > 23 || part(10) > 59) return Number.NaN
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, Number((match[7] ?? "").slice(0, 3).padEnd(3, "0")))
  return date.getTime() - offset * 60_000
}

function isScalar(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return false
  return !isDocument(value)
}

function coerce(value: unknown, as: string | undefined, variable: string): unknown {
  if (as === undefined) return value
  const fail = (): never => {
    throw new Unresolvable({ kind: "coercion", variable })
  }
  switch (as) {
    case "objectId":
      if (typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value)
      return fail()
    case "string":
      if (typeof value === "string") return value
      if (typeof value === "number" && Number.isFinite(value)) return String(value)
      return fail()
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return value
      if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
      return fail()
    case "bool":
      if (typeof value === "boolean") return value
      if (value === "true" || value === "false") return value === "true"
      return fail()
    case "date": {
      const date = new Date(
        typeof value === "number"
          ? value * 1000
          : typeof value === "string"
            ? isoDateMs(value)
            : Number.NaN,
      )
      if (Number.isNaN(date.getTime())) return fail()
      return date
    }
    case "uuid": {
      if (typeof value !== "string" || !UUID.test(value)) return fail()
      const hex = value.replaceAll("-", "")
      const bytes = new Uint8Array(16)
      for (let index = 0; index < 16; index += 1)
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
      return new Binary(bytes, 4)
    }
    default:
      return fail()
  }
}

function resolveVariable(
  variable: Record<string, unknown>,
  list: boolean,
  ctx: RequestContext,
): unknown {
  let raw: unknown
  let name: string
  let as: string | undefined
  if (Object.hasOwn(variable, "$auth")) {
    name = `$auth:${String(variable["$auth"])}`
    raw = readClaim(ctx.claims, String(variable["$auth"]))
    as = typeof variable["as"] === "string" ? variable["as"] : undefined
  } else if (Object.hasOwn(variable, "$ctx")) {
    const key = String(variable["$ctx"])
    name = `$ctx:${key}`
    raw = ctx.ctx !== undefined && Object.hasOwn(ctx.ctx, key) ? ctx.ctx[key] : undefined
  } else {
    name = "$now"
    const spec = variable["$now"]
    const offset =
      isDocument(spec) && typeof spec["offset"] === "string" ? spec["offset"] : undefined
    const value = offset === undefined ? new Date(ctx.now.getTime()) : shiftDate(ctx.now, offset)
    if (list) throw new Unresolvable({ kind: "shape", variable: name })
    if (Number.isNaN(value.getTime())) throw new Unresolvable({ kind: "coercion", variable: name })
    return value
  }
  if (raw === undefined || raw === null) throw new Unresolvable({ kind: "missing", variable: name })
  if (list) {
    if (!Array.isArray(raw) || raw.length > MAX_VARIABLE_LIST)
      throw new Unresolvable({ kind: "shape", variable: name })
    return raw.map((item) => {
      if (!isScalar(item)) throw new Unresolvable({ kind: "shape", variable: name })
      return coerce(item, as, name)
    })
  }
  if (!isScalar(raw)) throw new Unresolvable({ kind: "shape", variable: name })
  return coerce(raw, as, name)
}

function substitute(value: unknown, list: boolean, ctx: RequestContext): unknown {
  if (isVariable(value)) return resolveVariable(value, list, ctx)
  if (Array.isArray(value)) return value.map((item) => substitute(item, false, ctx))
  if (!isDocument(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    out[key] = substitute(value[key], LIST_OPERATORS.has(key), ctx)
  }
  return out
}

/** The outcome of resolving one clause. */
export type ResolvedClause =
  | { readonly ok: true; readonly filter: Record<string, unknown> }
  | { readonly ok: false; readonly issue: VariableIssue }

/**
 * Substitutes the variables of a clause for one request context. A variable that is missing, `null`, of the
 * wrong shape or fails its coercion makes the whole clause unresolvable, so its policy does not match. There
 * are no defaults. A clause that is itself a variable, such as `{ $auth: "sub" }`, is not a filter and throws
 * an {@link InvalidQueryError}.
 */
export function resolveClause(
  clause: Readonly<Record<string, unknown>>,
  ctx: RequestContext,
): ResolvedClause {
  if (isVariable(clause))
    throw new InvalidQueryError("A policy clause must be a filter document, not a variable")
  try {
    return { ok: true, filter: substitute(clause, false, ctx) as Record<string, unknown> }
  } catch (error: unknown) {
    if (error instanceof Unresolvable) return { ok: false, issue: error.issue }
    throw error
  }
}

/** Returns true when the clause depends on the request time, so realtime must re-snapshot it periodically. */
export function usesNow(clause: unknown): boolean {
  if (Array.isArray(clause)) return clause.some(usesNow)
  if (!isDocument(clause)) return false
  if (Object.hasOwn(clause, "$now")) return true
  return Object.keys(clause).some((key) => usesNow(clause[key]))
}

/** Lists the claim paths a clause reads, for the `user-editable-claim` lint rule and claim change detection. */
export function claimPaths(clause: unknown): string[] {
  const out: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isDocument(value)) return
    if (typeof value["$auth"] === "string") {
      out.push(value["$auth"])
      return
    }
    for (const key of Object.keys(value)) visit(value[key])
  }
  visit(clause)
  return out
}
