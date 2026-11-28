import { createServer } from "node:net"
import { fileURLToPath } from "node:url"

import { svelte } from "@sveltejs/vite-plugin-svelte"
import { playwright } from "@vitest/browser-playwright"
import type { PluginOption } from "vite"
import { defineConfig, defineProject } from "vitest/config"

import { canopyRepo, engineSetup, freshModules, resolve } from "./vitest.shared.ts"

/**
 * The client and binding suites in Chromium, Firefox and WebKit (headless, through Playwright), so the
 * client core is proven where applications run it. The client suite runs twice per browser: once on the
 * WebAssembly core and once on its JavaScript translation. Pick one browser with `--browser=firefox`. The
 * CLI and emit suites are server only and stay in `vitest.config.ts`.
 *
 * Each project serves its browser from a port the operating system picks, because Vitest's fixed default
 * ports can fall in a range Windows reserves.
 */
const root = fileURLToPath(new URL(".", import.meta.url))
const instances = [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }] as const

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "localhost", resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === "string")
    throw new Error("No free port for the browser")
  return address.port
}

async function project(
  name: string,
  include: string[],
  options: { env?: Record<string, string>; plugins?: PluginOption[]; testTimeout?: number } = {},
) {
  return defineProject({
    plugins: [freshModules(), ...(options.plugins ?? [])],
    resolve,
    server: { fs: { allow: [root, canopyRepo] } },
    test: {
      name,
      include,
      setupFiles: [engineSetup],
      env: options.env ?? {},
      ...(options.testTimeout === undefined ? {} : { testTimeout: options.testTimeout }),
      api: { port: await freePort(), strictPort: true },
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: instances.map((instance) => ({ ...instance })),
      },
    },
  })
}

const client = ["test/client/**/*.test.ts"]

export default defineConfig({
  test: {
    projects: await Promise.all([
      project("client", client, { testTimeout: 30_000 }),
      project("client js", client, { env: { CANOPY_TEST_CORE: "js" }, testTimeout: 30_000 }),
      project("react", ["test/react/**/*.test.tsx"]),
      project("vue", ["test/vue/**/*.test.ts"]),
      project("svelte", ["test/svelte/**/*.test.ts"], {
        plugins: [svelte({ configFile: false })],
      }),
      project("solid", ["test/solid/**/*.test.ts"]),
      project("tanstack-db", ["test/tanstack-db/**/*.test.ts"]),
      project("devtools", ["test/devtools/**/*.test.ts"]),
    ]),
  },
})
