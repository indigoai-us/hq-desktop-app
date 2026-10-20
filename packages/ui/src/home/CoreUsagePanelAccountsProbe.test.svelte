<script lang="ts">
  /**
   * Test probe: a CoreUsagePanel whose account list changes while the menu is
   * open (a role that arrives late), the way the roster loads after the menu.
   */
  import CoreUsagePanel from "./CoreUsagePanel.svelte";
  import type { UsageAccount } from "./core-usage-model.js";

  let { source, first, second }: { source: never; first: UsageAccount[]; second: UsageAccount[] } = $props();
  let swapped = $state(false);
  const accounts = $derived(swapped ? second : first);
  const personal = $derived(accounts.find((a) => a.kind === "personal") ?? accounts[0]!);
</script>

<button type="button" data-testid="probe-accounts" onclick={() => (swapped = true)}>swap</button>
<CoreUsagePanel {source} account={personal} {accounts} retryDelays={[]} refreshMs={0} />
