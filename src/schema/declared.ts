import type { AnyCollectionDefinition } from "./index.ts"

/** Where `defineSchema` keeps its collections in declaration order, duplicates included. */
export const DECLARED: unique symbol = Symbol.for("canopy.schema.declared")

/** The collections a schema declared, in order; `undefined` for a value `defineSchema` did not return. */
export function declaredCollections(
  schema: object,
): readonly AnyCollectionDefinition[] | undefined {
  const declared: unknown = (schema as { [DECLARED]?: unknown })[DECLARED]
  return Array.isArray(declared) ? (declared as readonly AnyCollectionDefinition[]) : undefined
}
