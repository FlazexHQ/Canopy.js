import { isDocument } from "../protocol/index.ts"

/**
 * The fields a filter template compares by equality on every query: plain values, policy variables and
 * `$eq`/`$in`, at the top level and inside `$and`. Branches of `$or` and `$nor` are left out, since no single
 * index serves them. `_id` is always indexed and is skipped. Used by the `missing-index` lint rule and by
 * `canopy indexes advise`, so both suggest the same indexes.
 */
export function equalityFields(filter: unknown): string[] {
  if (!isDocument(filter)) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" && Array.isArray(value)) {
      for (const part of value) for (const field of equalityFields(part)) out.push(field)
      continue
    }
    if (key.startsWith("$") || key === "_id") continue
    if (!isDocument(value)) out.push(key)
    else if (Object.hasOwn(value, "$auth") || Object.hasOwn(value, "$ctx")) out.push(key)
    else if (Object.hasOwn(value, "$eq") || Object.hasOwn(value, "$in")) out.push(key)
    else if (Object.keys(value).every((name) => !name.startsWith("$"))) out.push(key)
  }
  return [...new Set(out)]
}
