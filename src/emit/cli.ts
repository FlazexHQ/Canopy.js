import { runEmit } from "./run.ts"

process.exitCode = await runEmit(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})
