/**
 * The matcher without the regex translator, for browser bundles. It evaluates the same operators as
 * `@canopy/matcher` with the same results, except that `$regex` (and regular expression values) throw
 * `UnsupportedQueryError`, so callers fall back to the server for those queries. The update engine is the
 * separate entry `@canopy/matcher/update`, so it can be loaded lazily.
 */
import { type CompiledFilter, compileFilterWith, isMatcherSafeWith } from "./filter.ts"

export {
  Bracket,
  type BsonType,
  bracketOf,
  bsonTypeOf,
  compareValues,
  valuesEqual,
} from "./compare.ts"
export { UnsupportedQueryError, UpdateError } from "./errors.ts"
export type { CompiledFilter, DocTest } from "./filter.ts"
export { type CompiledProjection, compileProjection } from "./projection.ts"
export {
  type CompiledSort,
  compileSort,
  compileSortKeys,
  type DocComparator,
  type DocSortKey,
  parseSort,
  type SortKey,
} from "./sort.ts"

/**
 * Compiles a MongoDB query filter into a document test, like `compileFilter` of `@canopy/matcher`, except
 * that `$regex` and regular expression values throw `UnsupportedQueryError`.
 */
export function compileFilter(filter: unknown): CompiledFilter {
  return compileFilterWith(filter, undefined)
}

/** Returns true when every operator in `filter` can be evaluated in process without the regex translator. */
export function isMatcherSafe(filter: unknown): boolean {
  return isMatcherSafeWith(filter, undefined)
}
