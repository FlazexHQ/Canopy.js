import { readFileSync } from "node:fs"

import { svelte } from "@sveltejs/vite-plugin-svelte"
import { type Alias, defineConfig, defineProject } from "vitest/config"

/**
 * Tests import the package by its own name (`canopy.js`, `canopy.js/react`, ...), so they exercise the
 * public entry points. Each one is aliased to its source file under the `canopy-js-source` condition of the
 * exports map, so tests run without a build. Under Deno, a setup file fills in a worker API that Vitest's
 * thread pool needs (run Deno with `--pool=threads`).
 */
const manifest: { exports: Record<string, unknown> } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
)

const aliases: Alias[] = Object.entries(manifest.exports)
  .flatMap(([subpath, target]): Alias[] => {
    if (typeof target !== "object" || target === null) return []
    const source: unknown = (target as Record<string, unknown>)["canopy-js-source"]
    if (typeof source !== "string") return []
    const name = subpath === "." ? "canopy.js" : `canopy.js/${subpath.slice(2)}`
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    return [
      { find: new RegExp(`^${escaped}$`), replacement: new URL(source, import.meta.url).pathname },
    ]
  })
  .map((alias) => ({
    ...alias,
    replacement:
      process.platform === "win32" ? alias.replacement.replace(/^\//, "") : alias.replacement,
  }))

const resolve = {
  alias: aliases,
  conditions: ["canopy-js-source", "module", "browser", "development|production"],
}
const ssr = {
  resolve: { conditions: ["canopy-js-source", "node", "module", "development|production"] },
}

const setupFiles =
  "Deno" in globalThis ? [new URL("./vitest.deno-setup.ts", import.meta.url).pathname] : []

function project(name: string, environment: "node" | "happy-dom", include: string[]) {
  return defineProject({
    resolve,
    ssr,
    test: { name, environment, include, setupFiles },
  })
}

export default defineConfig({
  test: {
    projects: [
      defineProject({
        resolve,
        ssr,
        test: {
          name: "client",
          include: ["test/client/**/*.test.ts"],
          testTimeout: 30_000,
          setupFiles,
        },
      }),
      project("cli", "node", ["test/cli/**/*.test.ts"]),
      project("react", "happy-dom", ["test/react/**/*.test.tsx"]),
      project("vue", "happy-dom", ["test/vue/**/*.test.ts"]),
      defineProject({
        plugins: [svelte({ configFile: false })],
        resolve,
        ssr,
        test: {
          name: "svelte",
          environment: "happy-dom",
          include: ["test/svelte/**/*.test.ts"],
          setupFiles,
        },
      }),
      project("solid", "happy-dom", ["test/solid/**/*.test.ts"]),
      project("tanstack-db", "node", ["test/tanstack-db/**/*.test.ts"]),
      project("devtools", "happy-dom", ["test/devtools/**/*.test.ts"]),
    ],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/core/**"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        "src/client/**": { lines: 85, branches: 70 },
        "src/vue/**": { lines: 98, branches: 70 },
        "src/svelte/**": { lines: 98, branches: 98 },
        "src/solid/**": { lines: 98, branches: 98 },
      },
    },
  },
})
