#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { runCli } from "./cli.ts"
import { runProcess } from "./process.ts"

const manifest: unknown = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
)
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("version" in manifest) ||
  typeof manifest.version !== "string"
) {
  throw new Error("The canopy.js package version is missing.")
}

const write = (stream: NodeJS.WriteStream, message: string): void => {
  stream.write(message.endsWith("\n") ? message : `${message}\n`)
}

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  version: manifest.version,
  run: runProcess,
  stdout: (message) => write(process.stdout, message),
  stderr: (message) => write(process.stderr, message),
})
