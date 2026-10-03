<script lang="ts">
  /**
   * Company settings mount (US-030). The page module loads after the first
   * frame so it stays off the boot path. The loader is that first frame.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";

  import type { CompanyApi, MessagingApi } from "@hq/platform";

  interface Props {
    slug: string;
    companyLabel: string;
    openExternal?: (url: string) => void;
    companyUid?: string | null;
    company?: CompanyApi | null;
    messaging?: MessagingApi | null;
    /** RELEASE-001 gate for the Workforce seat-limit line. */
    seatLimit?: boolean;
  }

  let { slug, companyLabel, openExternal, companyUid = null, company = null, messaging = null, seatLimit = true }: Props = $props();

  let View = $state<typeof import("../company/CompanySettingsPage.svelte").default | null>(null);

  onMount(() => {
    void import("../company/CompanySettingsPage.svelte").then((mod) => {
      View = mod.default;
    });
  });
</script>

<div class="host" data-testid="company-settings-host">
  {#if View}
    <View {slug} {companyLabel} {openExternal} {companyUid} {company} {messaging} {seatLimit} />
  {:else}
    <div class="loading" aria-busy="true">
      <ReadLoader testid="company-settings-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 8px; }
</style>
