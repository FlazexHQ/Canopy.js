import { applyUpdate, compileFilter } from "../matcher/index.ts"
import { CanopyError, isDocument } from "../protocol/index.ts"
import { parseUpdate } from "../query/index.ts"
import { type Compiled, type PolicyEngine, toFilter } from "./engine.ts"
import { canAccess, documentPaths, immutableViolations, projectReadable } from "./fields.ts"
import { type RequestContext, Role } from "./model.ts"
import type { CollectionName, DocumentOf, Registered } from "./typed.ts"

/** Who performs an action in a policy test. */
export interface Actor {
  readonly label: string
  readonly roles: readonly string[]
  readonly claims: Readonly<Record<string, unknown>> | null
  readonly ctx?: Readonly<Record<string, unknown>>
}

/** Builders for actors. */
export const as: {
  /** A signed in user with these claims, typed by the project's `Register` declaration. */
  user(
    claims: Partial<Registered["claims"]>,
    options?: { roles?: readonly string[]; ctx?: Readonly<Record<string, unknown>> },
  ): Actor
  anon(): Actor
  service(): Actor
} = {
  user(claims, options = {}) {
    const record = toRecord(claims)
    const label = typeof record["sub"] === "string" ? record["sub"] : "user"
    return {
      label,
      roles: [Role.Authenticated, ...(options.roles ?? [])],
      claims: record,
      ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
    }
  },
  anon() {
    return { label: "anon", roles: [Role.Anon], claims: null }
  },
  service() {
    return { label: "service", roles: [Role.Service], claims: null }
  },
}

/** The actions a policy test can check. */
export type PolicyAction = "read" | "insert" | "update" | "delete"

/** One declared expectation. */
export interface PolicyTestCase {
  readonly suite: string
  readonly collection: string
  readonly actor: Actor
  readonly action: PolicyAction
  readonly doc: Record<string, unknown>
  readonly update?: Record<string, unknown>
  readonly expected: boolean
  readonly withoutFields?: readonly string[]
  readonly withFields?: readonly string[]
}

/** What a backend observed for one case. */
export interface PolicyOutcome {
  readonly allowed: boolean
  readonly reason: string
  /** For reads: the document as the actor receives it. */
  readonly document?: Record<string, unknown>
}

/** Evaluates cases. The in-memory backend is built in; `canopy policies test` adds a MongoDB backend. */
export interface PolicyBackend {
  readonly name: string
  evaluate(testCase: PolicyTestCase): Promise<PolicyOutcome>
}

/** A group of cases for one collection. */
export interface PolicySuite {
  readonly name: string
  readonly collection: string
  readonly cases: readonly PolicyTestCase[]
}

interface ReadChain {
  withoutFields(fields: readonly string[]): ReadChain
  withFields(fields: readonly string[]): ReadChain
}

interface Expectation<Doc> {
  read(doc: Partial<Doc>): ReadChain
  insert(doc: Partial<Doc>): void
  update(doc: Partial<Doc>, update: Readonly<Record<string, unknown>>): void
  delete(doc: Partial<Doc>): void
}

/** The helpers passed to a {@link describePolicies} body, typed by the collection's document type. */
export interface SuiteHelpers<Doc = Readonly<Record<string, unknown>>> {
  doc(value: Partial<Doc>): Partial<Doc>
  expect(actor: Actor): { readonly can: Expectation<Doc>; readonly cannot: Expectation<Doc> }
}

function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value))
}

const registry: PolicySuite[] = []

/**
 * Declares policy tests for one collection. Expectations are collected, not run; run them
 * with {@link runPolicyTests} or `canopy policies test`, which evaluates every case in memory and against
 * MongoDB and fails on any disagreement.
 */
