import type { ObjectId } from "../../protocol/index.ts"
import type { Builder, Fields, InsertObjectOf, ObjectOf, TypeOf } from "./fields.ts"

type Prettify<T> = { [K in keyof T]: T[K] } & {}

/** The `_id` builder of a set of fields: the one declared, or an ObjectId the client generates. */
export type IdBuilderOf<F> = F extends { readonly _id: infer B }
  ? B
  : Builder<ObjectId, false, false, true>

type IdGenerated<B> = B extends { readonly "~type"?: { readonly filled: true } }
  ? true
  : B extends { readonly "~type"?: { readonly autoId: true } }
    ? true
    : false

/** A stored document of a collection with fields `F`. */
export type DocOf<F> = Prettify<{ _id: TypeOf<IdBuilderOf<F>> } & ObjectOf<Omit<F, "_id">>>

/**
 * What an insert into a collection with fields `F` accepts: `_id` is optional when the client generates it
 * (ObjectId, UUID, or a builder with `.generate()`), and so are fields with a default.
 */
export type NewDocOf<F> = Prettify<
  (IdGenerated<IdBuilderOf<F>> extends true
    ? { _id?: TypeOf<IdBuilderOf<F>> }
    : { _id: TypeOf<IdBuilderOf<F>> }) &
    InsertObjectOf<Omit<F, "_id">>
>

type OptionalKeys<F> = {
  [K in keyof F]: F[K] extends { readonly isOptional: true } ? K : never
}[keyof F]

/**
 * A merge patch of a collection with fields `F`: every field but `_id` may be given, and `null` removes a field
 * that may be absent.
 */
export type PatchOf<F> = Prettify<{
  [K in Exclude<keyof F, "_id">]?: K extends OptionalKeys<F> ? TypeOf<F[K]> | null : TypeOf<F[K]>
}>

/** The types of one collection, as the client reads them. */
export interface CollectionTypesOf<F extends Fields> {
  readonly Document: DocOf<F>
  readonly Insert: NewDocOf<F>
  readonly Patch: PatchOf<F>
}
