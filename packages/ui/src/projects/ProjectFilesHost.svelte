<script lang="ts">
  /**
   * First frame of the Project Files tab. The skeleton paints before the
   * body chunk loads (US-025). Nothing here imports ProjectFilesBody.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import { loadProjectFiles } from "./project-files-lazy.js";
  import type { PortfolioSessionRef } from "./projects-model.js";

  type BodyModule = Awaited<ReturnType<typeof loadProjectFiles>>;

  interface Props {
    adapter: PlatformAdapter;
    vaultRoot: string | null;
    prdPath?: string | null;
    repoAccess?: boolean;
    sessions?: readonly PortfolioSessionRef[];
    ownerName?: string;
  }

  let {
    adapter,
    vaultRoot,
    prdPath = null,
    repoAccess = true,
    sessions = [],
    ownerName = "You",
  }: Props = $props();

  let mod = $state<BodyModule | null>(null);

  onMount(() => {
    if (!vaultRoot) return;
    let alive = true;
    loadProjectFiles()
      .then((loaded) => {
        if (alive) mod = loaded;
      })
      .catch((err) => {
        console.error("Project files chunk failed:", err);
      });
    return () => {
      alive = false;
    };
  });
</script>

<div class="files-host" data-testid="detail-files" aria-busy={mod ? undefined : "true"}>
  {#if !vaultRoot}
    <div class="files-empty">
      <p>Project path unavailable — open the PRD from Tasks or Overview.</p>
    </div>
  {:else if mod}
    <mod.default
      {adapter}
      {vaultRoot}
      {prdPath}
      {repoAccess}
      {sessions}
      {ownerName}
    />
  {:else}
    <div class="files-skel" data-testid="project-files-skeleton" aria-label="Loading project files">
      <div class="skel-tree">
        {#each [0, 1, 2, 3, 4, 5] as row (row)}
          <span class="bar" style={`width:${72 - row * 6}%`}></span>
        {/each}
      </div>
      <div class="skel-preview">
        <span class="bar wide"></span>
        <span class="bar"></span>
        <span class="bar"></span>
      </div>
    </div>
  {/if}
</div>

<style>
  .files-host { position: relative; height: 100%; min-height: 280px; }
  .files-empty { padding: 24px 0; color: var(--v4-text-3); }
  .files-skel {
    display: grid;
    grid-template-columns: minmax(220px, 32%) minmax(0, 1fr);
    height: 100%;
    border-top: 1px solid var(--v4-hairline);
    gap: 16px;
    padding: 16px 0;
  }
  .skel-tree, .skel-preview { display: grid; gap: 8px; align-content: start; }
  .bar {
    display: block;
    height: 12px;
    border-radius: 4px;
    background: var(--v4-control-faint);
    animation: files-pulse 1.3s ease-in-out infinite;
  }
  .bar.wide { width: 40%; }
  @keyframes files-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar { animation: none; }
  }
</style>
