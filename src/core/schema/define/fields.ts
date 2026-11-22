import {
  type Binary,
  type Decimal128,
  decode,
  type Long,
  type ObjectId,
  ObjectId as ObjectIdClass,
  uuidv7,
} from "../../protocol/index.ts"
import { ANY, type Field, type ObjectShape, type ScalarType, type Shape, union } from "../shape.ts"

/**
 * One field of a collection definition, made by the builders on {@link t}. It carries its TypeScript type
 * (`T`), whether the field may be absent from a stored document (`Optional`) and whether an insert may leave
 * it out because the client fills it in (`Filled`, from `.default()` or `.generate()`).
 */
export interface FieldBuilder<
  T = unknown,
  Optional extends boolean = boolean,
  Filled extends boolean = boolean,
  AutoId extends boolean = boolean,
> {
  /** The shape of the field's value, as sampling, `$jsonSchema` conversion and Studio read it. */
  readonly shape: Shape
  /** Whether the field may be absent from a stored document. */
  readonly isOptional: Optional
  /** Fills the field in for an insert that leaves it out (from `.default()` or `.generate()`). */
  readonly fill: (() => unknown) | undefined
  /** For `t.object()`: the subdocument's fields, whose defaults an insert fills in too. */
  readonly fields: Fields | undefined
  /** The type the field carries, and whether the client generates it as `_id`; never present at runtime. */
  readonly "~type"?: { readonly value: T; readonly filled: Filled; readonly autoId: AutoId }
}

/** A field builder with its modifiers. */
export interface Builder<
  T,
  Optional extends boolean = false,
  Filled extends boolean = false,
  AutoId extends boolean = false,
> extends FieldBuilder<T, Optional, Filled, AutoId> {
  /** The field may be absent from a stored document. */
  optional(): Builder<T, true, Filled, AutoId>
  /** The value may be `null`. */
  nullable(): Builder<T | null, Optional, Filled, false>
  /**
   * The field may be left out of an insert: the client fills in `value` before the optimistic apply. Arrays
   * and plain objects are copied for each insert.
   */
  default(value: T): Builder<T, Optional, true>
  /** The field may be left out of an insert: the client calls `create` for each insert that omits it. */
  generate(create: () => T): Builder<T, Optional, true>
}

/** The fields of a collection or subdocument. */
export type Fields = Readonly<Record<string, FieldBuilder>>

/** The type a field builder carries. */
export type TypeOf<B> = B extends { readonly "~type"?: { readonly value: infer T } } ? T : never

type Prettify<T> = { [K in keyof T]: T[K] } & {}

type OptionalKeys<F> = {
  [K in keyof F]: F[K] extends { readonly isOptional: true } ? K : never
}[keyof F]
type InsertOptionalKeys<F> = {
  [K in keyof F]: F[K] extends { readonly isOptional: true }
    ? K
    : F[K] extends { readonly "~type"?: { readonly filled: true } }
      ? K
      : never
}[keyof F]

/** The object type of a set of fields: optional fields become optional properties. */
export type ObjectOf<F> = Prettify<
  { [K in Exclude<keyof F, OptionalKeys<F>>]: TypeOf<F[K]> } & {
    [K in OptionalKeys<F>]?: TypeOf<F[K]>
  }
>

/** What an insert accepts for a set of fields: fields with a default or a generator are optional too. */
export type InsertObjectOf<F> = Prettify<
  { [K in Exclude<keyof F, InsertOptionalKeys<F>>]: TypeOf<F[K]> } & {
    [K in InsertOptionalKeys<F>]?: TypeOf<F[K]>
  }
>

function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy)
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
  return value
}

function builder<
  T,
  Optional extends boolean,
  Filled extends boolean,
  AutoId extends boolean = false,
>(
  shape: Shape,
  optional: Optional,
  fill: (() => unknown) | undefined,
  fields?: Fields,
): Builder<T, Optional, Filled, AutoId> {
  return Object.freeze({
    shape,
    isOptional: optional,
    fill,
    fields,
    optional() {
      return builder<T, true, Filled, AutoId>(shape, true, fill, fields)
    },
    nullable() {
      return builder<T | null, Optional, Filled, false>(
        union([shape, { kind: "scalar", type: "null" }]),
        optional,
        fill,
        fields,
      )
    },
    default(value: T) {
      return builder<T, Optional, true>(shape, optional, () => copy(value), fields)
    },
    generate(create: () => T) {
      if (typeof create !== "function")
        throw new TypeError("generate() takes a function that returns a new value")
      return builder<T, Optional, true>(shape, optional, create, fields)
    },
  }) as unknown as Builder<T, Optional, Filled, AutoId>
}

