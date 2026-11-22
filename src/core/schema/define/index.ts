import type { ObjectShape, Shape } from "../shape.ts"
import { checkFields, type FieldBuilder, type Fields, idGenerator, objectShape } from "./fields.ts"
import { type StandardProps, standardProps } from "./standard.ts"
import type { CollectionTypesOf, DocOf } from "./types.ts"

export {
  type Builder,
  type FieldBuilder,
  type Fields,
  type InsertObjectOf,
  type ObjectOf,
  type TypeOf,
  t,
} from "./fields.ts"
export type { StandardIssue, StandardProps, StandardResult } from "./standard.ts"
export type { CollectionTypesOf, DocOf, IdBuilderOf, NewDocOf, PatchOf } from "./types.ts"

/** How a collection's `_id` is assigned. */
export interface IdStrategy {
  /** The shape of `_id`. */
  readonly shape: Shape
  /** Whether the client creates an `_id` for an insert that leaves it out. */
  readonly generated: boolean
}

/** What every collection definition has, whatever its fields: the constraint of a schema's members. */
export interface AnyCollectionDefinition {
  readonly name: string
  readonly fields: Fields
  readonly shape: ObjectShape
  readonly id: IdStrategy
  prepare(doc: object): Record<string, unknown>
  readonly "~standard": StandardProps<unknown, object>
  readonly "~types"?: {
    readonly Document: object
    readonly Insert: object
    readonly Patch: object
  }
}

/**
 * A collection declared in code with {@link collection}. It is a plain, frozen value: the client reads its
 * `_id` strategy and defaults at runtime, and its types reach the SDK through the `Register` interface.
 */
export interface CollectionDefinition<
  N extends string = string,
  F extends Fields = Fields,
> extends AnyCollectionDefinition {
  readonly name: N
  /** The fields as declared, without the implicit `_id`. */
  readonly fields: F
  /** The shape of a stored document, `_id` included, for sampling diffs and `$jsonSchema`. */
  readonly shape: ObjectShape
  readonly id: IdStrategy
  /**
   * The document an insert stores: defaults filled in and a generated `_id` added where the insert leaves
   * them out. Throws a `TypeError` when `_id` is missing and the caller must supply it.
   */
  prepare(doc: object): Record<string, unknown>
  /** Standard Schema validation of a stored (decoded) document. */
  readonly "~standard": StandardProps<unknown, DocOf<F>>
  /** The document, insert and patch types; never present at runtime. */
  readonly "~types"?: CollectionTypesOf<F>
}

/** The collections of an app, keyed by name, as {@link defineSchema} returns them. */
export type SchemaDefinition = { readonly [name: string]: AnyCollectionDefinition }

/** The schema of a list of collections, keyed by their names. */
export type SchemaOf<C extends readonly AnyCollectionDefinition[]> = {
  readonly [D in C[number] as D["name"]]: D
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function fillDefaults(fields: Fields, doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc }
  for (const [name, field] of Object.entries(fields)) {
    if (name === "_id") continue
    const value = out[name]
    if (value === undefined) {
      if (field.fill !== undefined) out[name] = field.fill()
      continue
    }
    if (field.fields !== undefined && isPlainObject(value))
      out[name] = fillDefaults(field.fields, value)
  }
  return out
}

function checkName(name: string): void {
  if (
    typeof name !== "string" ||
    name === "" ||
    name.includes("$") ||
    name.includes("\0") ||
    name.startsWith("system.")
  )
    throw new TypeError(`${JSON.stringify(name)} is not a valid collection name`)
}

/**
 * Declares a collection: `collection("todos", { title: t.string(), done: t.bool().default(false) })`. An
 * omitted `_id` is an ObjectId the client generates; `_id: t.uuid()` generates a UUIDv7, and any other `_id`
 * type must be supplied on insert unless its builder has `.generate()`.
 */
export function collection<const N extends string, const F extends Fields>(
  name: N,
  fields: F,
): CollectionDefinition<N, F> {
  checkName(name)
  checkFields(fields)
  const idField: FieldBuilder | undefined = fields["_id"]
  if (idField?.isOptional === true) throw new TypeError(`The _id of ${name} cannot be optional`)
  const idShape: Shape = idField?.shape ?? { kind: "scalar", type: "objectId" }
  const createId = idField?.fill ?? idGenerator(idShape)
  const shape = objectShape({
    ...fields,
    _id: { shape: idShape, isOptional: false, fill: undefined, fields: undefined },
  })
  return Object.freeze({
    name,
    fields,
    shape,
    id: Object.freeze({ shape: idShape, generated: createId !== undefined }),
    prepare(doc: object): Record<string, unknown> {
      if (!isPlainObject(doc)) throw new TypeError(`An insert into ${name} takes a plain object`)
      const out = fillDefaults(fields, doc)
      if (out["_id"] === undefined) {
        if (createId === undefined)
          throw new TypeError(
            `Documents of ${name} need an _id: the schema has no generator for it`,
          )
        const { _id: _omitted, ...rest } = out
        return { _id: createId(), ...rest }
      }
      return out
    },
    "~standard": standardProps<DocOf<F>>(shape),
  })
}

/** Collects collection definitions into the app's schema, keyed by name. Names must be unique. */
export function defineSchema<const C extends readonly AnyCollectionDefinition[]>(
  ...collections: C
): SchemaOf<C> {
  const out: Record<string, AnyCollectionDefinition> = {}
  for (const definition of collections) {
    if (Object.hasOwn(out, definition.name))
      throw new TypeError(`The schema declares ${definition.name} twice`)
    out[definition.name] = definition
  }
  return Object.freeze(out) as SchemaOf<C>
}

export { toCollectionSchema, toCollectionSchemas } from "./to-shape.ts"
