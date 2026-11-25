import type {
  Binary,
  BSONRegExp,
  Decimal128,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "../core/protocol/index.ts"
import type { AuthVariable, ClaimCoercion, CtxVariable, NowVariable } from "./dsl.ts"
import type { ContextLookup } from "./model.ts"

/**
 * Declares the types policies are checked against, once per project. Augment it from any file the policies
 * can see:
 *
 * ```ts
 * import type { Database } from "../src/canopy.gen.ts"
 * import type contexts from "./policies/_context.ts"
 *
 * declare module "canopy.js/policy" {
 *   interface Register {
 *     database: Database
 *     claims: { sub: string; org_ids: string[] }
 *     roles: "support" | "staff"
 *     context: typeof contexts
 *   }
 * }
 * ```
 *
 * Every key is optional; a missing key keeps that part untyped. Types only help authors: the server
 * validates and enforces policies the same way with or without them.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by projects
export interface Register {}

/** The shape a {@link Register} declaration or a {@link PolicyKit} is typed with. */
export interface PolicyTypes {
  /** One `{ Document }` entry per collection, such as the `Database` type `canopy gen types` writes. */
  readonly database: object
  /** The claims of the verified JWT. */
  readonly claims: object
  /** The custom roles, besides `anon`, `authenticated` and `public`. */
  readonly roles: string
  /** The context lookups, usually `typeof contexts` of the object `context()` returned. */
  readonly context: object
}

/** The types of an untyped project: any collection, claim, role and lookup. */
export interface UntypedPolicyTypes {
  readonly database: Readonly<
    Record<string, { readonly Document: Readonly<Record<string, unknown>> }>
  >
  readonly claims: Readonly<Record<string, unknown>>
  readonly roles: string
  readonly context: Readonly<Record<string, ContextLookup>>
}

type RegisteredKey<K extends keyof PolicyTypes> = K extends keyof Register
  ? Register[K]
  : UntypedPolicyTypes[K]

/** The types of the project's {@link Register} declaration, with untyped fallbacks for missing keys. */
export interface Registered {
  readonly database: RegisteredKey<"database">
  readonly claims: RegisteredKey<"claims">
  readonly roles: RegisteredKey<"roles"> & string
  readonly context: RegisteredKey<"context">
}

/** Values that are matched as a whole rather than traversed by dotted paths. */
export type Leaf =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Date
  | RegExp
  | Uint8Array
  | ObjectId
  | Long
  | Decimal128
  | Binary
  | Timestamp
  | BSONRegExp
  | MinKey
  | MaxKey

type IsUnknown<V> = unknown extends V ? true : false
type IsWide<T> = string extends keyof T ? true : false

type ElementOf<V> =
  IsUnknown<V> extends true ? unknown : NonNullable<V> extends readonly (infer E)[] ? E : never

type Depth = [never, 0, 1, 2, 3, 4]

/**
 * Every dotted path of a document type, to a depth of 4. Arrays are transparent (`items.title`) and may be
 * indexed (`items.0.title`). An untyped document has the path `string`.
 */
export type Path<T, D extends number = 4> = [D] extends [never]
  ? never
  : T extends Leaf
    ? never
    : T extends readonly (infer E)[]
      ? Path<E, D>
      : {
          [K in keyof T & string]:
            | K
            | (NonNullable<T[K]> extends readonly unknown[]
                ? `${K}.${number}` | `${K}.${number}.${Path<NonNullable<T[K]>, Depth[D]>}`
                : never)
            | `${K}.${Path<NonNullable<T[K]>, Depth[D]>}`
        }[keyof T & string]

/** The value at a dotted path, or `unknown` for paths the type does not describe. */
export type PathValue<T, P extends string> = T extends readonly (infer E)[]
  ? P extends `${number}.${infer Rest}`
    ? PathValue<E, Rest>
    : P extends `${number}`
      ? E
      : PathValue<E, P>
  : P extends `${infer Head}.${infer Rest}`
    ? Head extends keyof T
      ? PathValue<NonNullable<T[Head]>, Rest>
      : unknown
    : P extends keyof T
      ? T[P]
      : unknown

declare const valueType: unique symbol

/**
 * Carries the type a policy variable resolves to. The property never exists at runtime, so a variable is
 * still plain JSON; a variable without it (written by hand, or from an untyped project) matches any field.
 */
export interface Resolves<T> {
  readonly [valueType]?: T
}

/** A claim variable that resolves to `T`. */
export type Claim<T> = AuthVariable & Resolves<T>

/** A context lookup variable that resolves to the list `T`. */
export type Ctx<T> = CtxVariable & Resolves<T>

/** A time variable. */
export type Now = NowVariable & Resolves<Date>

/** Any policy variable that resolves to `T`. */
export type Variable<T> = (AuthVariable | CtxVariable | NowVariable) & Resolves<T>

/** The collection names of a set of policy types. */
export type CollectionName<T extends PolicyTypes> = keyof T["database"] & string

/** The stored document type of a collection, or an open document when it is not typed. */
export type DocumentOf<T extends PolicyTypes, C> = C extends keyof T["database"]
  ? T["database"][C] extends { readonly Document: infer D extends object }
    ? D
    : Readonly<Record<string, unknown>>
  : Readonly<Record<string, unknown>>

/** The roles a policy may name: the built in ones and the declared custom roles, never `service`. */
export type PolicyRole<T extends PolicyTypes> =
  "anon" | "authenticated" | "public" | Exclude<T["roles"], "service">

/** Claim paths a policy may read. `user_metadata` is editable by users, so it is excluded. */
export type ClaimPath<T extends PolicyTypes> = Exclude<
  Path<T["claims"]>,
  "user_metadata" | `user_metadata.${string}`
>

type Wild<V> = IsUnknown<V> extends true ? never : NonNullable<V>

/** The type a claim path holds. Unknown claims give `never`, which matches every field. */
export type ClaimValue<T extends PolicyTypes, P extends string> = Wild<PathValue<T["claims"], P>>

/** The types the claim coercions produce. */
export interface CoercionTypes {
  readonly objectId: ObjectId
  readonly string: string
  readonly number: number
  readonly bool: boolean
  readonly date: Date
  readonly uuid: Binary
}

/** The type of a coerced claim. Coercing a list claim coerces each element. */
export type Coerced<V, A extends ClaimCoercion> = [V] extends [never]
  ? never
  : V extends readonly unknown[]
    ? CoercionTypes[A][]
    : CoercionTypes[A]

/** The names of the declared context lookups. */
export type ContextName<T extends PolicyTypes> = keyof T["context"] & string

type Flatten<V> = NonNullable<V> extends readonly (infer E)[] ? NonNullable<E> : NonNullable<V>

/**
 * The list a context lookup resolves to: the values of its `select` path in the documents of its `from`
 * collection. Untyped lookups give `never`, which matches every field.
 */
export type ContextValue<T extends PolicyTypes, N extends string> = N extends keyof T["context"]
  ? T["context"][N] extends { readonly from: infer F; readonly select: infer S extends string }
    ? IsUnknown<PathValue<DocumentOf<T, F>, S>> extends true
      ? never
      : Flatten<PathValue<DocumentOf<T, F>, S>>[]
    : never
  : never

type Value<V> = V | Variable<V>
type Scalar<V> = V | ElementOf<V>
type List<V> = readonly (Value<V> | null)[] | Variable<readonly V[]>

/** The query operators a policy clause may apply to a field of type `V`. */
export interface PolicyOperators<V> {
  readonly $eq?: Value<Scalar<V>> | null
  readonly $ne?: Value<Scalar<V>> | null
  readonly $gt?: Value<Scalar<V>>
  readonly $gte?: Value<Scalar<V>>
  readonly $lt?: Value<Scalar<V>>
  readonly $lte?: Value<Scalar<V>>
  readonly $in?: List<Scalar<V>>
  readonly $nin?: List<Scalar<V>>
  readonly $all?: List<ElementOf<V>>
  readonly $exists?: boolean
  readonly $type?: string | number | readonly (string | number)[]
  readonly $elemMatch?: PolicyFilter<ElementOf<V>> | PolicyOperators<ElementOf<V>>
  readonly $size?: number
  readonly $mod?: readonly [number, number]
  readonly $regex?: string | RegExp | BSONRegExp
  readonly $options?: string
  readonly $not?: PolicyOperators<V> | RegExp | BSONRegExp
}

/** A condition on a field: a value, a variable of the field's type, `null`, or operators. */
export type PolicyCondition<V> = Value<Scalar<V>> | null | PolicyOperators<V>

/** A `where` or `check` clause checked against a document type. */
export type PolicyFilter<T> = { readonly [P in Path<T>]?: PolicyCondition<PathValue<T, P>> } & {
  readonly $and?: readonly PolicyFilter<T>[]
  readonly $or?: readonly PolicyFilter<T>[]
  readonly $nor?: readonly PolicyFilter<T>[]
  readonly $comment?: string
}

type Logical = "$and" | "$or" | "$nor"

type ValueProblem<K extends string, V, F> =
  V extends Claim<string>
    ? ObjectId extends Flatten<F>
      ? `field '${K}' holds an ObjectId: use auth(path, "objectId")`
      : `field '${K}' does not accept this claim's type`
    : `field '${K}' does not accept this value`

/**
 * The problems of a clause against a document type, as readable strings, or `never` when it is valid.
 * Clauses built from a wide record (`Record<string, unknown>`) are not checked.
 */
export type FilterProblems<F, T> =
  IsWide<F> extends true
    ? never
    : IsWide<T> extends true
      ? never
      : {
          [K in keyof F & string]: K extends Logical
            ? F[K] extends readonly (infer E)[]
              ? E extends unknown
                ? FilterProblems<E, T>
                : never
              : `${K} needs a list of clauses`
            : K extends "$comment" | "$expr"
              ? never
              : K extends Path<T>
                ? F[K] extends PolicyCondition<PathValue<T, K>>
                  ? never
                  : ValueProblem<K, F[K], PathValue<T, K>>
                : `unknown field '${K}'`
        }[keyof F & string]

/** The phantom types a {@link PolicyBuilder} records for checking against a collection. */
export interface ClauseTypes<U, C> {
  readonly using?: U
  readonly check?: C
}

type Problem<Label extends string, P> = [P] extends [never] ? unknown : { readonly [K in Label]: P }

/** Turns the recorded clause types of a policy into an error type when they do not fit the document. */
export type CheckPolicy<B, Doc> = B extends { readonly clauses?: ClauseTypes<infer U, infer C> }
  ? Problem<"Invalid where clause", FilterProblems<U, Doc>> &
      Problem<"Invalid check clause", FilterProblems<C, Doc>>
  : unknown

/** Checks every policy of a list against the collection's document type. */
export type CheckPolicies<P extends readonly unknown[], Doc> = {
  readonly [I in keyof P]: CheckPolicy<P[I], Doc>
}

/** A field rule over the paths of a document type. `'*'` means every field. */
export type TypedFieldRule<Doc> =
  { readonly only: readonly (Path<Doc> | "*")[] } | { readonly omit: readonly (Path<Doc> | "*")[] }

/** Field rules keyed by role, with `default` for roles without an entry. */
export type TypedFieldRules<T extends PolicyTypes, Doc> = {
  readonly [R in PolicyRole<T> | "default"]?: TypedFieldRule<Doc>
}

/** Field level rules of one collection, over its document type. */
export interface TypedCollectionFields<T extends PolicyTypes, Doc> {
  readonly read?: TypedFieldRules<T, Doc>
  readonly write?: TypedFieldRules<T, Doc>
  readonly update?: TypedFieldRules<T, Doc>
}

type LookupProblems<T extends PolicyTypes, L> = L extends {
  readonly from: infer F extends string
  readonly select: infer S extends string
  readonly where: infer W
}
  ? IsWide<T["database"]> extends true
    ? never
    : F extends CollectionName<T>
      ? | (S extends Path<DocumentOf<T, F>> ? never : `select: unknown field '${S}' of '${F}'`)
        | FilterProblems<W, DocumentOf<T, F>>
      : `from: unknown collection '${F}'`
  : never

type TtlProblem<L> = L extends { readonly ttl: infer D extends string }
  ? string extends D
    ? never
    : D extends `${bigint}${"s" | "m" | "h" | "d"}`
      ? never
      : "ttl must look like 30s, 5m, 1h or 1d"
  : never

/** Turns invalid context lookups into an error type. */
export type CheckLookups<T extends PolicyTypes, L> = {
  readonly [N in keyof L]: Problem<
    "Invalid context lookup",
    LookupProblems<T, L[N]> | TtlProblem<L[N]>
  >
}
