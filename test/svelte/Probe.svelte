<script lang="ts">
  import type { Query } from "../../src/svelte/index.ts"

  let { query }: { query: Query<{ _id: number }> } = $props()
</script>

<p>
  {query.status}:{query.data.length}{query.error === undefined ? "" : `:${query.error.message}`}
</p>
