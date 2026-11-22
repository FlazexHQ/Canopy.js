import { canonicalString, isDocument } from "../protocol/index.ts"
import type { Compiled } from "./engine.ts"

const LOGICAL = new Set(["$and", "$or", "$nor"])

/** Splits a filter into the conditions that must all hold: `$and` elements and one entry per field. */
function conjuncts(filter: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" && Array.isArray(value)) {
      for (const part of value) {
        if (!isDocument(part)) return [filter]
        out.push(...conjuncts(part))
      }
    } else out.push({ [key]: value })
  }
  return out
}

/**
 * Adds the top level fields a filter reads to `fields`. Returns false when the filter has an operator whose
 * field references cannot be read from its keys, such as `$expr` or `$where`.
 */
function collectFields(filter: Record<string, unknown>, fields: Set<string>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$comment") continue
    if (LOGICAL.has(key)) {
      if (!Array.isArray(value)) return false
      for (const part of value) if (!isDocument(part) || !collectFields(part, fields)) return false
      continue
    }
    if (key.startsWith("$")) return false
    fields.add(key.split(".")[0] ?? key)
  }
  return true
}

/**
 * Whether an update can skip evaluating `check` because every document it can produce already satisfies
 * it. That holds when each condition of `check` is also a condition of `target`, so the matched document
 * satisfied the check before the write, and the update writes no top level field the check reads, so the
 * written document still does. `written` are the paths the update writes. Anything this cannot decide
 * counts as not implied, so the check is then evaluated as usual.
 */
export function checkImplied(
  check: Compiled,
  target: Compiled,
  written: readonly string[],
): boolean {
  if (check.kind === "all") return true
  if (check.kind === "deny" || target.kind !== "filter") return false
  const required = new Set(conjuncts(target.filter).map((part) => canonicalString(part)))
  const fields = new Set<string>()
  for (const part of conjuncts(check.filter)) {
    if (!required.has(canonicalString(part))) return false
    if (!collectFields(part, fields)) return false
  }
  return written.every((path) => !fields.has(path.split(".")[0] ?? path))
}
