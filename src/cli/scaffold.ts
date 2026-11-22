import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const templates = new URL("../../templates/cli/", import.meta.url)

export function scaffold(
  folder: string,
  tag: string,
  force: boolean,
  report: (message: string) => void,
): void {
  const project = createHash("sha256").update(folder).digest("hex").slice(0, 12)
  const files = [
    ["canopy.config.ts", "config.txt"],
    ["policies/notes.ts", "policy.txt"],
    ["compose.yaml", "compose.yaml"],
    ["edge/Caddyfile", "Caddyfile"],
  ] as const
  for (const [name, template] of files) {
    const path = join(folder, name)
    const contents = readFileSync(new URL(template, templates), "utf8").replace(/\r\n/g, "\n")
    mkdirSync(dirname(path), { recursive: true })
    try {
      writeFileSync(
        path,
        contents.replaceAll("__CANOPY_VERSION__", tag).replaceAll("__CANOPY_PROJECT__", project),
        {
          flag: force ? "w" : "wx",
        },
      )
      report(`Wrote canopy/${name}`)
    } catch (error: unknown) {
      if (force || !isExistingFile(error)) throw error
      report(`Kept canopy/${name}`)
    }
  }

  const ignore = join(folder, ".gitignore")
  appendSetting(ignore, /^\/?\.env\s*$/m, () => "/.env", report)
  appendSetting(
    join(folder, ".env"),
    /^\s*(?:export[ \t]+)?CANOPY_MASTER_KEY[ \t]*=/m,
    () => `CANOPY_MASTER_KEY=${randomBytes(32).toString("base64")}`,
    report,
  )
}

function isExistingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}

function appendSetting(
  path: string,
  pattern: RegExp,
  setting: () => string,
  report: (message: string) => void,
): void {
  const name = `canopy/${basename(path)}`
  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${setting()}\n`, { flag: "wx", mode: 0o600 })
      report(`Wrote ${name}`)
      return
    } catch (error: unknown) {
      if (!isExistingFile(error)) throw error
    }
  }

  const contents = readFileSync(path, "utf8")
  if (pattern.test(contents)) {
    report(`Kept ${name}`)
    return
  }
  const newline = contents.includes("\r\n") ? "\r\n" : "\n"
  const separator = contents === "" || contents.endsWith("\n") ? "" : newline
  appendFileSync(path, `${separator}${setting()}${newline}`)
  report(`Updated ${name}`)
}
