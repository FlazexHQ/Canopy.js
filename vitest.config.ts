import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig, defineProject } from "vitest/config"

import { engineSetup, freshModules, resolve, ssr } from "./vitest.shared.ts"

/**
 * The suites on Bun, Node.js and Deno. A setup file loads the Rust client core before each test file.
 * Under Deno, another fills in a worker API that Vitest's thread pool needs (run Deno with
 * `--pool=threads`). `vitest.browser.config.ts` runs the client and binding suites in real browsers.
 *
 * Under happy-dom, Vite resolves the core's WebAssembly file to a development server URL that nothing
 * serves here, so those suites run on the core's JavaScript translation, and say so with
 * `CANOPY_TEST_CORE`; the browser run covers them on WebAssembly.
 */
const runtimeSetup =
  "Deno" in globalThis ? [new URL("./vitest.deno-setup.ts", import.meta.url).pathname] : []
const setupFiles = [...runtimeSetup, engineSetup]
const domEnv = { CANOPY_TEST_CORE: "js" }

function project(name: string, environment: "node" | "happy-dom", include: string[]) {
  return defineProject({
    resolve,
    ssr,
    test: {
      name,
      environment,
      include,
      setupFiles,
      env: environment === "happy-dom" ? domEnv : {},
    },
  })
}

export default defineConfig({
  test: {
    projects: [
      defineProject({
        plugins: [freshModules()],
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
      defineProject({
        resolve,
        ssr,
        test: {
          name: "emit",
          environment: "node",
          include: ["test/emit/*.test.ts"],
          testTimeout: 30_000,
          setupFiles: runtimeSetup,
        },
      }),
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
          env: domEnv,
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
