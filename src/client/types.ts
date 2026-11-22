import type {
  Binary,
  BSONRegExp,
  Decimal128,
  Document,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "../core/protocol/index.ts"

/** The types of one collection: a stored document (`Document`) and what an insert accepts (`Insert`). */
export interface CollectionTypes {
  readonly Document: object
  readonly Insert: object
}

/**
 * A database type, such as the `Database` interface `canopy gen types` writes: one {@link CollectionTypes}
 * per collection. Interfaces qualify, since the constraint is mapped over their own keys.
 */
export type Schema<DB> = { readonly [K in keyof DB]: CollectionTypes }

/** The schema of an untyped client: any collection, any document. */
export type UntypedSchema = Record<
  string,
  { readonly Document: Document; readonly Insert: Document }
>

/** A document type with `_id` optional, since inserts may leave it to the client. */
export type WithOptionalId<R> = R extends { readonly _id: infer I }
  ? { [K in keyof R as K extends "_id" ? never : K]: R[K] } & { readonly _id?: I }
  : R

/**
 * Builds a schema from hand written document types: `createClient<DocumentSchema<{ todos: Todo }>>(...)`. Inserts
 * take the document with `_id` optional.
 */
export type DocumentSchema<Documents> = {
  readonly [K in keyof Documents]: {
    readonly Document: Documents[K]
    readonly Insert: WithOptionalId<Documents[K]>
  }
}

/** The collection names of a schema (`string` for an untyped client). */
export type CollectionName<DB> = keyof DB & string

/** The stored document type of a collection. */
export type DocumentOf<DB, C extends keyof DB> = DB[C] extends {
  readonly Document: infer R extends object
}
  ? R
  : Document

/** The insert type of a collection. */
export type InsertOf<DB, C extends keyof DB> = DB[C] extends {
  readonly Insert: infer I extends object
}
  ? I
  : Document

/** The `_id` type of a document, or `unknown` when the document does not declare one. */
export type IdOf<Doc> = Doc extends { readonly _id: infer I } ? I : unknown

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

/** The element type of an array value, with MongoDB's rule that a query on an array matches its elements. */
export type ElementOf<V> =
  IsUnknown<V> extends true ? unknown : NonNullable<V> extends readonly (infer E)[] ? E : never

type Depth = [never, 0, 1, 2, 3, 4]

/**
 * Every dotted path of a document type, to a depth of 4. Arrays are transparent (`items.title`) and may
 * be indexed (`items.0.title`). Deeper paths are not listed; an untyped document has the path `string`.
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

type Scalar<V> = V | ElementOf<V>

/** The query operators that apply to a field of type `V`. */
export interface FieldOperators<V> {
  readonly $eq?: Scalar<V> | null
  readonly $ne?: Scalar<V> | null
  readonly $gt?: Scalar<V>
  readonly $gte?: Scalar<V>
  readonly $lt?: Scalar<V>
  readonly $lte?: Scalar<V>
  readonly $in?: readonly (Scalar<V> | null)[]
  readonly $nin?: readonly (Scalar<V> | null)[]
  readonly $exists?: boolean
  readonly $type?: string | number | readonly (string | number)[]
  readonly $all?: readonly ElementOf<V>[]
  readonly $elemMatch?: Filter<ElementOf<V>> | FieldOperators<ElementOf<V>>
  readonly $size?: number
  readonly $mod?: readonly [number, number]
  readonly $regex?: string | RegExp | BSONRegExp
  readonly $options?: string
  readonly $not?: FieldOperators<V> | RegExp | BSONRegExp
}

/** A condition on a field: a value (or one element of an array field), `null`, or operators. */
export type Condition<V> = Scalar<V> | null | FieldOperators<V>

/** The logical operators allowed at the top of a filter. */
export interface RootOperators<T> {
  readonly $and?: readonly Filter<T>[]
  readonly $or?: readonly Filter<T>[]
  readonly $nor?: readonly Filter<T>[]
  readonly $comment?: string
}

/** A MongoDB filter checked against a document type: unknown fields and wrong value types do not compile. */
export type Filter<T> = { readonly [P in Path<T>]?: Condition<PathValue<T, P>> } & RootOperators<T>

type NumericValue<V> =
  IsUnknown<V> extends true
    ? true
    : NonNullable<V> extends number | Long | Decimal128
      ? true
      : false
type ArrayValue<V> =
  IsUnknown<V> extends true ? true : NonNullable<V> extends readonly unknown[] ? true : false

type NumericPaths<T> = {
  [P in Path<T>]: NumericValue<PathValue<T, P>> extends true ? P : never
}[Path<T>]
type ArrayPaths<T> = {
  [P in Path<T>]: ArrayValue<PathValue<T, P>> extends true ? P : never
}[Path<T>]

type NumberValue = number | Long | Decimal128

/** The update operators, checked against a document type. */
export interface UpdateFilter<T> {
  readonly $set?: { readonly [P in Path<T>]?: PathValue<T, P> }
  readonly $setOnInsert?: { readonly [P in Path<T>]?: PathValue<T, P> }
  readonly $unset?: { readonly [P in Path<T>]?: "" | true | 1 }
  readonly $inc?: { readonly [P in NumericPaths<T>]?: NumberValue }
  readonly $mul?: { readonly [P in NumericPaths<T>]?: NumberValue }
  readonly $min?: { readonly [P in Path<T>]?: PathValue<T, P> }
  readonly $max?: { readonly [P in Path<T>]?: PathValue<T, P> }
  readonly $rename?: { readonly [P in Path<T>]?: string }
  readonly $currentDate?: {
    readonly [P in Path<T>]?: true | { readonly $type: "date" | "timestamp" }
  }
  readonly $push?: {
    readonly [P in ArrayPaths<T>]?: ElementOf<PathValue<T, P>> | Each<ElementOf<PathValue<T, P>>>
  }
  readonly $addToSet?: {
    readonly [P in ArrayPaths<T>]?:
      ElementOf<PathValue<T, P>> | { readonly $each: readonly ElementOf<PathValue<T, P>>[] }
  }
  readonly $pull?: {
    readonly [P in ArrayPaths<T>]?: Condition<ElementOf<PathValue<T, P>>>
  }
  readonly $pullAll?: { readonly [P in ArrayPaths<T>]?: readonly ElementOf<PathValue<T, P>>[] }
  readonly $pop?: { readonly [P in ArrayPaths<T>]?: 1 | -1 }
}

/** The `$each` form of `$push`. */
export interface Each<E> {
  readonly $each: readonly E[]
  readonly $position?: number
  readonly $slice?: number
  readonly $sort?: 1 | -1 | Readonly<Record<string, 1 | -1>>
}

/** A sort specification over the paths of a document type. */
export type Sort<T> = { readonly [P in Path<T>]?: 1 | -1 }

/** A projection over the paths of a document type: all `1` (include) or all `0` (exclude). */
export type Projection<T> = { readonly [P in Path<T>]?: 0 | 1 }

/** A recursive `Partial`, for fields a nested projection only partly includes. */
export type DeepPartial<V> = V extends Leaf
  ? V
  : V extends readonly (infer E)[]
    ? DeepPartial<E>[]
    : { [K in keyof V]?: DeepPartial<V[K]> }

type Head<K> = K extends `${infer H}.${string}` ? H : K
type Dotted<K> = K extends `${string}.${string}` ? K : never
type Flagged<F, Flag> = { [K in keyof F & string]: F[K] extends Flag ? K : never }[keyof F & string]
type Prettify<T> = { [K in keyof T]: T[K] } & {}

/**
 * The document type a projection returns. An inclusion keeps the named fields and `_id` (unless `_id: 0`); a
 * field included only through dotted paths is partial. An exclusion drops the named top level fields, and
 * fields excluded only through dotted paths become partial.
 */
export type Projected<T, F> =
  IsUnknown<T> extends true
    ? T
    : string extends keyof T
      ? T
      : Flagged<F, 1> extends never
        ? Prettify<
            Omit<T, Exclude<Flagged<F, 0>, Dotted<Flagged<F, 0>>> | Head<Dotted<Flagged<F, 0>>>> & {
              [K in Extract<Head<Dotted<Flagged<F, 0>>>, keyof T>]?: DeepPartial<T[K]>
            }
          >
        : Prettify<
            Pick<
              T,
              Extract<
                | Exclude<Flagged<F, 1>, Dotted<Flagged<F, 1>>>
                | (F extends { readonly _id: 0 } ? never : "_id"),
                keyof T
              >
            > & {
              [
                K in Exclude<
                  Extract<Head<Dotted<Flagged<F, 1>>>, keyof T>,
                  Exclude<Flagged<F, 1>, Dotted<Flagged<F, 1>>>
                >
              ]?: DeepPartial<T[K]>
            }
          >

/**
 * The documents a read returns for the projection `F`: the whole document without one, {@link Projected}
 * for a literal projection, and a deep partial document for a projection only known at runtime.
 */
export type ProjectedResult<T, F> = [F] extends [never]
  ? T
  : [F] extends [undefined]
    ? T
    : Projection<T> extends F
      ? DeepPartial<T>
      : Projected<T, NonNullable<F>>

/**
 * Rejects a literal projection that mixes inclusion (`1`) and exclusion (`0`), which MongoDB refuses; only
 * `_id` may differ from the other fields.
 */
export type ConsistentProjection<F> = [Flagged<Omit<F, "_id">, 1>] extends [never]
  ? unknown
  : [Flagged<Omit<F, "_id">, 0>] extends [never]
    ? unknown
    : { readonly "A projection cannot mix inclusion and exclusion": never }
