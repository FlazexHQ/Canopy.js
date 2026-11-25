import { readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const src = fileURLToPath(new URL("../src/", import.meta.url))
const allowed = new Set([
  "core/README.md",
  "core/protocol/bson.ts",
  "core/protocol/close-codes.ts",
  "core/protocol/cluster-time.ts",
  "core/protocol/diagnostics.ts",
  "core/protocol/ejson.ts",
  "core/protocol/errors.ts",
  "core/protocol/index.ts",
  "core/protocol/interop.ts",
  "core/protocol/messages.ts",
  "core/protocol/paths.ts",
  "core/protocol/sha256.ts",
  "core/protocol/uuid.ts",
  "core/protocol/values.ts",
  "core/protocol/webhooks.ts",
  "config/auth.ts",
  "config/env.ts",
  "config/index.ts",
  "config/resolution.ts",
  "config/types.ts",
  "policy/dsl.ts",
  "policy/errors.ts",
  "policy/index.ts",
  "policy/model.ts",
  "policy/testing.ts",
  "policy/typed.ts",
  "schema/declared.ts",
  "schema/fields.ts",
  "schema/index.ts",
  "schema/shape.ts",
  "schema/to-shape.ts",
  "schema/types.ts",
])

function unexpected(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    const name = relative(src, path).split(sep).join("/")
    if (name === "core/wasm" && entry.isDirectory()) return []
    if (entry.isDirectory()) return unexpected(path)
    return entry.isFile() && allowed.has(name) ? [] : [name]
  })
}

const problems = ["core", "config", "policy", "schema"].flatMap((dir) => unexpected(join(src, dir)))
if (problems.length > 0) {
  console.error(`Unexpected core or authoring files:\n${problems.sort().join("\n")}`)
  process.exitCode = 1
}
