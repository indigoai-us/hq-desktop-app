<script lang="ts">
  /**
   * Rail mount for personal Secrets and Connections.
   * The skeleton is the first frame. The body loads through the lazy door.
   */
  import { onMount } from "svelte";
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
    <div class="skeleton" data-testid="personal-rail-skeleton" aria-busy="true">
      <aside>
        <div class="bar"></div>
        <div class="bar"></div>
        <div class="bar"></div>
      </aside>
      <main>
        <div class="title"></div>
        <div class="row"></div>
        <div class="row"></div>
      </main>
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .skeleton {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    height: 100%;
    gap: 16px;
    padding: 16px;
  }
  .bar, .title, .row {
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
    animation: personal-skel 1.1s linear infinite;
  }
  .bar { height: 28px; margin-bottom: 8px; }
  .title { height: 28px; width: 180px; }
  .row { height: 36px; margin-top: 8px; }
  @keyframes personal-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
