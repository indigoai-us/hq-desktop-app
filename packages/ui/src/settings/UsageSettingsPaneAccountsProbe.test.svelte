<script lang="ts">
  /**
   * Test probe: Settings > Usage whose `accounts` prop is replaced in place,
   * first by a new array holding the same accounts (as DesktopApp recomputes
   * its list), then by a list with one more account.
   */
  import UsageSettingsPane from "./UsageSettingsPane.svelte";
  import type { UsageAccount } from "../home/core-usage-model.js";

  let { source, accounts, extra }: { source: never; accounts: UsageAccount[]; extra: UsageAccount } = $props();
  let list = $state<UsageAccount[]>([]);
  let started = $state(false);
  const shown = $derived(started ? list : accounts);
</script>

<button type="button" data-testid="probe-same" onclick={() => { list = accounts.map((a) => ({ ...a })); started = true; }}>same</button>
<button type="button" data-testid="probe-add" onclick={() => { list = [...accounts.map((a) => ({ ...a })), extra]; started = true; }}>add</button>
<UsageSettingsPane company={source} accounts={shown} />
