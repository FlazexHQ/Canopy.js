import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { dockerInvocation, type Runner } from "./process.ts"
import { scaffold } from "./scaffold.ts"

export const usage = `Usage: canopy-stack <command>

Commands:
  init [--tag <tag>] [--force]                       Scaffold the canopy/ folder.
  up [--tag <tag>] [--build <path> [--canopy-js <path>]]
                                                     Start Canopy and wait for health.
  down                                               Stop Canopy.
  logs [--follow] [<service> ...]                    Show service logs.
  status                                             Show service status.
  help, --help                                       Show this help.
  --version                                          Show the canopy.js version.

up initializes a new project when canopy/compose.yaml is missing.
Images default to the installed canopy.js version. CANOPY_VERSION overrides that tag.
--build builds from a local Canopy checkout. The default canopy.js build context is
the Canopy.js checkout next to it. Use --canopy-js to select a different checkout.
`

type Command =
  | { readonly name: "help" | "version" | "down" | "status" }
  | { readonly name: "init"; readonly force: boolean; readonly tag: string | undefined }
  | {
      readonly name: "up"
      readonly build: string | undefined
      readonly library: string | undefined
      readonly tag: string | undefined
    }
  | { readonly name: "logs"; readonly follow: boolean; readonly services: readonly string[] }

class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Command {
  const [name, ...args] = argv
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    if (args.length === 0) return { name: "help" }
  }
  if (name === "--version" && args.length === 0) return { name: "version" }
  if ((name === "down" || name === "status") && args.length === 0) return { name }
  if (name === "logs") {
    let follow = false
    const services: string[] = []
    for (const arg of args) {
      if (arg === "--follow" || arg === "-f") follow = true
      else if (["database", "api", "realtime", "studio", "edge"].includes(arg)) services.push(arg)
      else throw new UsageError(`Unknown logs argument: ${arg}`)
    }
    return { name, follow, services }
  }
  if (name !== "init" && name !== "up") {
    throw new UsageError(`Unknown command or arguments: ${argv.join(" ")}`)
  }

  let force = false
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === "--force" && name === "init") {
      force = true
      continue
    }
    if (flag !== "--tag" && !(name === "up" && (flag === "--build" || flag === "--canopy-js"))) {
      throw new UsageError(`Unknown ${name} argument: ${flag}`)
    }
    const value = args[++i]
    if (value === undefined || value === "" || value.startsWith("-"))
      throw new UsageError(`${flag} requires a value.`)
    if (values.has(flag)) throw new UsageError(`${flag} may only be provided once.`)
    values.set(flag, value)
  }
  const tag = values.get("--tag")
  const build = values.get("--build")
  const library = values.get("--canopy-js")
  if (library !== undefined && build === undefined)
    throw new UsageError("--canopy-js requires --build.")
  return name === "init" ? { name, force, tag } : { name, build, library, tag }
}

interface CliOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly run: Runner
  readonly stdout: (message: string) => void
  readonly stderr: (message: string) => void
}

const serverImage = "canopy-stack-server:local"
const gatewayImage = "canopy-stack-gateway:local"

export async function runCli(argv: readonly string[], options: CliOptions): Promise<number> {
  const { cwd, stdout, stderr, version } = options
  const env = { ...options.env }
  try {
    const command = parseArgs(argv)
    if (command.name === "help") {
      stdout(usage)
      return 0
    }
    if (command.name === "version") {
      stdout(version)
      return 0
    }

    const folder = resolve(cwd, "canopy")
    const tag =
      (command.name === "init" || command.name === "up" ? command.tag : undefined) ??
      (env["CANOPY_VERSION"] || version)
    if ((command.name === "init" || command.name === "up") && !/^[\w][\w.-]{0,127}$/.test(tag))
      throw new Error("The image tag must be a valid Docker tag.")
    if (command.name === "init") {
      scaffold(folder, tag, command.force, stdout)
      return 0
    }

    if (command.name === "up" && command.tag !== undefined) env["CANOPY_VERSION"] = command.tag
    const composeFile = join(folder, "compose.yaml")
    if (!existsSync(composeFile)) {
      if (command.name !== "up")
        throw new Error("Run canopy-stack init to create canopy/compose.yaml.")
      scaffold(folder, tag, false, stdout)
    }

    const docker = (
      args: readonly string[],
      output: "inherit" | "quiet" | "capture" = "inherit",
      timeoutMs?: number,
    ) =>
      options.run(dockerInvocation(args, options.platform, env, folder), {
        cwd: folder,
        env: { ...env },
        output,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    const compose = (args: readonly string[], output?: "capture") =>
      docker(["compose", "-f", "compose.yaml", ...args], output)

    const engine = await docker(["info", "--format", "{{.ServerVersion}}"], "quiet", 10_000)
    if (engine.code !== 0) {
      if (engine.code < 128)
        stderr(
          "Docker is installed but its engine is unavailable. Start Docker or check your Docker context.",
        )
      return engine.code
    }

    switch (command.name) {
      case "down":
        return (await compose(["down"])).code
      case "status":
        return (await compose(["ps"])).code
      case "logs":
        return (
          await compose(["logs", ...(command.follow ? ["--follow"] : []), ...command.services])
        ).code
      case "up": {
        if (command.build !== undefined) {
          const checkout = resolve(cwd, command.build)
          const library =
            command.library === undefined
              ? resolve(checkout, "..", "Canopy.js")
              : resolve(cwd, command.library)
          const dockerfiles = join(checkout, "deploy", "docker")
          const server = join(dockerfiles, "canopy.Dockerfile")
          const gateway = join(dockerfiles, "canopyd.Dockerfile")
          if (!existsSync(server) || !existsSync(gateway))
            throw new Error(`Canopy Dockerfiles were not found in ${dockerfiles}.`)
          if (
            !existsSync(join(library, "src", "tsconfig.json")) ||
            !existsSync(join(library, "bun.lock"))
          )
            throw new Error(
              `Canopy.js checkout was not found at ${library}. Pass --canopy-js <path>.`,
            )
          for (const [file, image] of [
            [server, serverImage],
            [gateway, gatewayImage],
          ] as const) {
            const build = await docker([
              "build",
              "--file",
              file,
              "--build-context",
              `canopyjs=${library}`,
              "--tag",
              image,
              checkout,
            ])
            if (build.code !== 0) return build.code
          }
          env["CANOPY_IMAGE"] = serverImage
          env["CANOPY_GATEWAY_IMAGE"] = gatewayImage
        }

        const result = await compose(["up", "--wait"])
        if (result.code !== 0) return result.code
        const port = await compose(["port", "edge", "8080"], "capture")
        if (port.code >= 128) return port.code
        const published = /:(\d+)$/.exec(port.stdout?.trim() ?? "")?.[1]
        stdout(`Studio: http://localhost:${published ?? "8080"}/studio`)
        stdout(
          "Read the setup token with canopy-stack logs api, or run docker compose logs api in canopy/.",
        )
        return 0
      }
    }
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n\n${usage}`)
      return 2
    }
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      "syscall" in error &&
      typeof error.syscall === "string" &&
      error.syscall.startsWith("spawn ")
    ) {
      stderr(
        "Docker was not found. Install Docker with the Compose plugin and make sure Docker is on PATH.",
      )
    } else {
      stderr(error instanceof Error ? error.message : String(error))
    }
    return 1
  }
}
