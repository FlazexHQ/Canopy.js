declare module "*.svelte" {
  import type { CanopyClient } from "canopy.js"
  import type { Component } from "svelte"

  import type { Query } from "../../src/svelte/index.ts"

  const component: Component<{
    readonly query?: Query<{ readonly _id: number }>
    readonly client?: CanopyClient
  }>
  export default component
}
