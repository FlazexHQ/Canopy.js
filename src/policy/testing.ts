import {
  type Actor,
  as,
  contextOf,
  evaluateInMemory,
  memoryBackend,
  type PolicyAction,
  type PolicyBackend,
  type PolicyOutcome,
  type PolicyTestCase as DocumentTestCase,
  type PolicySuite as DocumentSuite,
  type PolicyTestResult as DocumentTestResult,
  policyCoverage as documentCoverage,
  runPolicyTests as runDocumentTests,
} from "../core/policy/testing.ts"
import type { PolicyEngine } from "../core/policy/engine.ts"
import type { CollectionName, DocumentOf, Registered } from "../core/policy/typed.ts"

export {
  type Actor,
  as,
  contextOf,
  evaluateInMemory,
  memoryBackend,
  type PolicyAction,
  type PolicyBackend,
  type PolicyOutcome,
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

/** The verdict for one case across every backend. */
export interface PolicyTestResult {
  readonly testCase: PolicyTestCase
  readonly outcomes: Readonly<Record<string, PolicyOutcome>>
  readonly passed: boolean
  /** A filter case the backends could not run; never counted as passed. */
  readonly notRun: boolean
  readonly failures: readonly string[]
}

function documentSuites(suites: readonly PolicySuite[]): DocumentSuite[] {
  return suites.map((suite) => ({
    ...suite,
    cases: suite.cases.filter(
      (testCase): testCase is PolicyDocumentCase => !isFilterCase(testCase),
    ),
  }))
}

/**
 * Runs every document case on every backend. A case fails when a backend disagrees with the expectation, or
 * when two backends disagree with each other. Filter cases need MongoDB, which these backends do not query,
 * so they are reported as not run.
 */
export async function runPolicyTests(
  suites: readonly PolicySuite[],
  backends: readonly PolicyBackend[],
): Promise<PolicyTestResult[]> {
  const ran = await runDocumentTests(documentSuites(suites), backends)
  const results: PolicyTestResult[] = []
  let next = 0
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      if (isFilterCase(testCase)) {
        results.push({
          testCase,
          outcomes: {},
          passed: false,
          notRun: true,
          failures: ["not run: a filter case runs only against MongoDB"],
        })
        continue
      }
      const result: DocumentTestResult | undefined = ran[next++]
      if (result !== undefined) results.push({ ...result, notRun: false })
    }
  }
  return results
}

/** Reports which policies the document cases exercised. */
export function policyCoverage(
  engine: PolicyEngine,
  suites: readonly PolicySuite[],
  now: Date = new Date(),
): ReturnType<typeof documentCoverage> {
  return documentCoverage(engine, documentSuites(suites), now)
}
