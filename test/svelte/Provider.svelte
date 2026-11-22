<script lang="ts">
  import type { CanopyClient } from "canopy.js"

  import { setCanopy } from "../../src/svelte/index.ts"
  import Consumer from "./Consumer.svelte"

  const props: { client: CanopyClient } = $props()
  setCanopy(props.client)
</script>

<Consumer />
