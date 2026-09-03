<script lang="ts">
  /**
   * Settings tab (US-017) — general, billing, cloud, danger zone.
   */
  import TeamTab from "./TeamTab.svelte";
  import type { CompanyTabActionEvent, CompanyTabModel } from "./tab-model.js";

  interface Props {
    data: CompanyTabModel;
    onaction?: (event: CompanyTabActionEvent) => void;
  }

  let { data, onaction }: Props = $props();
</script>

<div data-testid="company-tab-settings" class="settings-tab">
  <TeamTab {data} {onaction} />
</div>
