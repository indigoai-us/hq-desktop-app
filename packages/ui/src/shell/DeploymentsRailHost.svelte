<script lang="ts">
  /**
   * Rail mount for personal Deployments. Loader first, page chunk after.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import type { Component } from "svelte";
  import type { AdapterPromise, Json } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import type { DeployDomainRequest, DomainPrices } from "../company/files-connect/custom-domain.js";

  interface Props {
    accountId?: string;
    listDeployApps?: (scope: string) => AdapterPromise<Json>;
    deployAppPreview?: (appId: string, url: string, deployedAt: string, refresh: boolean) => AdapterPromise<Json>;
    deployAppSnapshot?: (
      appId: string,
      url: string,
      deployedAt: string,
      refresh: boolean,
      gate?: { scope: string; protected: boolean },
    ) => AdapterPromise<Json>;
    companies?: (Pick<Workspace, "slug" | "displayName" | "kind" | "state"> & Partial<Pick<Workspace, "cloudUid" | "role">>)[];
    /** US-007: the company Custom domain sheet on company rows. */
    deployDomainRequest?: DeployDomainRequest | null;
    loadDomainPrices?: (() => Promise<DomainPrices | null>) | null;
    domainCardEntryUrl?: ((companyUid: string) => Promise<string | null>) | null;
    loadCompanyDomainPrice?: ((companyUid: string) => Promise<unknown>) | null;
    openExternal?: (url: string) => void;
    /** RELEASE-001 gate for Redeploy and the "Your bots" filter. */
    actions?: boolean;
  }

  let { accountId = "local", listDeployApps, deployAppPreview, deployAppSnapshot, companies = [], deployDomainRequest = null, loadDomainPrices = null, domainCardEntryUrl = null, loadCompanyDomainPrice = null, openExternal, actions = true }: Props = $props();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Page = $state<Component<any> | null>(null);

  onMount(() => {
    let live = true;
    void import("../library/PersonalDeploymentsPage.svelte").then(
      (mod) => {
        if (live) Page = mod.default;
      },
      (err) => console.error("[deployments-rail] load failed", err),
    );
    return () => {
      live = false;
    };
  });
</script>

<div class="host" data-testid="personal-deployments-host">
  {#if Page}
    <Page {accountId} {listDeployApps} {deployAppPreview} {deployAppSnapshot} {companies} {deployDomainRequest} {loadDomainPrices} {domainCardEntryUrl} {loadCompanyDomainPrice} {openExternal} {actions} />
  {:else}
    <div class="loading" aria-busy="true">
      <ReadLoader testid="personal-deployments-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 8px; }
</style>
