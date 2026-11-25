import { Role } from "./model.ts"
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
interface DocumentTestCase {
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

/** A filter given to {@link SuiteHelpers.where}: the case covers every stored document it matches. */
export interface FilterTarget {
  readonly filter: Readonly<Record<string, unknown>>
}

const FILTER: unique symbol = Symbol.for("canopy.policy.testing.filter")

interface FilterMarker extends FilterTarget {
  readonly [FILTER]: true
}

function isFilterTarget(value: unknown): value is FilterMarker {
  return typeof value === "object" && value !== null && Object.hasOwn(value, FILTER)
}

/** One declared expectation about a concrete document. */
export type PolicyDocumentCase = DocumentTestCase & { readonly filter?: never }

/**
 * One declared expectation about every stored document a filter matches. It runs only against MongoDB: it
 * passes when every matching document gives the expected outcome, and fails when the filter matches none or
 * the documents disagree. Without MongoDB it is reported as not run.
 */
export interface PolicyFilterCase extends Omit<DocumentTestCase, "doc"> {
  readonly doc?: never
  readonly filter: Readonly<Record<string, unknown>>
}

/** One declared expectation: about a concrete document, or about the documents a filter matches. */
export type PolicyTestCase = PolicyDocumentCase | PolicyFilterCase

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

type Target<Doc> = Partial<Doc> | FilterTarget

interface Expectation<Doc> {
  read(target: Target<Doc>): ReadChain
  insert(doc: Partial<Doc>): void
  update(target: Target<Doc>, update: Readonly<Record<string, unknown>>): void
  delete(target: Target<Doc>): void
}

/** The helpers passed to a {@link describePolicies} body, typed by the collection's document type. */
export interface SuiteHelpers<Doc = Readonly<Record<string, unknown>>> {
  doc(value: Partial<Doc>): Partial<Doc>
  /** Targets every stored document the filter matches instead of one concrete document. */
  where(filter: Readonly<Record<string, unknown>>): FilterTarget
  expect(actor: Actor): { readonly can: Expectation<Doc>; readonly cannot: Expectation<Doc> }
}

function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value))
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const registry: PolicySuite[] = []

/**
 * Declares policy tests for one collection. Expectations are collected as data, not run: `canopy.js/emit`
 * turns each one into a canonical test case document, and `canopy policies test` runs them in memory and
 * against MongoDB. `where(filter)` targets every stored document a filter matches.
 */
export function describePolicies<const C extends CollectionName<Registered>>(
  collection: C,
  body: (helpers: SuiteHelpers<DocumentOf<Registered, C>>) => void,
  name: string = collection,
): PolicySuite {
  type Doc = DocumentOf<Registered, C>
  const cases: PolicyTestCase[] = []
  const target = (value: Target<Doc>) =>
    isFilterTarget(value) ? { filter: toRecord(value.filter) } : { doc: toRecord(value) }
  const expectation = (actor: Actor, expected: boolean): Expectation<Doc> => ({
    read(value) {
      const testCase = {
        suite: name,
        collection,
        actor,
        action: "read",
        ...target(value),
        expected,
      } as Mutable<PolicyTestCase>
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
    update(value, update) {
      cases.push({
        suite: name,
        collection,
        actor,
        action: "update",
        ...target(value),
        update: toRecord(update),
        expected,
      } as PolicyTestCase)
    },
    delete(value) {
      cases.push({
        suite: name,
        collection,
        actor,
        action: "delete",
        ...target(value),
        expected,
      } as PolicyTestCase)
    },
  })
  body({
    doc: (value) => value,
    where: (filter) => Object.freeze({ [FILTER]: true as const, filter }),
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

/** Whether a case targets the documents a filter matches. */
export function isFilterCase(testCase: PolicyTestCase): testCase is PolicyFilterCase {
  return testCase.filter !== undefined
}
