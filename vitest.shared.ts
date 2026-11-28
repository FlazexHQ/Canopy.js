import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

import type { Plugin } from "vite"
import type { Alias } from "vitest/config"

/**
 * Tests import the package by its own name (`canopy.js`, `canopy.js/react`, ...), so they exercise the
 * public entry points. Each one is aliased to its source file under the `canopy-js-source` condition of the
 * exports map, so tests run without a build. `canopy-conformance` names the conformance folder of the Canopy
 * repository (`CANOPY_REPO`, or the clone next to this one), whose recorded MongoDB answers the client
 * tests replay.
 */
const manifest: { exports: Record<string, unknown> } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
)

/** An absolute path with forward slashes, as Vite's resolver and glob imports expect on every platform. */
function slashed(path: string): string {
  return path.replaceAll("\\", "/")
}

const packageAliases: Alias[] = Object.entries(manifest.exports).flatMap(
  ([subpath, target]): Alias[] => {
    if (typeof target !== "object" || target === null) return []
    const source: unknown = (target as Record<string, unknown>)["canopy-js-source"]
    if (typeof source !== "string") return []
    const name = subpath === "." ? "canopy.js" : `canopy.js/${subpath.slice(2)}`
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    return [
      {
        find: new RegExp(`^${escaped}$`),
        replacement: slashed(fileURLToPath(new URL(source, import.meta.url))),
      },
    ]
  },
)

/** The Canopy repository whose conformance cases the client tests replay. */
export const canopyRepo: string = slashed(
  resolvePath(process.env["CANOPY_REPO"] ?? fileURLToPath(new URL("../Canopy", import.meta.url))),
)

export const resolve = {
  alias: [
    ...packageAliases,
    { find: "canopy-conformance", replacement: `${canopyRepo}/conformance` },
  ],
  conditions: ["canopy-js-source", "module", "browser", "development|production"],
}

export const ssr = {
  resolve: { conditions: ["canopy-js-source", "node", "module", "development|production"] },
}

const relativeImport = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"'?]*)\2/g

/**
 * Gives a test fresh copies of modules, with their own state, on every runtime and in browsers, where
 * `vi.resetModules()` cannot reach the browser's module map: a module imported with a `fresh=<n>` query
 * passes the same query on to every module it imports by a relative path (`freshGraph` in
 * `test/support/fresh.ts`).
 */
export function freshModules(): Plugin {
  return {
    name: "canopy:fresh-modules",
    enforce: "post",
    transform(code, id) {
      const token = /[?&](fresh=\d+)/.exec(id)?.[1]
      if (token === undefined) return undefined
      return {
        code: code.replace(
          relativeImport,
          (_match, head: string, quote: string, path: string) =>
            `${head}${quote}${path}?${token}${quote}`,
        ),
        map: null,
      }
    },
  }
}

/** Loads the Rust client core before each test file. */
export const engineSetup: string = slashed(
  fileURLToPath(new URL("./test/support/engine.ts", import.meta.url)),
)
