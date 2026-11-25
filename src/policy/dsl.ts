import type {
  CollectionFields,
  CollectionPolicies,
  ContextDefinitions,
  ContextLookup,
  FilterTemplate,
  Operation,
  PolicyDefinition,
  PolicyKind,
} from "./model.ts"
import type {
  CheckLookups,
  CheckPolicies,
  Claim,
  ClaimPath,
  ClaimValue,
  ClauseTypes,
  Coerced,
  CollectionName,
  ContextName,
  ContextValue,
  Ctx,
  DocumentOf,
  Now,
  Path,
  PolicyRole,
  PolicyTypes,
  Registered,
  TypedCollectionFields,
} from "./typed.ts"

/** Coercions a JWT claim variable can request. */
export type ClaimCoercion = "objectId" | "string" | "number" | "bool" | "date" | "uuid"

/** A JWT claim variable in stored form. */
export interface AuthVariable {
  readonly $auth: string
  readonly as?: ClaimCoercion
}

/** A context lookup variable in stored form. */
export interface CtxVariable {
  readonly $ctx: string
}

/** A time variable in stored form. */
export interface NowVariable {
  readonly $now: { readonly offset?: string }
}

/**
 * A policy under construction. Every method returns a new builder; nothing is mutated. The type parameters
 * record the clause types so that {@link collection} can check them against the collection's documents.
 */
export class PolicyBuilder<out U = unknown, out C = unknown> {
  readonly definition: PolicyDefinition
  declare readonly clauses?: ClauseTypes<U, C>

  constructor(definition: PolicyDefinition) {
    this.definition = definition
  }

  /** Sets the `using` clause: which existing documents the operation may touch. */
  where<const F extends FilterTemplate>(using: F): PolicyBuilder<F, C> {
    return new PolicyBuilder({ ...this.definition, using })
  }

  /** Sets the `check` clause: the condition the resulting document must satisfy. */
  check<const F extends FilterTemplate>(check: F): PolicyBuilder<U, F> {
    return new PolicyBuilder({ ...this.definition, check })
  }

  /** Names the policy. Names must be unique within a collection. */
  named(name: string): PolicyBuilder<U, C> {
    return new PolicyBuilder({ ...this.definition, name })
  }
}

/** Builders for one policy kind. Roles are checked against the declared roles; `service` is never allowed. */
export interface PolicyBuilders<T extends PolicyTypes = Registered> {
  read(...roles: readonly PolicyRole<T>[]): PolicyBuilder
  insert(...roles: readonly PolicyRole<T>[]): PolicyBuilder
  update(...roles: readonly PolicyRole<T>[]): PolicyBuilder
  delete(...roles: readonly PolicyRole<T>[]): PolicyBuilder
  ops(ops: readonly Operation[], ...roles: readonly PolicyRole<T>[]): PolicyBuilder
}

/** A policy in a {@link collection} list: a builder or a definition in authoring form. */
export type PolicyItem = PolicyBuilder | PolicyDefinition

/** Options accepted by {@link collection}, typed by the collection's document type when one is declared. */
export interface CollectionOptions<
  T extends PolicyTypes = Registered,
  Doc = Readonly<Record<string, unknown>>,
  P extends readonly PolicyItem[] = readonly PolicyItem[],
> {
  readonly exposed?: boolean
  readonly realtime?: boolean
  readonly policies?: P & CheckPolicies<P, Doc>
  readonly fields?: TypedCollectionFields<T, Doc>
  readonly immutable?: readonly Path<Doc>[]
}

/**
 * The policy DSL, typed by a set of {@link PolicyTypes}. The functions exported by `canopy.js/policy` are
 * this kit typed by the project's `Register` declaration; {@link createPolicyKit} gives the same functions
 * typed by explicit types, for repositories that hold several Canopy projects.
 */
