const MARKER: unique symbol = Symbol.for("canopy.config.env")

/** How the text of an environment variable is parsed. */
export type EnvKind = "string" | "int" | "bool" | "list" | "url" | "duration"

/**
 * A reference to an environment variable inside a config file. The loader replaces it with the parsed
 * value after the file is evaluated, so it can report every missing variable at once and redact secrets.
 */
export interface EnvMarker<T> {
  readonly [MARKER]: true
  readonly name: string
  readonly kind: EnvKind
  /** Redacted in errors and in `canopy config print`. Secrets never have a default. */
  readonly secret: boolean
  readonly optional: boolean
  readonly fallback: T | undefined
  /** Carries the value type; never set at runtime. */
  readonly type?: T
}

/** Options of {@link env}. */
export interface EnvOptions<T> {
  /** A value used when the variable is unset. Not allowed for secrets. */
  readonly default?: T
}

function marker<T>(
  name: string,
  kind: EnvKind,
  secret: boolean,
  optional: boolean,
  fallback: T | undefined,
): EnvMarker<T> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new TypeError(`env(): ${JSON.stringify(name)} is not a valid variable name`)
  return Object.freeze({ [MARKER]: true as const, name, kind, secret, optional, fallback })
}

interface Reader<T> {
  (name: string, options?: EnvOptions<T>): EnvMarker<T>
  /** The variable may be unset; the setting is then left out. */
  optional(name: string): EnvMarker<T | undefined>
}

function reader<T>(kind: EnvKind): Reader<T> {
  const read = (name: string, options: EnvOptions<T> = {}): EnvMarker<T> =>
    marker<T>(name, kind, false, false, options.default)
  return Object.assign(read, {
    optional: (name: string): EnvMarker<T | undefined> =>
      marker<T | undefined>(name, kind, false, true, undefined),
  })
}

/**
 * Reads an environment variable: `env("APP_ORIGIN")`. Typed variants parse the text: `env.int`, `env.bool`
 * (`true`, `false`, `1`, `0`), `env.list` (comma separated), `env.url` and `env.duration` (`500ms`, `30s`,
 * `5m`, `24h`, `7d`, in milliseconds). `env.secret` is redacted everywhere and takes no default.
 */
export const env: Reader<string> & {
  readonly int: Reader<number>
  readonly bool: Reader<boolean>
  readonly list: Reader<readonly string[]>
  readonly url: Reader<string>
  readonly duration: Reader<number>
  readonly secret: {
    (name: string): EnvMarker<string>
    optional(name: string): EnvMarker<string | undefined>
  }
} = Object.assign(reader<string>("string"), {
  int: reader<number>("int"),
  bool: reader<boolean>("bool"),
  list: reader<readonly string[]>("list"),
  url: reader<string>("url"),
  duration: reader<number>("duration"),
  secret: Object.assign(
    (name: string): EnvMarker<string> => marker<string>(name, "string", true, false, undefined),
    {
      optional: (name: string): EnvMarker<string | undefined> =>
        marker<string | undefined>(name, "string", true, true, undefined),
    },
  ),
})

/** Whether a value is an {@link env} marker. */
export function isEnvMarker(value: unknown): value is EnvMarker<unknown> {
  return typeof value === "object" && value !== null && Object.hasOwn(value, MARKER)
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/
const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Parses `500ms`, `30s`, `5m`, `24h` or `7d` into milliseconds; a bare number is milliseconds. */
export function parseDuration(text: string): number | undefined {
  const trimmed = text.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const match = DURATION.exec(trimmed)
  if (match === null) return undefined
  return Math.round(Number(match[1]) * (UNIT_MS[match[2] ?? "ms"] ?? 1))
}
