<script lang="ts">
  /**
   * Company settings mount (US-030). The page module loads after the first
   * frame so it stays off the boot path. The loader is that first frame.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";

  import type { CompanyApi, FilesApi, MessagingApi } from "@hq/platform";
  import type { GrantTarget } from "../company/group-grants.js";

  interface Props {
    slug: string;
    companyLabel: string;
    openExternal?: (url: string) => void;
    companyUid?: string | null;
    company?: CompanyApi | null;
    messaging?: MessagingApi | null;
    /** RELEASE-001 gate for the Workforce seat-limit line. */
    seatLimit?: boolean;
    /** OWNER-R24: the panel pane to show. */
    section?: "general" | "brand" | "groups" | "grants" | "billing";
    /** OWNER-R24: the caller's role; General and Brand are read-only unless Owner. */
    role?: string | null;
    /** Vault reads for the live Groups and Grants panes. */
    files?: FilesApi | null;
    /** The caller's companies, for the Grants pane's target picker. */
    targets?: GrantTarget[];
  }

  let { slug, companyLabel, openExternal, companyUid = null, company = null, messaging = null, seatLimit = true, section = "general", role = null, files = null, targets = [] }: Props = $props();

  let View = $state<typeof import("../company/CompanySettingsPage.svelte").default | null>(null);

  onMount(() => {
    void import("../company/CompanySettingsPage.svelte").then((mod) => {
      View = mod.default;
    });
  });
</script>

<div class="host" data-testid="company-settings-host">
  {#if View}
    <View {slug} {companyLabel} {openExternal} {companyUid} {company} {messaging} {seatLimit} {section} {role} {files} {targets} />
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
