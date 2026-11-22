import type { Document } from "../core/protocol/index.ts"
import type { CollectionTypes, IdOf, UntypedSchema } from "./types.ts"

/**
 * Registers the app's schema with the SDK. The schema file augments it once, and `createClient`, the REST
 * client, the framework bindings and the helper types are typed from it with no generic parameter:
 *
 * ```ts
 * declare module "canopy.js" {
 *   interface Register {
 *     schema: typeof schema
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by the app's schema file
export interface Register {}

/**
 * What the client reads from a collection definition of `canopy.js/schema`, so the client does not
 * depend on the schema package at runtime.
 */
export interface CollectionDefinitionLike {
  readonly name: string
  /** The document an insert stores: defaults filled in and a generated `_id` added where needed. */
  prepare(doc: object): Record<string, unknown>
  /** The document, insert and patch types; never present at runtime. */
  readonly "~types"?: {
    readonly Document: object
    readonly Insert: object
    readonly Patch: object
  }
}

/** A schema from `defineSchema()`: collection definitions keyed by name. */
export type SchemaDefinitionLike = { readonly [name: string]: CollectionDefinitionLike }

/** The schema registered through {@link Register}, or `undefined` when none is. */
export type RegisteredSchema = Register extends {
  readonly schema: infer S extends SchemaDefinitionLike
}
  ? S
  : undefined

/** The client's per collection types (`Document` and `Insert`) of a schema definition. */
export type SchemaTypes<S extends SchemaDefinitionLike> = {
  readonly [K in keyof S]: NonNullable<S[K]["~types"]> extends infer T extends CollectionTypes
    ? T
    : CollectionTypes
}

/** The client types used when no type argument is given: the registered schema's, or untyped. */
export type DefaultSchema = [RegisteredSchema] extends [undefined]
  ? UntypedSchema
  : SchemaTypes<Extract<RegisteredSchema, SchemaDefinitionLike>>

/** The schema definition the helper types resolve against: the registered one, or any collection. */
export type ResolvedSchema = [RegisteredSchema] extends [undefined]
  ? UntypedDefinition
  : Extract<RegisteredSchema, SchemaDefinitionLike>

/** The definition of an untyped client: any collection, any document. */
export type UntypedDefinition = {
  readonly [name: string]: {
    readonly name: string
    prepare(doc: object): Record<string, unknown>
    readonly "~types"?: {
      readonly Document: Document
      readonly Insert: Document
      readonly Patch: Document
    }
  }
}

type TypesOf<S extends SchemaDefinitionLike, C extends keyof S> = NonNullable<S[C]["~types"]>

/**
 * A stored document of collection `C`: `Doc<"todos">`. Pass a schema as `S` where the registered one does
 * not apply, such as in a library or an app with two Canopy backends.
 */
export type Doc<
  C extends keyof S & string,
  S extends SchemaDefinitionLike = ResolvedSchema,
> = TypesOf<S, C>["Document"]

/** The `_id` type of collection `C`: `Id<"todos">`. */
export type Id<C extends keyof S & string, S extends SchemaDefinitionLike = ResolvedSchema> = IdOf<
  Doc<C, S>
>

/** What an insert into `C` accepts: generated IDs and fields with a default are optional. */
export type NewDoc<
  C extends keyof S & string,
  S extends SchemaDefinitionLike = ResolvedSchema,
> = TypesOf<S, C>["Insert"]

/** A merge patch of `C`: every field but `_id` is optional, and `null` removes a field that may be absent. */
export type Patch<
  C extends keyof S & string,
  S extends SchemaDefinitionLike = ResolvedSchema,
> = TypesOf<S, C>["Patch"]

/**
 * The `schema` option of a client: required, and of the registered type, once a schema is registered, so a
 * missing runtime definition is a compiler error rather than a wrong `_id` at runtime.
 */
export type SchemaOption = [RegisteredSchema] extends [undefined]
  ? { readonly schema?: SchemaDefinitionLike }
  : { readonly schema: RegisteredSchema }

/** The schemas a client factory accepts: the registered one once a schema is registered, otherwise any. */
export type SchemaConstraint = [RegisteredSchema] extends [undefined]
  ? SchemaDefinitionLike
  : Extract<RegisteredSchema, SchemaDefinitionLike>

/** Looks up a collection's definition, ignoring inherited properties such as `toString`. */
export function definitionOf(
  schema: SchemaDefinitionLike | undefined,
  collection: string,
): CollectionDefinitionLike | undefined {
  if (schema === undefined || !Object.hasOwn(schema, collection)) return undefined
  return schema[collection]
}
