import { readFileSync } from "node:fs"
import * as config from "canopy.js/config"
import * as policy from "canopy.js/policy"
import * as testing from "canopy.js/policy/testing"
import * as protocol from "canopy.js/protocol"
import * as schema from "canopy.js/schema"
import ts from "typescript"

/** Reads a vendored authoring vector file (`test/vectors/authoring/...`). */
export function vectors<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../vectors/authoring/${name}`, import.meta.url), "utf8"),
  ) as T
}

const modules: Readonly<Record<string, unknown>> = {
  "canopy.js/config": config,
  "canopy.js/policy": policy,
  "canopy.js/policy/testing": testing,
  "canopy.js/protocol": protocol,
  "canopy.js/schema": schema,
}

/** Evaluates a recorded TypeScript module source and returns its default export. */
export function evaluateModule<T>(source: string): T {
  const exports: { default?: T } = {}
  const require = (name: string): unknown => {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unsupported fixture import ${name}`)
    return modules[name]
  }
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  new Function("exports", "require", outputText)(exports, require)
  if (exports.default === undefined) throw new Error("Missing fixture default export")
  return exports.default
}

/** Evaluates a recorded expression with the given bindings in scope. */
export function evaluateExpression(source: string, bindings: Record<string, unknown>): unknown {
  return new Function(...Object.keys(bindings), `return (${source})`)(...Object.values(bindings))
}
