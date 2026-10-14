<script lang="ts">
  /**
   * Rail mount for personal Secrets and Connections.
   * The loader is the first frame. The body loads through the lazy door.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { loadPersonalRail } from "./personal-rail-lazy.js";
  import type { PersonalIntegrationsApi } from "../personal/personal-integrations.js";
  import type { CompanyApi } from "@hq/platform";
  import { configureCompanyApi } from "../company/company-store.svelte.js";

  interface Props {
    page: "secrets" | "connections";
    companies?: { uid: string; label: string }[];
    activeCompany?: { uid: string; label: string } | null;
    onopenintegrations?: (uid: string) => void;
    integrationsApi?: PersonalIntegrationsApi | null;
    openExternal?: (url: string) => void;
    /** Backend for the secrets read. The company sidepane is not mounted in the personal scope. */
    companyApi?: CompanyApi | null;
  }

  let { page, companies = [], activeCompany = null, onopenintegrations, integrationsApi = null, openExternal, companyApi = null }: Props = $props();

  // OWNER-R32: only the company sidepane used to configure the store, so
  // Secrets opened before any company pane read "not available in this window".
  $effect.pre(() => {
    if (companyApi) configureCompanyApi(companyApi);
  });

  let Body = $state<typeof import("../personal/PersonalRailPage.svelte").default | null>(null);

  onMount(() => {
    void loadPersonalRail().then((mod) => {
      Body = mod.default;
    });
  });
</script>

<div class="host" data-testid="personal-rail-host" data-page={page}>
  {#if Body}
    <Body {page} {companies} {activeCompany} {onopenintegrations} {integrationsApi} {openExternal} />
  {:else}
    <div class="loading" aria-busy="true">
      <ReadLoader testid="personal-rail-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 8px; }
</style>
