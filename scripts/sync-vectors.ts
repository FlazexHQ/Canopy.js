import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const root = fileURLToPath(new URL("../", import.meta.url))
const vectors = join(root, "test", "vectors")
const authoring = [
  "collection-schema.schema.json",
  "config.schema.json",
  "config/vectors.json",
  "policy-set.schema.json",
  "policy-test.schema.json",
  "policy/publishing.json",
  "policy/vectors.json",
  "schema/vectors.json",
]

function readVector(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n")
}

function syncVectors(): void {
  const { values } = parseArgs({
    options: { from: { type: "string" }, check: { type: "boolean", default: false } },
  })
  const from = resolve(values.from ?? join(root, "..", "Canopy"))
  const conformance = join(from, "conformance")
  const protocol = readdirSync(join(conformance, "protocol"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
  const expected = new Map([
    ...protocol.map((name) => [name, join(conformance, "protocol", name)] as const),
    ...authoring.map(
      (name) => [`authoring/${name}`, join(conformance, "authoring", name)] as const,
    ),
  ])
  const entries = existsSync(vectors)
    ? readdirSync(vectors, { recursive: true, withFileTypes: true })
    : []
  const present = new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(vectors, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .sort(),
  )
  const extra = [...present].filter((name) => !expected.has(name))
  const missingSource: string[] = []
  const drift: string[] = []
  const contents = new Map<string, string>()

  for (const [name, source] of expected) {
    if (!existsSync(source)) {
      missingSource.push(`missing from Canopy: ${relative(from, source).split(sep).join("/")}`)
      continue
    }
    const text = readVector(source)
    contents.set(name, text)
    if (!values.check) continue
    if (!present.has(name)) drift.push(`missing: test/vectors/${name}`)
    else if (readVector(join(vectors, name)) !== text) drift.push(`differs: test/vectors/${name}`)
  }

  if (values.check) drift.push(...extra.map((name) => `extra: test/vectors/${name}`))

  const problems = [...missingSource, ...drift]
  if (problems.length > 0) {
    console.error(`Vector sync with ${from} failed:\n  ${problems.join("\n  ")}`)
    process.exitCode = 1
    return
  }
  if (values.check) return

  for (const name of extra) unlinkSync(join(vectors, name))
  for (const [name, text] of contents) {
    const destination = join(vectors, name)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, text)
  }
  console.warn(`Synced ${contents.size} vectors from ${from}`)
}

syncVectors()
