import { parentPort } from "node:worker_threads"

// Deno does not implement removeAllListeners (or listeners) on parentPort, and Vitest's thread pool calls it
// on teardown. With isolation on, every test file runs in a fresh worker that is terminated right after, so
// there is nothing left to remove.
if (parentPort !== null) {
  const port = parentPort
  port.removeAllListeners = () => port
}
