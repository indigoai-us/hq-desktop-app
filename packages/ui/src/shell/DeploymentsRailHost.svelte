<script lang="ts">
  /**
   * Rail mount for personal Deployments. Loader first, page chunk after.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import type { Component } from "svelte";
  import type { AdapterPromise, Json } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";

  interface Props {
    accountId?: string;
    listDeployApps?: (scope: string) => AdapterPromise<Json>;
    companies?: Pick<Workspace, "slug" | "displayName" | "kind" | "state">[];
    openExternal?: (url: string) => void;
    /** RELEASE-001 gate for Redeploy and the "Your bots" filter. */
    actions?: boolean;
  }

  let { accountId = "local", listDeployApps, companies = [], openExternal, actions = true }: Props = $props();

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
    <Page {accountId} {listDeployApps} {companies} {openExternal} {actions} />
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
