import { InvalidQueryError, isDocument } from "../protocol/index.ts"
import { parseFilter, USING_LIMITS, validatePath } from "../query/index.ts"
import {
  type CollectionPolicies,
  type ContextDefinitions,
  type FieldRules,
  OPERATIONS,
  type Operation,
  Role,
  STORAGE_COLLECTION,
} from "./model.ts"

/** Policy size limits: policies per collection, bytes per clause and clause nesting depth. */
export const POLICY_LIMITS: {
  readonly maxPolicies: 64
  readonly maxClauseBytes: 32768
  readonly maxDepth: 12
} = {
  maxPolicies: 64,
  maxClauseBytes: 32768,
  maxDepth: 12,
}

const COERCIONS = new Set(["objectId", "string", "number", "bool", "date", "uuid"])
const DURATION =
  /^[+-]?P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/
const COLLECTION = /^[A-Za-z_][\w.-]{0,119}$/

/** Raised when a policy definition breaks a validation rule. */
export class PolicyValidationError extends InvalidQueryError {
  readonly collection: string

  constructor(collection: string, message: string) {
    super(`Invalid policies for collection '${collection}': ${message}`)
    this.name = "PolicyValidationError"
    this.collection = collection
  }
}

function clauseSize(clause: unknown): number {
  return new TextEncoder().encode(JSON.stringify(clause)).length
}

/**
 * Validates the policies of one collection: clause and operation compatibility, roles, unique names, the
 * operator allowlists of each clause type, variable placement and the size limits. Throws
 * {@link PolicyValidationError} on the first problem.
 */
