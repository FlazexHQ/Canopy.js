import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { constants } from "node:os"
import { win32 } from "node:path"

interface Invocation {
  readonly file: string
  readonly args: readonly string[]
  readonly verbatim?: boolean
}

export interface RunOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: "inherit" | "quiet" | "capture"
  readonly timeoutMs?: number
}

export interface RunResult {
  readonly code: number
  readonly stdout?: string
}

export type Runner = (invocation: Invocation, options: RunOptions) => Promise<RunResult>

const signals = ["SIGINT", "SIGTERM", "SIGBREAK"] as const

export const runProcess: Runner = (invocation, options) =>
  new Promise((resolveRun, reject) => {
    let forwarded: (typeof signals)[number] | undefined
    const child = spawn(invocation.file, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio:
        options.output === "capture"
          ? ["ignore", "pipe", "ignore"]
          : options.output === "quiet"
            ? "ignore"
            : "inherit",
      windowsVerbatimArguments: invocation.verbatim ?? false,
    })
    const handlers = signals
      .filter((signal) => signal !== "SIGBREAK" || process.platform === "win32")
      .map((signal) => {
        const forward = (): void => {
          forwarded = signal
          child.kill(signal === "SIGBREAK" && process.platform === "win32" ? "SIGTERM" : signal)
        }
        process.on(signal, forward)
        return { signal, forward }
      })
    let timedOut = false
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, options.timeoutMs)
    let stdout = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.once("error", reject)
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      for (const handler of handlers) process.off(handler.signal, handler.forward)
      const received = forwarded ?? signal
      resolveRun({
        code: timedOut
          ? 1
          : received === null
            ? (code ?? 1)
            : 128 + (constants.signals[received] ?? 21),
        stdout,
      })
    })
  })

export function dockerInvocation(
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
  exists = existsSync,
): Invocation {
  if (platform !== "win32") return { file: "docker", args }

  const path = envValue(env, "PATH") ?? ""
  for (const directory of path.split(";")) {
    if (directory === "") continue
    const base = win32.resolve(cwd, directory.replace(/^"|"$/g, ""), "docker")
    if (exists(`${base}.exe`)) return { file: `${base}.exe`, args }
    for (const extension of [".cmd", ".bat"]) {
      const file = base + extension
      if (exists(file)) return windowsShim(file, args, env)
    }
  }
  return { file: "docker.exe", args }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
}

function windowsShim(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const meta = /([()%!^"<>&|;, *?])/g
  const command = file.replace(meta, "^$1")
  const escaped = args.map((arg) =>
    `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(meta, "^$1"),
  )
  return {
    file: envValue(env, "COMSPEC") ?? "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${[command, ...escaped].join(" ")}"`],
    verbatim: true,
  }
}
