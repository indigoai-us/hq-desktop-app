<script lang="ts">
  /**
   * Company settings mount (US-030). The page module loads after the first
   * frame so it stays off the boot path. The skeleton is that first frame.
   */
  import { onMount } from "svelte";

  interface Props {
    slug: string;
    companyLabel: string;
    openExternal?: (url: string) => void;
  }

  let { slug, companyLabel, openExternal }: Props = $props();

  let View = $state<typeof import("../company/CompanySettingsPage.svelte").default | null>(null);

  onMount(() => {
    void import("../company/CompanySettingsPage.svelte").then((mod) => {
      View = mod.default;
    });
  });
</script>

<div class="host" data-testid="company-settings-host">
  {#if View}
    <View {slug} {companyLabel} {openExternal} />
  {:else}
    <div class="skeleton" data-testid="company-settings-skeleton" aria-busy="true">
      <div class="title"></div>
      <div class="row"></div>
      <div class="row"></div>
      <div class="row"></div>
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .skeleton { padding: 16px; }
  .title, .row {
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
  }
  .title { height: 28px; width: 180px; }
  .row { height: 36px; margin-top: 10px; }
</style>