export function validateCollectionPolicies(
  def: CollectionPolicies,
  contexts: ContextDefinitions = {},
): void {
  const fail = (message: string): never => {
    throw new PolicyValidationError(def.collection, message)
  }
  if (!COLLECTION.test(def.collection) || def.collection.startsWith("system.")) {
    fail("the collection name is not valid")
  }
  if (def.collection === STORAGE_COLLECTION && def.realtime)
    fail("storage.objects holds storage policies and cannot be followed in realtime")
  if (def.policies.length > POLICY_LIMITS.maxPolicies)
    fail(`at most ${POLICY_LIMITS.maxPolicies} policies are allowed`)
  const names = new Set<string>()
  for (const policy of def.policies) {
    const where = `policy '${policy.name}'`
    if (policy.name.trim() === "") fail("every policy needs a name")
    if (names.has(policy.name)) fail(`the policy name '${policy.name}' is used twice`)
    names.add(policy.name)
    if (policy.kind !== "permissive" && policy.kind !== "restrictive")
      fail(`${where} has an unknown kind`)
    if (policy.ops.length === 0) fail(`${where} needs at least one operation`)
    if (policy.roles.length === 0) fail(`${where} needs at least one role`)
    for (const op of policy.ops)
      if (!OPERATIONS.includes(op)) fail(`${where} has the unknown operation '${op}'`)
    if (new Set(policy.ops).size !== policy.ops.length) fail(`${where} lists an operation twice`)
    for (const role of policy.roles) {
      if (role === Role.Service) fail(`${where} names the service role, which always bypasses DLS`)
      if (!/^[\w:.-]{1,64}$/.test(role)) fail(`${where} has an invalid role name '${role}'`)
    }
    const usesUsing = policy.ops.some(
      (op: Operation) => op === "read" || op === "update" || op === "delete",
    )
    const usesCheck = policy.ops.some((op: Operation) => op === "insert" || op === "update")
    if (policy.using !== undefined && !usesUsing)
      fail(`${where} covers only insert, so it may not have a using clause`)
    if (policy.check !== undefined && !usesCheck)
      fail(`${where} covers only read or delete, so it may not have a check clause`)
    for (const [kind, clause] of [
      ["using", policy.using],
      ["check", policy.check],
    ] as const) {
      if (clause === undefined) continue
      if (!isDocument(clause)) fail(`${where} has a ${kind} clause that is not a document`)
      if (clauseSize(clause) > POLICY_LIMITS.maxClauseBytes)
        fail(`${where} has a ${kind} clause larger than 32 KiB`)
      try {
        parseFilter(clause, {
          context: kind,
          variables: true,
          limits: {
            ...USING_LIMITS,
            maxDepth: POLICY_LIMITS.maxDepth,
            maxRegexLength: kind === "using" ? 256 : 1024,
          },
        })
      } catch (error: unknown) {
        fail(
          `${where} has an invalid ${kind} clause: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      validateVariables(clause, contexts, (message) => fail(`${where}: ${message}`))
    }
  }
  validateFields(def, fail)
  for (const path of def.immutable ?? []) {
    try {
      validatePath(path, { maxLength: 512 })
    } catch {
      fail(`the immutable path '${path}' is not valid`)
    }
  }
}

function validateFields(def: CollectionPolicies, fail: (message: string) => never): void {
  for (const kind of ["read", "write", "update"] as const) {
    const rules: FieldRules | undefined = def.fields?.[kind]
    if (rules === undefined) continue
    for (const [role, rule] of Object.entries(rules)) {
      if (role === Role.Service) fail(`fields.${kind} names the service role`)
      const only = "only" in rule ? rule.only : undefined
      const omit = "omit" in rule ? rule.omit : undefined
      if ((only === undefined) === (omit === undefined))
        fail(`fields.${kind}.${role} needs exactly one of only or omit`)
      for (const path of only ?? omit ?? []) {
        if (path === "*" && only !== undefined) continue
        try {
          validatePath(path, { maxLength: 512 })
        } catch {
          fail(`fields.${kind}.${role} has the invalid path '${path}'`)
        }
      }
    }
  }
}

function validateVariables(
  clause: unknown,
  contexts: ContextDefinitions,
  fail: (message: string) => never,
): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isDocument(value)) return
    const keys = Object.keys(value)
    if (keys.includes("$auth")) {
      const path = value["$auth"]
      const as = value["as"]
      if (typeof path !== "string" || !/^[\w-]+(?:\.[\w-]+)*$/.test(path))
        fail("$auth needs a dotted claim path")
      if (keys.some((k) => k !== "$auth" && k !== "as")) fail('$auth only accepts an "as" option')
      if (as !== undefined && (typeof as !== "string" || !COERCIONS.has(as)))
        fail(`unknown coercion "${String(as)}"`)
      return
    }
    if (keys.includes("$ctx")) {
      const name = value["$ctx"]
      if (keys.length !== 1 || typeof name !== "string") fail("$ctx needs a lookup name")
      if (!Object.hasOwn(contexts, name)) fail(`the context lookup '${name}' is not declared`)
      return
    }
    if (keys.includes("$now")) {
      const spec = value["$now"]
      if (keys.length !== 1 || !isDocument(spec)) fail("$now needs a document")
      const offset = spec["offset"]
      if (Object.keys(spec).some((k) => k !== "offset")) fail("$now only accepts an offset")
      if (
        offset !== undefined &&
        (typeof offset !== "string" ||
          !DURATION.test(offset) ||
          offset.endsWith("P") ||
          offset.endsWith("T"))
      ) {
        fail(`invalid ISO 8601 duration ${String(offset)}`)
      }
      return
    }
    for (const k of keys) visit(value[k])
  }
  visit(clause)
}

/** Validates context lookup declarations. */
export function validateContexts(contexts: ContextDefinitions): void {
  for (const [name, lookup] of Object.entries(contexts)) {
    const fail = (message: string): never => {
      throw new PolicyValidationError("_context", `${name}: ${message}`)
    }
    if (!/^[A-Za-z_]\w{0,63}$/.test(name)) fail("invalid lookup name")
    if (!COLLECTION.test(lookup.from)) fail("invalid source collection")
    if (!Number.isSafeInteger(lookup.max) || lookup.max < 1 || lookup.max > 100_000)
      fail("max must be between 1 and 100000")
    try {
      validatePath(lookup.select, { maxLength: 512 })
    } catch {
      fail("invalid select path")
    }
    const where = parseFilter(lookup.where, { context: "using", variables: true })
    const text = JSON.stringify(lookup.where)
    if (text.includes('"$ctx"') || text.includes('"$now"'))
      fail("only $auth variables are allowed in where")
    if (!where.hasVariables) fail("where must reference the subject through $auth")
    if (!/^\d+[smhd]$/.test(lookup.ttl)) fail("ttl must look like 30s, 5m, 1h or 1d")
  }
}
