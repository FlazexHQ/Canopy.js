/**
 * Removes the slashes at the end of a path: `/rest/v1//` becomes `/rest/v1`. Linear in the length, unlike a
 * `/\/+$/` replacement, which backtracks on long runs of slashes that are not at the end.
 */
export function trimTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1
  return end === path.length ? path : path.slice(0, end)
}