export function describePolicies<const C extends CollectionName<Registered>>(
  collection: C,
  body: (helpers: SuiteHelpers<DocumentOf<Registered, C>>) => void,
  name: string = collection,
): PolicySuite {
  type Doc = DocumentOf<Registered, C>
  const cases: PolicyTestCase[] = []
  const expectation = (actor: Actor, expected: boolean): Expectation<Doc> => ({
    read(doc) {
      const testCase: { -readonly [K in keyof PolicyTestCase]: PolicyTestCase[K] } = {
        suite: name,
        collection,
        actor,
        action: "read",
        doc: toRecord(doc),
        expected,
      }
      cases.push(testCase)
      const chain: ReadChain = {
        withoutFields(fields) {
          testCase.withoutFields = [...(testCase.withoutFields ?? []), ...fields]
          return chain
        },
        withFields(fields) {
          testCase.withFields = [...(testCase.withFields ?? []), ...fields]
          return chain
        },
      }
      return chain
    },
    insert(doc) {
      cases.push({ suite: name, collection, actor, action: "insert", doc: toRecord(doc), expected })
    },
    update(doc, update) {
      cases.push({
        suite: name,
        collection,
        actor,
        action: "update",
        doc: toRecord(doc),
        update: toRecord(update),
        expected,
      })
    },
    delete(doc) {
      cases.push({ suite: name, collection, actor, action: "delete", doc: toRecord(doc), expected })
    },
  })
  body({
    doc: (value) => value,
    expect: (actor) => ({ can: expectation(actor, true), cannot: expectation(actor, false) }),
  })
  const suite: PolicySuite = { name, collection, cases }
  registry.push(suite)
  return suite
}

/** Returns and clears the suites declared since the last call. */
export function takeRegisteredSuites(): PolicySuite[] {
  return registry.splice(0, registry.length)
}

/** Builds the request context of an actor. */
export function contextOf(actor: Actor, now: Date = new Date()): RequestContext {
  return {
    roles: new Set(actor.roles),
    claims: actor.claims,
    ...(actor.ctx === undefined ? {} : { ctx: actor.ctx }),
    now,
  }
}

function matches(compiled: Compiled, doc: Record<string, unknown>): boolean {
  if (compiled.kind === "all") return true
  if (compiled.kind === "deny") return false
  return compileFilter(toFilter(compiled)).matches(doc)
}

/** Evaluates cases with the in-process matcher and updater. */
export function memoryBackend(engine: PolicyEngine, now: Date = new Date()): PolicyBackend {
  return {
    name: "memory",
    async evaluate(testCase) {
      return evaluateInMemory(engine, testCase, now)
    },
  }
}

/** Evaluates one case in process, mirroring the REST semantics: targets need USING(op)
 * and USING(read), written fields must be writable and not immutable, and results must pass CHECK(op). */
export function evaluateInMemory(
  engine: PolicyEngine,
  testCase: PolicyTestCase,
  now: Date = new Date(),
): PolicyOutcome {
  const ctx = contextOf(testCase.actor, now)
  const { collection, doc } = testCase
  const service = ctx.roles.has(Role.Service)
  if (!service && !engine.isExposed(collection))
    return { allowed: false, reason: "the collection is not exposed" }
  switch (testCase.action) {
    case "read": {
      if (!matches(engine.using(collection, "read", ctx), doc))
        return { allowed: false, reason: "USING(read) does not match" }
      return {
        allowed: true,
        reason: "visible",
        document: projectReadable(engine.readable(collection, ctx), doc),
      }
    }
    case "insert": {
      if (!engine.hasGrant(collection, "insert", ctx))
        return { allowed: false, reason: "no policy grants insert" }
      const writable = engine.writable(collection, "insert", ctx)
      const denied = documentPaths(doc).filter((path) => !canAccess(writable, path))
      if (denied.length > 0)
        return { allowed: false, reason: `fields not writable: ${denied.join(", ")}` }
      if (!matches(engine.check(collection, "insert", ctx), doc))
        return { allowed: false, reason: "CHECK(insert) fails" }
      return { allowed: true, reason: "inserted" }
    }
    case "update": {
      if (!engine.hasGrant(collection, "update", ctx))
        return { allowed: false, reason: "no policy grants update" }
      if (!matches(engine.target(collection, "update", ctx), doc))
        return { allowed: false, reason: "not a target (matched 0)" }
      const update = testCase.update ?? {}
      let written: readonly string[]
      try {
        written = parseUpdate(update, { allowPipeline: service }).writtenPaths
      } catch (error: unknown) {
        return { allowed: false, reason: error instanceof Error ? error.message : String(error) }
      }
      if (!service) {
        const writable = engine.writable(collection, "update", ctx)
        const denied = written.filter((path) => !canAccess(writable, path))
        if (denied.length > 0)
          return { allowed: false, reason: `fields not writable: ${denied.join(", ")}` }
        const immutable = immutableViolations(written, engine.immutable(collection))
        if (immutable.length > 0)
          return { allowed: false, reason: `immutable fields: ${immutable.join(", ")}` }
      }
      let post: Record<string, unknown>
      try {
        post = applyUpdate(doc, update)
      } catch (error: unknown) {
        return {
          allowed: false,
          reason: error instanceof CanopyError ? error.message : String(error),
        }
      }
      if (!matches(engine.check(collection, "update", ctx), post))
        return { allowed: false, reason: "CHECK(update) fails" }
      return { allowed: true, reason: "updated" }
    }
    case "delete": {
      if (!engine.hasGrant(collection, "delete", ctx))
        return { allowed: false, reason: "no policy grants delete" }
      if (!matches(engine.target(collection, "delete", ctx), doc))
        return { allowed: false, reason: "not a target (matched 0)" }
      return { allowed: true, reason: "deleted" }
    }
  }
}

