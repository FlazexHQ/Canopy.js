import { CanopyError, ErrorCode } from "../protocol/index.ts"
import type { Command, ResolvedConfig } from "./types.ts"

/** Where a resolved value came from. */
export type Source =
  | { readonly kind: "default" }
  | { readonly kind: "file" }
  | {
      readonly kind: "env"
      readonly name: string
      /** The env file the variable was read from, or `undefined` for the process environment. */
      readonly envFile: string | undefined
    }

/** One reason a config does not validate. */
export interface ConfigProblem {
  /** The dotted setting path, for example `mongodb.uri`. */
  readonly path: string
  readonly message: string
  /** True when only an unset variable is missing; such problems are ignored by commands that do not need the section. */
  readonly missing: boolean
}

/** Thrown when a config does not validate. Lists every problem at once. */
export class ConfigError extends CanopyError {
  readonly problems: readonly ConfigProblem[]

  constructor(file: string | undefined, problems: readonly ConfigProblem[]) {
    const where = file ?? "the environment"
    const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`
    const body = problems
      .map((problem) => `  ${problem.path}\n${indent(problem.message, "    ")}`)
      .join("\n\n")
    super(
      ErrorCode.ConfigInvalid,
      `canopy: ${where} has ${count}\n\n${body}\n\nRun canopy config print --sources to see the resolved values and where they came from.`,
      { details: { problems: problems.map(({ path, message }) => ({ path, message })) } },
    )
    this.name = "ConfigError"
    this.problems = problems
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")
}

/** Options of {@link resolveConfig}. */
export interface ResolveOptions {
  /** The variables, after env files were merged in (the process environment wins). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** For variables that came from an env file: the file. */
  readonly envFiles?: ReadonlyMap<string, string>
  /** The config file, or `undefined` in zero config mode. */
  readonly file?: string
  /** The directory paths in the config file are relative to. */
  readonly baseDir: string
  /** The working directory, which paths from variables are relative to. */
  readonly cwd: string
  readonly command: Command
}

/** A resolved config with the source of every value. */
export interface Resolution {
  readonly config: ResolvedConfig
  readonly sources: ReadonlyMap<string, Source>
  /** Paths whose values must never be printed. */
  readonly secrets: ReadonlySet<string>
}
