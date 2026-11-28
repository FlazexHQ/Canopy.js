const fixtures = import.meta.glob<unknown>("canopy-conformance/matcher/*.json", {
  import: "default",
})

/**
 * Reads one recorded matcher fixture of Canopy's conformance suite (`filters`, `sorts`, `projections` or
 * `updates`), through Vite's module graph so the same code runs on Bun, Node.js, Deno and in browsers.
 * Throws when the Canopy repository is missing, so its cases are never skipped silently.
 */
export async function matcherFixture(name: string): Promise<unknown> {
  const load = Object.entries(fixtures).find(([path]) =>
    path.endsWith(`/matcher/${name}.json`),
  )?.[1]
  if (load === undefined)
    throw new Error(
      `The conformance fixture matcher/${name}.json was not found: clone Canopy next to this repository or set CANOPY_REPO`,
    )
  return load()
}
