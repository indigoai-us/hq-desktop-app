<script lang="ts">
  /**
   * OWNER-R13: a selected folder's contents in the main area (the Vault page
   * turns this on). Loaded lazily by VaultExplorer. Uses the Files tree's
   * filter, so hidden and sensitive names never show.
   */
  import ReadLoader from "../../common/ReadLoader.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  import { breadcrumbs, noteTitle, toTreeEntry, visibleEntries, type TreeEntry, type Vault } from "./vault-model.js";

  interface Props {
    vault: Vault;
    path: string;
    showSystem: boolean;
    listDir: (relPath: string) => Promise<{ ok: true; value: unknown[] } | { ok: false; message?: string }>;
    onfocusfolder: (path: string) => void;
    onopen: (path: string, opts: { newTab: boolean }) => void;
  }

  let { vault, path, showSystem, listDir, onfocusfolder, onopen }: Props = $props();

  let rows = $state<TreeEntry[] | null>(null);
  let failed = $state(false);
  let attempt = $state(0);

  $effect(() => {
    const p = path;
    const v = vault;
    const sys = showSystem;
    void attempt;
    rows = null;
    failed = false;
    let live = true;
    void listDir(p).then((res) => {
      if (!live) return;
      if (!res.ok) {
        console.warn("VaultFolderView: folder read failed:", p, res.message);
        failed = true;
        return;
      }
      const entries = res.value.map(toTreeEntry).filter((e): e is TreeEntry => e !== null);
      rows = visibleEntries(v, p, entries, { showSystem: sys }).sort(
        (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
      );
    });
    return () => {
      live = false;
    };
  });
</script>

<section class="folder" data-testid="vault-folder" aria-label={`${noteTitle(path)} folder`}>
  <nav class="crumbs" aria-label="Location">
    <span>{vault.label}</span>
    {#each breadcrumbs(vault, path) as c (c.path)}
      <span class="sep" aria-hidden="true">/</span>
      <button type="button" class="crumb" onclick={() => onfocusfolder(c.path)}>{c.label}</button>
    {/each}
  </nav>
  {#if failed}
    <div class="error" role="alert" data-testid="vault-folder-error">
      <p class="muted">Couldn't read this folder.</p>
      <RailButton icon="refresh" onclick={() => (attempt += 1)}>Try again</RailButton>
    </div>
  {:else if rows === null}
    <ReadLoader testid="vault-folder-loader" onretry={() => (attempt += 1)} />
  {:else if rows.length === 0}
    <p class="muted">This folder is empty.</p>
  {:else}
    <ul class="list" data-testid="vault-folder-rows">
      {#each rows as e (e.path)}
        <li>
          <button type="button" data-testid="vault-folder-row" title={e.name} onclick={(ev) => (e.isDir ? onfocusfolder(e.path) : onopen(e.path, { newTab: ev.metaKey || ev.ctrlKey }))}>
            <span class="name">{e.isDir ? e.name : noteTitle(e.path)}</span>
            <span class="muted">{e.isDir ? "Folder" : (e.name.split(".").pop() ?? "").toUpperCase()}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .folder { display: grid; gap: 12px; min-width: 0; }
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--v4-text-2); font-size: 13px; }
  .crumb { padding: 0 4px; border: 0; border-radius: 4px; background: none; color: inherit; font: inherit; cursor: pointer; }
  .crumb:hover { background: var(--v4-control-faint); color: var(--v4-text-1); }
  .sep { color: var(--v4-text-3); }
  .list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .list button {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    min-width: 0;
    padding: 7px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .list button:hover { background: var(--v4-control-faint); }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { margin: 0 0 0 auto; color: var(--v4-text-3); }
  .error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
</style>
