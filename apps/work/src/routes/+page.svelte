<script lang="ts">
  import { env } from "$env/dynamic/public";
  import WorkShell from "$lib/WorkShell.svelte";

  let { data } = $props();
</script>

<WorkShell {data} apiUrl={env.PUBLIC_HQ_PRO_API_URL} />
