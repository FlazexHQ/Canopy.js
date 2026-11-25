import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const referenceRoot =
  process.env["CANOPY_REPO"] ?? fileURLToPath(new URL("../../../Canopy", import.meta.url))
const read = (path: string | URL) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

function serviceDefinitions(compose: string): string {
  return compose.split("\nservices:\n")[1]?.split("\nnetworks:\n")[0]?.trimEnd() ?? ""
}

it("keeps the development services aligned with Canopy", () => {
  const reference = read(join(referenceRoot, "deploy", "compose", "canopy.yaml"))
  const template = read(new URL("../../templates/cli/compose.yaml", import.meta.url))
  const referenceServices = serviceDefinitions(reference).replace(
    / {4}build:\n {6}context: \.\.\/\.\.\n {6}dockerfile: deploy\/docker\/canopyd\.Dockerfile\n {6}additional_contexts:\n {8}canopyjs: \.\.\/\.\.\/\.\.\/Canopy\.js\n {4}image: \$\{CANOPY_GATEWAY_IMAGE:-canopy:dev\}/,
    `    image: \${CANOPY_GATEWAY_IMAGE:-ghcr.io/flazexhq/canopy:\${CANOPY_VERSION:-__CANOPY_VERSION__}}`,
  )
  const templateServices = serviceDefinitions(template).replaceAll(
    "      - ./canopy.config.ts:/app/canopy.config.ts:ro\n",
    "",
  )
  expect(templateServices).toEqual(referenceServices)
  expect(templateServices.match(/^ {2}\w+:/gm)).toEqual([
    "  database:",
    "  api:",
    "  realtime:",
    "  studio:",
    "  edge:",
  ])
  const health = (compose: string) =>
    compose.split("\nx-canopy-health:")[1]?.split("\nservices:")[0]?.trim()
  expect(health(template)).toBe(health(reference))
  expect(health(template)).toContain("/readyz")
  const imageAnchor = (compose: string) =>
    compose.split("\nx-canopy-image:")[1]?.split("\nx-canopy-environment:")[0]?.trimEnd()
  const referenceImage = imageAnchor(reference)?.replace(
    /\n {2}build:\n {4}context: \.\.\/\.\.\n {4}dockerfile: deploy\/docker\/canopy\.Dockerfile\n {4}additional_contexts:\n {6}canopyjs: \.\.\/\.\.\/\.\.\/Canopy\.js\n {2}image: \$\{CANOPY_IMAGE:-canopy-legacy:dev\}/,
    `\n  image: \${CANOPY_IMAGE:-ghcr.io/flazexhq/canopy-legacy:\${CANOPY_VERSION:-__CANOPY_VERSION__}}`,
  )
  expect(imageAnchor(template)).toBe(referenceImage)
  expect(template).not.toMatch(/^\s+build:/m)
})