export interface PolicyKit<T extends PolicyTypes = Registered> {
  /**
   * Refers to a claim of the verified JWT, for example `auth("sub")` or `auth("org_ids")`. With a coercion
   * the value is converted first, for example `auth("sub", "objectId")` for an `ObjectId` field; a value
   * that cannot be converted makes the policy not match.
   */
  auth<P extends ClaimPath<T>>(path: P): Claim<ClaimValue<T, P>>
  auth<P extends ClaimPath<T>, A extends ClaimCoercion>(
    path: P,
    as: A,
  ): Claim<Coerced<ClaimValue<T, P>, A>>
  /** Refers to a declared context lookup, for example `ctx("projectIds")`. It resolves to a list. */
  ctx<N extends ContextName<T>>(name: N): Ctx<ContextValue<T, N>>
  /** Refers to the request time, optionally shifted by an ISO 8601 duration such as `'-P7D'`. */
  now(offset?: string): Now
  /** Builders for permissive policies (OR combined). */
  readonly allow: PolicyBuilders<T>
  /** Builders for restrictive policies (AND combined). */
  readonly restrict: PolicyBuilders<T>
  /**
   * Declares the policies of a collection. Unnamed policies get a stable name from their position, so the
   * result round trips losslessly through the stored form.
   */
  collection<
    const N extends CollectionName<T>,
    const P extends readonly PolicyItem[] = readonly PolicyItem[],
  >(
    name: N,
    options?: CollectionOptions<T, DocumentOf<T, N>, P>,
  ): CollectionPolicies
  /** Declares context lookups. */
  context<const L extends Readonly<Record<string, ContextLookup>>>(
    lookups: L & CheckLookups<T, L>,
  ): L
}

function authVariable(path: string, as?: ClaimCoercion): AuthVariable {
  return as === undefined ? { $auth: path } : { $auth: path, as }
}

function ctxVariable(name: string): CtxVariable {
  return { $ctx: name }
}

function nowVariable(offset?: string): NowVariable {
  return { $now: offset === undefined ? {} : { offset } }
}

function builders(kind: PolicyKind): PolicyBuilders<PolicyTypes & { roles: string }> {
  const make = (ops: readonly Operation[], roles: readonly string[]): PolicyBuilder =>
    new PolicyBuilder({ name: "", kind, ops: [...ops], roles: [...roles] })
  return {
    read: (...roles) => make(["read"], roles),
    insert: (...roles) => make(["insert"], roles),
    update: (...roles) => make(["update"], roles),
    delete: (...roles) => make(["delete"], roles),
    ops: (ops, ...roles) => make(ops, roles),
  }
}

interface UntypedOptions {
  readonly exposed?: boolean
  readonly realtime?: boolean
  readonly policies?: readonly PolicyItem[]
  readonly fields?: CollectionFields
  readonly immutable?: readonly string[]
}

function collectionOf(name: string, options: UntypedOptions = {}): CollectionPolicies {
  const policies = (options.policies ?? []).map((item, index) => {
    const definition = item instanceof PolicyBuilder ? item.definition : item
    return definition.name === ""
      ? { ...definition, name: `${definition.kind} ${definition.ops.join("+")} #${index + 1}` }
      : definition
  })
  return {
    collection: name,
    exposed: options.exposed ?? false,
    realtime: options.realtime ?? false,
    policies,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(options.immutable === undefined ? {} : { immutable: options.immutable }),
  }
}

function contextOf(lookups: ContextDefinitions): ContextDefinitions {
  return lookups
}

const runtime = {
  auth: authVariable,
  ctx: ctxVariable,
  now: nowVariable,
  allow: builders("permissive"),
  restrict: builders("restrictive"),
  collection: collectionOf,
  context: contextOf,
}

/**
 * Returns the policy DSL typed by explicit types instead of the `Register` declaration. The functions are
 * the same as the top level exports and produce the same JSON.
 */
export function createPolicyKit<T extends PolicyTypes>(): PolicyKit<T>
export function createPolicyKit(): PolicyKit<PolicyTypes> {
  return runtime as PolicyKit<PolicyTypes>
}

const kit: PolicyKit = createPolicyKit<Registered>()

/** Refers to a claim of the verified JWT, for example `auth("sub")` or `auth("sub", "objectId")`. */
export const auth: PolicyKit["auth"] = kit.auth

/** Refers to a declared context lookup, for example `ctx("projectIds")`. */
export const ctx: PolicyKit["ctx"] = kit.ctx

/** Refers to the request time, optionally shifted by an ISO 8601 duration such as `'-P7D'`. */
export const now: PolicyKit["now"] = kit.now

/** Builders for permissive policies (OR combined). */
export const allow: PolicyBuilders = kit.allow

/** Builders for restrictive policies (AND combined). */
export const restrict: PolicyBuilders = kit.restrict

/**
 * Declares the policies of a collection. Unnamed policies get a stable name from their position, so the
 * result round trips losslessly through the stored form.
 */
export const collection: PolicyKit["collection"] = kit.collection

/** Declares context lookups. */
export const context: PolicyKit["context"] = kit.context
