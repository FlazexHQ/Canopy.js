import type { CollectionSchema } from "../shape.ts"
import type { AnyCollectionDefinition, SchemaDefinition } from "./index.ts"

/** A collection definition as the `CollectionSchema` that sampling diffs and `$jsonSchema` conversion read. */
export function toCollectionSchema(definition: AnyCollectionDefinition): CollectionSchema {
  return { name: definition.name, shape: definition.shape, source: "config" }
}

/** Every collection of a schema as a `CollectionSchema`, ordered by name. */
export function toCollectionSchemas(schema: SchemaDefinition): CollectionSchema[] {
  return Object.values(schema)
    .map(toCollectionSchema)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
