import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseArgs, runCli } from "../../src/cli/cli.ts"
import { dockerInvocation, type Runner } from "../../src/cli/process.ts"

const info = { file: "docker", args: ["info", "--format", "{{.ServerVersion}}"] }
const compose = (...args: string[]) => ({
  file: "docker",
  args: ["compose", "-f", "compose.yaml", ...args],
})

describe("arguments", () => {
  it("parses init and up flags", () => {
    expect(parseArgs(["init", "--force", "--tag", "1.2.3"])).toEqual({
      name: "init",
      force: true,
      tag: "1.2.3",
    })
    expect(
      parseArgs(["up", "--build", "../Canopy", "--canopy-js", "../SDK", "--tag", "next"]),
    ).toEqual({
      name: "up",
      build: "../Canopy",
      library: "../SDK",
      tag: "next",
    })
  })

  it.each([
    ["up", "--build"],
    ["up", "--build", "--tag"],
    ["up", "--canopy-js", "../SDK"],
    ["down", "--force"],
    ["init", "--tag", "a", "--tag", "b"],
    ["logs", "unknown"],
    ["bogus"],
  ])("rejects malformed command arguments %j", (...argv) => {
    expect(() => parseArgs(argv)).toThrow()
  })
})

describe("canopy-stack", () => {
  let cwd: string
  let folder: string
  const stdout = vi.fn<(message: string) => void>()
  const stderr = vi.fn<(message: string) => void>()
  const run = vi.fn<Runner>()

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "canopy-stack-test-"))
    folder = join(cwd, "canopy")
    stdout.mockClear()
    stderr.mockClear()
    run.mockReset().mockResolvedValue({ code: 0 })
  })

  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  const cli = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
    runCli(argv, { cwd, env, version: "2.3.4", platform: "linux", run, stdout, stderr })
  const read = (path: string) => readFileSync(join(folder, path), "utf8")

  it.each([[], ["help"], ["--help"]])("shows stack help for %j", async (...args) => {
    expect(await cli(args)).toBe(0)
    const help = stdout.mock.calls[0]?.[0]
    for (const word of [
      "canopy-stack",
      "init",
      "up",
      "--build",
      "down",
      "logs",
      "status",
      "--version",
    ]) {
      expect(help).toContain(word)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it("prints the package version", async () => {
    expect(await cli(["--version"])).toBe(0)
    expect(stdout).toHaveBeenCalledWith("2.3.4")
  })

  it("reports invalid usage", async () => {
    expect(await cli(["up", "--build"])).toBe(2)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--build requires a value."))
    expect(run).not.toHaveBeenCalled()
  })

  it("scaffolds a complete stack with a random key and installed version", async () => {
    expect(await cli(["init"])).toBe(0)
    expect(read("compose.yaml")).toContain(
      `image: \${CANOPY_IMAGE:-ghcr.io/flazexhq/canopy-legacy:\${CANOPY_VERSION:-2.3.4}}`,
    )
    expect(read("compose.yaml")).toContain(
      `  studio:
    image: \${CANOPY_GATEWAY_IMAGE:-ghcr.io/flazexhq/canopy:\${CANOPY_VERSION:-2.3.4}}
    environment:
      CANOPY_ROLE: studio`,
    )
    expect(read("canopy.config.ts")).toContain('from "canopy.js/config"')
    expect(read("policies/notes.ts")).toContain('from "canopy.js/policy"')
    expect(read("edge/Caddyfile")).toBe(
      readFileSync(new URL("../../templates/cli/Caddyfile", import.meta.url), "utf8").replace(
        /\r\n/g,
        "\n",
      ),
    )
    expect(read(".env")).toMatch(/^CANOPY_MASTER_KEY=[A-Za-z0-9+/]{43}=\n$/)
    expect(
      Buffer.from(read(".env").slice("CANOPY_MASTER_KEY=".length).trim(), "base64"),
    ).toHaveLength(32)
    expect(read(".gitignore")).toBe("/.env\n")
    expect(stdout).toHaveBeenCalledWith("Wrote canopy/compose.yaml")
    expect(stderr).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("preserves files without force and keeps dotenv secrets even with force", async () => {
    mkdirSync(folder)
    writeFileSync(join(folder, ".gitignore"), "scratch/\r\n")
    writeFileSync(join(folder, ".env"), "CANOPY_MASTER_KEY=keep-me\r\nCANOPY_PORT=9000\r\n")
    writeFileSync(join(folder, "compose.yaml"), "existing")
    expect(await cli(["init"])).toBe(0)
    expect(read("compose.yaml")).toBe("existing")
    expect(await cli(["init", "--force", "--tag", "next"], { CANOPY_VERSION: "edge" })).toBe(0)
    expect(read("compose.yaml")).toContain(`\${CANOPY_VERSION:-next}`)
    expect(read(".env")).toBe("CANOPY_MASTER_KEY=keep-me\r\nCANOPY_PORT=9000\r\n")
    expect(read(".gitignore")).toBe("scratch/\r\n/.env\r\n")
  })

  it("appends a missing key and accepts a tag from the environment", async () => {
    mkdirSync(folder)
    writeFileSync(join(folder, ".env"), "CANOPY_PORT=9000")
    expect(await cli(["init"], { CANOPY_VERSION: "edge" })).toBe(0)
    expect(read("compose.yaml")).toContain(`\${CANOPY_VERSION:-edge}`)
    expect(read(".env")).toMatch(/^CANOPY_PORT=9000\nCANOPY_MASTER_KEY=.+\n$/)
    const initial = read(".env")
    expect(await cli(["init"])).toBe(0)
    expect(read(".env")).toBe(initial)
  })

  it("rejects an invalid image tag", async () => {
    expect(await cli(["init", "--tag", "bad/tag"])).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("valid Docker tag"))
  })

  it("initializes and waits for the stack, then reports the published Studio port", async () => {
    run
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({ code: 0, stdout: "0.0.0.0:9000\r\n" })
    expect(await cli(["up", "--tag", "next"])).toBe(0)
    expect(run.mock.calls).toEqual([
      [info, { cwd: folder, env: { CANOPY_VERSION: "next" }, output: "quiet", timeoutMs: 10_000 }],
      [
        compose("up", "--wait"),
        { cwd: folder, env: { CANOPY_VERSION: "next" }, output: "inherit" },
      ],
      [
        compose("port", "edge", "8080"),
        { cwd: folder, env: { CANOPY_VERSION: "next" }, output: "capture" },
      ],
    ])
    expect(stdout).toHaveBeenCalledWith("Studio: http://localhost:9000/studio")
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("docker compose logs api"))
    expect(read("compose.yaml")).toContain(`\${CANOPY_VERSION:-next}`)
  })

  it.each([
    { args: ["down"], docker: ["down"] },
    {
      args: ["logs", "--follow", "api", "realtime"],
      docker: ["logs", "--follow", "api", "realtime"],
    },
    { args: ["logs"], docker: ["logs"] },
    { args: ["status"], docker: ["ps"] },
  ])("runs $args without altering the exit code", async ({ args, docker }) => {
    expect(await cli(["init"])).toBe(0)
    run.mockResolvedValueOnce({ code: 0 }).mockResolvedValueOnce({ code: 37 })
    expect(await cli(args)).toBe(37)
    expect(run.mock.calls).toEqual([
      [info, { cwd: folder, env: {}, output: "quiet", timeoutMs: 10_000 }],
      [compose(...docker), { cwd: folder, env: {}, output: "inherit" }],
    ])
  })

  it("builds both Canopy images with a local Canopy.js build context", async () => {
    const checkout = join(cwd, "platform checkout")
    const library = join(cwd, "Canopy.js")
    const dockerfiles = join(checkout, "deploy", "docker")
    mkdirSync(dockerfiles, { recursive: true })
    mkdirSync(join(library, "src"), { recursive: true })
    for (const file of ["canopy.Dockerfile", "canopyd.Dockerfile"])
      writeFileSync(join(dockerfiles, file), "")
    writeFileSync(join(library, "src", "tsconfig.json"), "")
    writeFileSync(join(library, "bun.lock"), "")
    expect(await cli(["up", "--build", "platform checkout"])).toBe(0)
    const env = {
      CANOPY_IMAGE: "canopy-stack-server:local",
      CANOPY_GATEWAY_IMAGE: "canopy-stack-gateway:local",
    }
    const build = (file: string, image: string) => ({
      file: "docker",
      args: [
        "build",
        "--file",
        join(dockerfiles, file),
        "--build-context",
        `canopyjs=${library}`,
        "--tag",
        image,
        checkout,
      ],
    })
    expect(run.mock.calls).toEqual([
      [info, { cwd: folder, env: {}, output: "quiet", timeoutMs: 10_000 }],
      [build("canopy.Dockerfile", env.CANOPY_IMAGE), { cwd: folder, env: {}, output: "inherit" }],
      [
        build("canopyd.Dockerfile", env.CANOPY_GATEWAY_IMAGE),
        { cwd: folder, env: {}, output: "inherit" },
      ],
      [compose("up", "--wait"), { cwd: folder, env, output: "inherit" }],
      [compose("port", "edge", "8080"), { cwd: folder, env, output: "capture" }],
    ])
  })

  it("stops after a failed Compose up", async () => {
    run.mockResolvedValueOnce({ code: 0 }).mockResolvedValueOnce({ code: 130 })
    expect(await cli(["up"])).toBe(130)
    expect(run).toHaveBeenCalledTimes(2)
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("Studio:"))
  })

  it("reports a missing Docker executable", async () => {
    run.mockRejectedValueOnce(
      Object.assign(new Error("spawn docker ENOENT"), {
        code: "ENOENT",
        syscall: "spawn docker",
      }),
    )
    expect(await cli(["up"])).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Docker was not found"))
  })

  it("reports an unreachable Docker engine", async () => {
    run.mockResolvedValueOnce({ code: 5 })
    expect(await cli(["up"])).toBe(5)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("engine is unavailable"))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("asks to initialize before managing a missing stack", async () => {
    expect(await cli(["status"])).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("canopy-stack init"))
    expect(run).not.toHaveBeenCalled()
  })
})

describe("Windows Docker resolution", () => {
  const cwd = "C:\\Project"
  const directory = "C:\\Docker Tools"

  it("runs the native executable directly", () => {
    const file = `${directory}\\docker.exe`
    const args = ["compose", "up", "--wait"]
    expect(
      dockerInvocation(args, "win32", { Path: directory }, cwd, (candidate) => candidate === file),
    ).toEqual({ file, args })
  })

  it("runs a command shim via cmd.exe with escaped arguments", () => {
    const shim = `${directory}\\docker.cmd`
    const args = ["build", "--build-context", "canopyjs=C:\\Project & SDK"]
    expect(
      dockerInvocation(
        args,
        "win32",
        { Path: directory, ComSpec: "C:\\Windows\\cmd.exe" },
        cwd,
        (candidate) => candidate === shim,
      ),
    ).toEqual({
      file: "C:\\Windows\\cmd.exe",
      args: [
        "/d",
        "/v:off",
        "/s",
        "/c",
        '"C:\\Docker^ Tools\\docker.cmd ^"build^" ^"--build-context^" ^"canopyjs=C:\\Project^ ^&^ SDK^""',
      ],
      verbatim: true,
    })
  })
})
