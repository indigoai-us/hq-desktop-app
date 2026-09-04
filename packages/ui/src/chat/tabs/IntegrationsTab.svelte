<script lang="ts">
  /**
   * Integrations tab (US-016) — connected apps, available catalog, console secrets link.
   */
  import TeamTab from "./TeamTab.svelte";
  import type { CompanyTabActionEvent, CompanyTabModel } from "./tab-model.js";

  interface Props {
    data: CompanyTabModel;
    onaction?: (event: CompanyTabActionEvent) => void;
  }

  let { data, onaction }: Props = $props();
</script>

<div data-testid="company-tab-integrations" class="integrations-tab">
  <TeamTab {data} {onaction} />
</div>
