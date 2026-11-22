/**
 * The update engine of `@canopy/matcher/lite` as its own entry point, so browser bundles can load it
 * lazily (`import("@canopy/matcher/update")`) and keep it out of the entry chunk. Without the regex
 * translator, `$pull` with a regular expression throws `UnsupportedQueryError`.
 */
import { applyUpdateWith, type UpdateOptions } from "./update.ts"

export { isOperatorUpdate, type UpdateOptions } from "./update.ts"

/**
 * Applies a MongoDB update to a copy of `doc`, like `applyUpdate` of `@canopy/matcher`, except that regular
 * expressions in `$pull` conditions and array filters throw `UnsupportedQueryError`.
 */
export function applyUpdate(
  doc: Record<string, unknown>,
  update: unknown,
  options: UpdateOptions = {},
): Record<string, unknown> {
  return applyUpdateWith(doc, update, options, undefined)
}
