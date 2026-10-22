<script lang="ts">
  /**
   * Test probe: one CoreUsagePanel whose company uid changes in place, the
   * way the Core menu re-targets when the company on screen changes.
   */
  import CoreUsagePanel from "./CoreUsagePanel.svelte";

  let { source, first, second, name }: { source: never; first: string; second: string; name: string } = $props();
  let uid = $state<string | null>(null);
  const shownUid = $derived(uid ?? first);
</script>

<button type="button" data-testid="probe-switch" onclick={() => (uid = second)}>switch</button>
<CoreUsagePanel {source} companyUid={shownUid} companyName={name} retryDelays={[]} refreshMs={0} />
