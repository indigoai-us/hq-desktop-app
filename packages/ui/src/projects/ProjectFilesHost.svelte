<script lang="ts">
  /**
   * First frame of the Project Files tab. The loader paints before the
   * body chunk loads (US-025). Nothing here imports ProjectFilesBody.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
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
    /** File to select when the pane opens, e.g. from a README link (QA-104). */
    openPath?: string | null;
  }

  let {
    adapter,
    vaultRoot,
    prdPath = null,
    repoAccess = true,
    sessions = [],
    ownerName = "You",
    openPath = null,
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
      {openPath}
      {ownerName}
    />
  {:else}
    <ReadLoader testid="project-files-loading" />
  {/if}
</div>

<style>
  .files-host { position: relative; height: 100%; min-height: 280px; }
  .files-empty { padding: 24px 0; color: var(--v4-text-3); }
</style>
