<script lang="ts">
  import { dismissable } from "../common/dismissable.js";
  /**
   * Reusable vault-folder picker. Selection is a background highlight only.
   * Paths are labels; this component does not read the vault.
   */
  interface FolderRow {
    path: string;
    note?: string;
  }

  interface Props {
    folders: readonly FolderRow[];
    onchoose: (path: string) => void;
    onclose: () => void;
  }

  let { folders, onchoose, onclose }: Props = $props();
  let query = $state("");
  let current = $state("");

  const rows = $derived(
    folders.filter((folder) => folder.path.toLowerCase().includes(query.trim().toLowerCase())),
  );
</script>

<div class="fp" role="dialog" aria-label="Choose folder" data-testid="folder-picker" use:dismissable={{ onclose, trap: false }}>
  <input class="fp-q" placeholder="Filter folders" bind:value={query} data-testid="folder-picker-filter" />
  <div class="fp-list">
    {#each rows as folder (folder.path)}
      <button
        type="button"
        class="fp-li"
        aria-pressed={current === folder.path}
        data-testid="folder-picker-row"
        onclick={() => (current = folder.path)}
      >
        <span class="fp-nm">{folder.path}</span>
        {#if folder.note}<span class="fp-note">{folder.note}</span>{/if}
      </button>
    {:else}
      <p class="fp-note">No folders match.</p>
    {/each}
  </div>
  <div class="fp-f">
    <span class="fp-note">{current || "Choose a folder"}</span>
    <button type="button" onclick={onclose}>Cancel</button>
    <button type="button" data-testid="folder-picker-choose" disabled={!current} onclick={() => onchoose(current)}>Choose</button>
  </div>
</div>

<style>
  .fp {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    background: var(--v4-popover, var(--v4-raised, transparent));
    color: var(--v4-text-1, inherit);
    font-family: var(--font-ui, inherit);
  }
  .fp-q, .fp-f button {
    border: 1px solid var(--v4-control-border, transparent);
    background: transparent;
    color: inherit;
    border-radius: 8px;
    padding: 6px 8px;
    font: inherit;
  }
  .fp-list { overflow: auto; min-height: 0; display: flex; flex-direction: column; }
  .fp-li {
    text-align: left;
    border: 0;
    background: transparent;
    color: inherit;
    border-radius: 8px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
  }
  .fp-li[aria-pressed="true"] { background: var(--v4-active-row, transparent); }
  .fp-nm { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
  .fp-note { font-size: var(--type-metadata, 12px); color: var(--v4-text-3, inherit); }
  .fp-f { display: flex; align-items: center; gap: 8px; }
  .fp-f .fp-note { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
