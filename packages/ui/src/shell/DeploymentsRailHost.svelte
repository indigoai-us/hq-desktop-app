<script lang="ts">
  /**
   * Rail mount for personal Deployments. Skeleton first, page chunk after.
   */
  import { onMount } from "svelte";
  import type { Component } from "svelte";
  import type { AdapterPromise, Json } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";

  interface Props {
    accountId?: string;
    listDeployApps?: (scope: string) => AdapterPromise<Json>;
    companies?: Pick<Workspace, "slug" | "displayName" | "kind" | "state">[];
    openExternal?: (url: string) => void;
  }

  let { accountId = "local", listDeployApps, companies = [], openExternal }: Props = $props();

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
    <Page {accountId} {listDeployApps} {companies} {openExternal} />
  {:else}
    <div class="skeleton" data-testid="personal-deployments-skeleton" aria-busy="true">
      <aside><div class="bar"></div><div class="bar"></div></aside>
      <main><div class="title"></div><div class="body"></div></main>
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .skeleton {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    height: 100%;
    gap: 16px;
    padding: 16px;
  }
  .bar, .title, .body {
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
    animation: dep-skel 1.1s linear infinite;
  }
  .bar { height: 28px; margin-bottom: 8px; }
  .title { height: 28px; width: 180px; }
  .body { height: 120px; margin-top: 16px; }
  @keyframes dep-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
