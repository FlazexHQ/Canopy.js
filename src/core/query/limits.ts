/** Limits applied to untrusted queries. */
export interface QueryLimits {
  /** Maximum nesting of documents and arrays in a filter or update. */
  readonly maxDepth: number
  /** Maximum number of keys and array elements in one query. */
  readonly maxNodes: number
  /** Maximum number of values in `$in`, `$nin` and `$all`. */
  readonly maxInList: number
  /** Maximum length of a regular expression pattern. */
  readonly maxRegexLength: number
  /** Maximum length of a field path. */
  readonly maxPathLength: number
  /** Maximum number of sort keys. */
  readonly maxSortKeys: number
  /** Maximum number of projected paths. */
  readonly maxProjectionPaths: number
  /** Maximum `limit` a caller may request. */
  readonly maxLimit: number
}

/** Defaults for user supplied queries. */
export const DEFAULT_LIMITS: QueryLimits = {
  maxDepth: 16,
  maxNodes: 10_000,
  maxInList: 1000,
  maxRegexLength: 1024,
  maxPathLength: 512,
  maxSortKeys: 8,
  maxProjectionPaths: 200,
  maxLimit: 1000,
}

/** Limits for policy `using` clauses, which run in process on every candidate event. */
export const USING_LIMITS: QueryLimits = {
  ...DEFAULT_LIMITS,
  maxDepth: 12,
  maxRegexLength: 256,
}
