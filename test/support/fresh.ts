let generation = 0

/** Modules loaded from one fresh module graph. */
export interface FreshGraph {
  /**
   * Imports a source module (`client/store.ts`, relative to `src`) as a fresh copy, together with every
   * module it imports by a relative path; loads from the same graph share those copies.
   */
  load<T>(path: string): Promise<T>
}

/**
 * Starts a fresh module graph, so a test sees the client before anything in this file loaded the core.
 * Works the same on Bun, Node.js, Deno and in browsers (needs the `freshModules` Vite plugin).
 */
export function freshGraph(): FreshGraph {
  generation += 1
  const token = generation
  return {
    async load<T>(path: string): Promise<T> {
      return (await import(/* @vite-ignore */ `../../src/${path}?fresh=${token}`)) as T
    },
  }
}
