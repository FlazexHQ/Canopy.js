import { InvalidQueryError, isForbiddenKey } from "../protocol/index.ts"

const POSITIONAL = /^\$(?:\[(?:[a-z][a-zA-Z0-9]*)?\])?$/

/** Options for {@link validatePath}. */
export interface PathOptions {
  /** Allow `$`, `$[]` and `$[identifier]` segments (update paths only). */
  readonly positional?: boolean
  readonly maxLength: number
}

/**
 * Validates a dotted field path from untrusted input: no empty segments, no `$` prefixed segments (except
 * positional operators in updates), no NUL characters and no prototype keys.
 */
export function validatePath(path: string, options: PathOptions): void {
  if (path === "") throw new InvalidQueryError("A field path may not be empty")
  if (path.length > options.maxLength) {
    throw new InvalidQueryError(
      `A field path may not be longer than ${options.maxLength} characters`,
    )
  }
  if (path.includes("\0"))
    throw new InvalidQueryError("A field path may not contain NUL characters")
  for (const segment of path.split(".")) {
    if (segment === "") throw new InvalidQueryError(`Invalid field path: ${path}`)
    if (isForbiddenKey(segment))
      throw new InvalidQueryError(`The field name "${segment}" is not allowed`)
    if (segment.startsWith("$")) {
      if (options.positional === true && POSITIONAL.test(segment)) continue
      throw new InvalidQueryError(`Invalid field path: ${path}`)
    }
  }
}

/** Removes positional segments (`$`, `$[]`, `$[identifier]`) from an update path. */
export function normalizePositional(path: string): string {
  return path
    .split(".")
    .filter((segment) => !POSITIONAL.test(segment))
    .join(".")
}

/**
 * Returns true when path `a` equals `b`, lies beneath it, or is an ancestor of it. Field rules use this to
 * decide whether a write to `a` touches `b`.
 */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

/** Returns true when `path` equals `ancestor` or lies beneath it. */
export function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`)
}

const INDEX_SEGMENT = /(?:^|\.)(?:0|[1-9]\d*)(?:\.|$)/

/** Removes array index segments, so `items.3.price` and `items.price` refer to the same field rule. */
export function stripIndexes(path: string): string {
  if (!INDEX_SEGMENT.test(path)) return path
  return path
    .split(".")
    .filter((segment) => !/^(?:0|[1-9]\d*)$/.test(segment))
    .join(".")
}
