/** The BSON value types a schema distinguishes. `uuid` is binary data of subtype 4. */
export type ScalarType =
  | "string"
  | "double"
  | "int"
  | "long"
  | "decimal"
  | "bool"
  | "date"
  | "objectId"
  | "binData"
  | "uuid"
  | "null"
  | "timestamp"
  | "regex"
  | "minKey"
  | "maxKey"
  | "javascript"

/** The shape of a value. */
export type Shape =
  | { readonly kind: "any" }
  | {
      readonly kind: "scalar"
      readonly type: ScalarType
      /** For strings: the only values that occur, when they form a small closed set. */
      readonly values?: readonly string[]
    }
  | {
      readonly kind: "object"
      readonly fields: Readonly<Record<string, Field>>
      /** Whether fields beyond `fields` may occur. */
      readonly open: boolean
    }
  | { readonly kind: "array"; readonly items: Shape }
  | { readonly kind: "union"; readonly of: readonly Shape[] }

/** A field of an object shape. */
export interface Field {
  readonly shape: Shape
  readonly required: boolean
}

/** An object shape. */
export type ObjectShape = Extract<Shape, { kind: "object" }>

/** Where a collection schema comes from, in priority order. */
export type SchemaSource = "validator" | "config" | "inferred"

/** The schema of one collection. */
export interface CollectionSchema {
  readonly name: string
  readonly shape: ObjectShape
  readonly source: SchemaSource
  /** For inferred schemas, how many documents were sampled. */
  readonly sampled?: number
}

/** The shape that admits any value. */
export const ANY: Shape = { kind: "any" }

/** Builds a union, flattening nested unions and collapsing to `any` when any member is `any`. */
export function union(shapes: readonly Shape[]): Shape {
  const flat: Shape[] = []
  for (const shape of shapes) {
    if (shape.kind === "any") return ANY
    if (shape.kind === "union") flat.push(...shape.of)
    else flat.push(shape)
  }
  if (flat.length === 0) return ANY
  if (flat.length === 1) return flat[0] as Shape
  return { kind: "union", of: flat }
}

/** Lists the members of a shape: the shapes of a union, or the shape itself. */
export function members(shape: Shape): readonly Shape[] {
  return shape.kind === "union" ? shape.of : [shape]
}
