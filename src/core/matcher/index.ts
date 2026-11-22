import { type CompiledFilter, compileFilterWith, isMatcherSafeWith } from "./filter.ts"
import { compileRegex } from "./regex.ts"
import { applyUpdateWith, type UpdateOptions } from "./update.ts"

export {
  Bracket,
  type BsonType,
  bracketOf,
  bsonTypeOf,
  compareStrings,
  compareValues,
  valuesEqual,
} from "./compare.ts"
export { equalityKey } from "./equality-key.ts"
export { UnsupportedQueryError, UpdateError } from "./errors.ts"
export type { CompiledFilter, DocTest } from "./filter.ts"
export { compareNumeric, isInt32, type NumericValue, readNumeric } from "./numeric.ts"
export { anyPathValue, isArrayIndex, type LeafTest, splitPath } from "./path.ts"
export {
  buildTree,
  type CompiledProjection,
  compileProjection,
  exclusion,
  inclusion,
  type ProjectionTree,
} from "./projection.ts"
export { compileRegex, isLinearRegex, type LinearRegex, REGEX_LIMITS } from "./regex.ts"
export {
  type CompiledSort,
  compileSort,
  compileSortKeys,
  type DocComparator,
  type DocSortKey,
  parseSort,
  type SortKey,
  sortKeyOf,
  withIdTieBreaker,
} from "./sort.ts"
export { isOperatorUpdate, UPDATE_OPERATORS, type UpdateOptions } from "./update.ts"

/**
 * Compiles a MongoDB query filter into a document test. Supports the matcher safe operators: comparisons,
 * `$in`/`$nin`, `$exists`, `$type`, logical operators, `$all`, `$elemMatch`, `$size`, `$mod` and linear
 * time `$regex`. Throws `UnsupportedQueryError` for valid constructs the matcher does not evaluate, and
 * `InvalidQueryError` for filters MongoDB would reject.
 */
export function compileFilter(filter: unknown): CompiledFilter {
  return compileFilterWith(filter, compileRegex)
}

/** Returns true when every operator in `filter` can be evaluated in process. */
export function isMatcherSafe(filter: unknown): boolean {
  return isMatcherSafeWith(filter, compileRegex)
}

/**
 * Applies a MongoDB update (operators or a replacement document) to a copy of `doc`, following MongoDB 5.0
 * and later semantics, including lexicographic processing of new fields. The input is never modified.
 * Throws `UpdateError` where MongoDB would reject the update.
 */
export function applyUpdate(
  doc: Record<string, unknown>,
  update: unknown,
  options: UpdateOptions = {},
): Record<string, unknown> {
  return applyUpdateWith(doc, update, options, compileRegex)
}