function scalar<T, AutoId extends boolean = false>(
  type: ScalarType,
): Builder<T, false, false, AutoId> {
  return builder<T, false, false, AutoId>({ kind: "scalar", type }, false, undefined)
}

/** Checks field names: MongoDB reserves a leading `$`, and a `.` would read as a path. */
export function checkFields<F extends Fields>(fields: F): F {
  for (const name of Object.keys(fields)) {
    if (name === "" || name.startsWith("$") || name.includes("."))
      throw new TypeError(`${JSON.stringify(name)} is not a valid field name`)
    const field = fields[name]
    if (field === undefined || typeof field !== "object" || !("shape" in field))
      throw new TypeError(`Field ${JSON.stringify(name)} is not a field builder from t`)
  }
  return fields
}

/** Converts a set of fields to the object shape sampling and `$jsonSchema` conversion use. */
export function objectShape(fields: Fields): ObjectShape {
  const out: Record<string, Field> = {}
  for (const name of Object.keys(fields).sort()) {
    const field = fields[name]
    if (field === undefined) continue
    out[name] = { shape: field.shape, required: !field.isOptional }
  }
  return { kind: "object", fields: out, open: true }
}

/** Field builders for collection definitions: `t.string()`, `t.array(t.int()).optional()` and so on. */
export const t: {
  /** An ObjectId. As `_id`, the client generates one when an insert leaves it out. */
  objectId(): Builder<ObjectId, false, false, true>
  string(): Builder<string>
  /** A 32 bit integer. */
  int(): Builder<number>
  /** A double. */
  double(): Builder<number>
  /** A 64 bit integer: a number when it fits a double, otherwise a `Long`. */
  long(): Builder<number | Long>
  decimal(): Builder<Decimal128>
  bool(): Builder<boolean>
  date(): Builder<Date>
  /** A UUID (binary subtype 4). As `_id`, the client generates a UUIDv7 when an insert leaves it out. */
  uuid(): Builder<Binary, false, false, true>
  binary(): Builder<Binary>
  array<B extends FieldBuilder>(items: B): Builder<TypeOf<B>[]>
  /** A subdocument with the given fields. */
  object<F extends Fields>(fields: F): Builder<ObjectOf<F>>
  /** One of a fixed set of strings. */
  enum<const V extends readonly [string, ...string[]]>(values: V): Builder<V[number]>
  /** Any one of the given types. */
  union<B extends readonly [FieldBuilder, ...FieldBuilder[]]>(
    ...members: B
  ): Builder<TypeOf<B[number]>>
  /** Any value. */
  any(): Builder<unknown>
} = Object.freeze({
  objectId: () => scalar<ObjectId, true>("objectId"),
  string: () => scalar<string>("string"),
  int: () => scalar<number>("int"),
  double: () => scalar<number>("double"),
  long: () => scalar<number | Long>("long"),
  decimal: () => scalar<Decimal128>("decimal"),
  bool: () => scalar<boolean>("bool"),
  date: () => scalar<Date>("date"),
  uuid: () => scalar<Binary, true>("uuid"),
  binary: () => scalar<Binary>("binData"),
  array: <B extends FieldBuilder>(items: B) =>
    builder<TypeOf<B>[], false, false>({ kind: "array", items: items.shape }, false, undefined),
  object: <F extends Fields>(fields: F) =>
    builder<ObjectOf<F>, false, false>(objectShape(checkFields(fields)), false, undefined, fields),
  enum: <const V extends readonly [string, ...string[]]>(values: V) => {
    if (values.length === 0 || values.some((value) => typeof value !== "string"))
      throw new TypeError("t.enum() takes one or more strings")
    return builder<V[number], false, false>(
      { kind: "scalar", type: "string", values: [...new Set(values)].sort() },
      false,
      undefined,
    )
  },
  union: <B extends readonly [FieldBuilder, ...FieldBuilder[]]>(...members: B) =>
    builder<TypeOf<B[number]>, false, false>(
      union(members.map((member) => member.shape)),
      false,
      undefined,
    ),
  any: () => builder<unknown, false, false>(ANY, false, undefined),
})

/** The generator of a client generated `_id` type, or `undefined` when the caller supplies the ID. */
export function idGenerator(shape: Shape): (() => unknown) | undefined {
  if (shape.kind !== "scalar") return undefined
  if (shape.type === "objectId") return () => new ObjectIdClass()
  if (shape.type === "uuid") return () => decode({ $uuid: uuidv7() })
  return undefined
}