/** The verdict for one case across every backend. */
export interface PolicyTestResult {
  readonly testCase: PolicyTestCase
  readonly outcomes: Readonly<Record<string, PolicyOutcome>>
  readonly passed: boolean
  readonly failures: readonly string[]
}

function hasPath(doc: Record<string, unknown>, path: string): boolean {
  let value: unknown = doc
  for (const segment of path.split(".")) {
    if (!isDocument(value) || !Object.hasOwn(value, segment)) return false
    value = value[segment]
  }
  return true
}

function describeCase(testCase: PolicyTestCase): string {
  const verb = testCase.expected ? "can" : "cannot"
  return `${testCase.actor.label} ${verb} ${testCase.action} ${JSON.stringify(testCase.doc["_id"] ?? testCase.doc)}`
}

/**
 * Runs every case on every backend. A case fails when a backend disagrees with the expectation, or when two
 * backends disagree with each other, because that is the class of bug that makes realtime and REST differ.
 */
export async function runPolicyTests(
  suites: readonly PolicySuite[],
  backends: readonly PolicyBackend[],
): Promise<PolicyTestResult[]> {
  const results: PolicyTestResult[] = []
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      const outcomes: Record<string, PolicyOutcome> = {}
      const failures: string[] = []
      for (const backend of backends) {
        let outcome: PolicyOutcome
        try {
          outcome = await backend.evaluate(testCase)
        } catch (error: unknown) {
          outcome = {
            allowed: false,
            reason: `backend error: ${error instanceof Error ? error.message : String(error)}`,
          }
          failures.push(`${backend.name}: ${outcome.reason}`)
        }
        outcomes[backend.name] = outcome
        if (outcome.allowed !== testCase.expected) {
          failures.push(
            `${backend.name}: expected ${describeCase(testCase)}, but ${outcome.reason}`,
          )
        }
        if (outcome.allowed && outcome.document !== undefined) {
          for (const field of testCase.withoutFields ?? []) {
            if (hasPath(outcome.document, field))
              failures.push(`${backend.name}: ${field} should be hidden`)
          }
          for (const field of testCase.withFields ?? []) {
            if (!hasPath(outcome.document, field))
              failures.push(`${backend.name}: ${field} should be visible`)
          }
        }
      }
      const verdicts = new Set(Object.values(outcomes).map((outcome) => outcome.allowed))
      if (verdicts.size > 1) {
        failures.push(
          `backends disagree: ${Object.entries(outcomes)
            .map(
              ([name, outcome]) =>
                `${name} ${outcome.allowed ? "allowed" : "denied"} (${outcome.reason})`,
            )
            .join(", ")}`,
        )
      }
      results.push({ testCase, outcomes, passed: failures.length === 0, failures })
    }
  }
  return results
}

/** Reports which policies the cases exercised. */
export function policyCoverage(
  engine: PolicyEngine,
  suites: readonly PolicySuite[],
  now: Date = new Date(),
): Map<
  string,
  { readonly exercised: ReadonlySet<string>; readonly unexercised: readonly string[] }
> {
  const out = new Map<string, { exercised: Set<string>; unexercised: string[] }>()
  for (const suite of suites) {
    const def = engine.collection(suite.collection)
    if (def === undefined) continue
    const entry = out.get(def.collection) ?? { exercised: new Set<string>(), unexercised: [] }
    for (const testCase of suite.cases) {
      const op = testCase.action
      const explanation = engine.explain(def.collection, op, contextOf(testCase.actor, now))
      for (const policy of explanation.policies) {
        if (!policy.applies || policy.resolved === undefined) continue
        if (compileFilter(policy.resolved).matches(testCase.doc)) entry.exercised.add(policy.name)
      }
    }
    entry.unexercised = def.policies
      .map((policy) => policy.name)
      .filter((name) => !entry.exercised.has(name))
    out.set(def.collection, entry)
  }
  return out
}
