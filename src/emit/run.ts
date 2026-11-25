import type { Command, Environment } from "../core/config/types.ts"
import { AuthoringError } from "./errors.ts"
import { COMMANDS, type EmitOptions, emitProject } from "./project.ts"

/** Where {@link runEmit} writes: the bundle goes to `stdout`, diagnostics and project output to `stderr`. */
export interface EmitIo {
  stdout(text: string): void
  stderr(text: string): void
}

/** Exit codes of the emitter. */
export const EXIT = { ok: 0, invalid: 1, usage: 2, internal: 3 } as const

const VALUE_OPTIONS = ["root", "config", "policies", "tests", "schema", "mode", "command"] as const
type ValueOption = (typeof VALUE_OPTIONS)[number]

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): EmitOptions {
  const values: Partial<Record<ValueOption, string>> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ""
    const [flag, inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s, 2) : [undefined]
    const option = VALUE_OPTIONS.find((name) => name === flag)
    if (option === undefined) throw new UsageError(`Unknown argument ${JSON.stringify(arg)}`)
    const value = inline ?? argv[++index]
    if (value === undefined || value === "") throw new UsageError(`--${option} needs a value`)
    values[option] = value
  }
  const { mode, command } = values
  if (mode !== undefined && mode !== "development" && mode !== "production")
    throw new UsageError("--mode takes development or production")
  if (command !== undefined && !COMMANDS.some((known) => known === command))
    throw new UsageError(`--command takes one of ${COMMANDS.join(", ")}`)
  return {
    ...(values.root === undefined ? {} : { root: values.root }),
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.policies === undefined ? {} : { policies: values.policies }),
    ...(values.tests === undefined ? {} : { tests: values.tests }),
    ...(values.schema === undefined ? {} : { schema: values.schema }),
    ...(mode === undefined ? {} : { mode: mode as Environment }),
    ...(command === undefined ? {} : { command: command as Command }),
  }
}

function errorLine(error: {
  code: string
  message: string
  part: string | null
  path: string | null
  file: string | null
}): string {
  return `${JSON.stringify({ error })}\n`
}

const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error", "trace", "dir", "table"] as const

/**
 * Runs the emitter with command line arguments: prints the bundle on stdout and returns the exit code
 * (0 emitted, 1 the project is invalid, 2 a usage error, 3 the emitter failed). While the project loads,
 * its `console` output goes to stderr, so stdout carries only the bundle.
 */
export async function runEmit(argv: readonly string[], io: EmitIo): Promise<number> {
  let options: EmitOptions
  try {
    options = parseArgs(argv)
  } catch (error: unknown) {
    if (!(error instanceof UsageError)) throw error
    io.stderr(
      errorLine({
        code: "CANOPY_INTERNAL",
        message: error.message,
        part: null,
        path: null,
        file: null,
      }),
    )
    return EXIT.usage
  }
  const host = globalThis.console as unknown as Record<string, unknown>
  const saved = CONSOLE_METHODS.map((method) => [method, host[method]] as const)
  for (const method of CONSOLE_METHODS) {
    host[method] = (...args: unknown[]) => {
      io.stderr(`${args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ")}
`)
    }
  }
  let bundle: Awaited<ReturnType<typeof emitProject>>
  try {
    bundle = await emitProject(options)
  } catch (error: unknown) {
    if (error instanceof AuthoringError) {
      io.stderr(
        errorLine({
          code: error.code,
          message: error.message,
          part: error.part,
          path: error.path,
          file: error.file,
        }),
      )
      return EXIT.invalid
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(errorLine({ code: "CANOPY_INTERNAL", message, part: null, path: null, file: null }))
    return EXIT.internal
  } finally {
    for (const [method, original] of saved) host[method] = original
  }
  io.stdout(`${JSON.stringify(bundle)}\n`)
  return EXIT.ok
}
