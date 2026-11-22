<script lang="ts">
  import { canopyStatus, getCanopy } from "../../src/svelte/index.ts"

  const status = canopyStatus(getCanopy())
</script>

<span>{status.current}</span>
