<script lang="ts">
  /**
   * VaultTree: the lazy folder tree for one vault in the Files explorer.
   *
   * Folders load their children on first expand through `listDir` (the
   * native `list_hq_dir`, which applies the HQ path, noise and company
   * checks). Rows are rendered from one flattened list so a deep vault stays
   * a flat DOM. Arrow keys move and open, like Obsidian's file pane.
   */
  import { untrack } from "svelte";
  import type { Vault, TreeEntry } from "./vault-model.js";
  import { toTreeEntry, visibleEntries } from "./vault-model.js";

  interface Props {
    vault: Vault;
    listDir: (relPath: string) => Promise<{ ok: true; value: unknown[] } | { ok: false; message?: string }>;
    activePath: string | null;
    showSystem: boolean;
    /** Bumped by the parent to force a reload (vault switch, refresh). */
    reloadKey: number;
    onopen: (path: string, opts: { newTab: boolean }) => void;
  }

  let { vault, listDir, activePath, showSystem, reloadKey, onopen }: Props = $props();

  let children = $state<Record<string, TreeEntry[]>>({});
  let expanded = $state<Record<string, boolean>>({});
  let loading = $state<Record<string, boolean>>({});
  let rootError = $state<string | null>(null);
  let focusPath = $state<string | null>(null);
  let generation = 0;

  async function load(path: string): Promise<void> {
    const gen = generation;
    loading = { ...loading, [path]: true };
    const res = await listDir(path);
    if (gen !== generation) return;
    loading = { ...loading, [path]: false };
    if (!res.ok) {
      if (path === vault.root) rootError = res.message || "This vault could not be read.";
      children = { ...children, [path]: [] };
      return;
    }
    const entries = (res.value ?? []).map(toTreeEntry).filter((e): e is TreeEntry => e !== null);
    children = { ...children, [path]: entries };
  }

  $effect(() => {
    void reloadKey;
    const root = vault.root;
    untrack(() => {
      generation += 1;
      children = {};
      expanded = {};
      loading = {};
      rootError = null;
      void load(root);
    });
  });

  // Reveal the active file: expand its ancestor folders.
  $effect(() => {
    const path = activePath;
    if (!path) return;
    const root = vault.root;
    untrack(() => {
      const parts = path.split("/");
      const start = root ? root.split("/").length : 0;
      const next = { ...expanded };
      let changed = false;
      for (let i = start + 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!next[dir]) {
          next[dir] = true;
          changed = true;
          if (!children[dir]) void load(dir);
        }
      }
      if (changed) expanded = next;
    });
  });

  interface Row {
    entry: TreeEntry;
    depth: number;
  }

  const rows = $derived.by(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const list = visibleEntries(vault, dir, children[dir] ?? [], { showSystem });
      for (const entry of list) {
        out.push({ entry, depth });
        if (entry.isDir && expanded[entry.path]) walk(entry.path, depth + 1);
      }
    };
    walk(vault.root, 0);
    return out;
  });

  function toggle(entry: TreeEntry): void {
    const open = !expanded[entry.path];
    expanded = { ...expanded, [entry.path]: open };
    if (open && !children[entry.path]) void load(entry.path);
  }

  function activate(entry: TreeEntry, newTab: boolean): void {
    focusPath = entry.path;
    if (entry.isDir) toggle(entry);
    else onopen(entry.path, { newTab });
  }

  function onkeydown(event: KeyboardEvent): void {
    const idx = rows.findIndex((r) => r.entry.path === focusPath);
    const current = rows[idx]?.entry;
    const move = (to: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!row) return;
      focusPath = row.entry.path;
      document
        .querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(row.entry.path)}"]`)
        ?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(idx + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(idx - 1);
        break;
      case "ArrowRight":
        if (current?.isDir && !expanded[current.path]) {
          event.preventDefault();
          toggle(current);
        }
        break;
      case "ArrowLeft":
        if (current?.isDir && expanded[current.path]) {
          event.preventDefault();
          toggle(current);
        } else if (current) {
          const parent = current.path.split("/").slice(0, -1).join("/");
          const pIdx = rows.findIndex((r) => r.entry.path === parent);
          if (pIdx >= 0) {
            event.preventDefault();
            move(pIdx);
          }
        }
        break;
      case "Enter":
        if (current) {
          event.preventDefault();
          activate(current, event.metaKey || event.ctrlKey);
        }
        break;
    }
  }

  function extOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }

  function displayName(entry: TreeEntry): string {
    if (entry.isDir) return entry.name;
    return entry.name.replace(/\.(md|markdown)$/i, "");
  }
</script>

<div class="vt" role="tree" aria-label={`${vault.label} files`} tabindex="-1" {onkeydown} data-testid="vault-tree">
  {#if rootError}
    <p class="vt-note" role="status">{rootError}</p>
  {:else if loading[vault.root] && !children[vault.root]}
    <div class="vt-skeleton" aria-hidden="true">
      {#each [72, 54, 64, 40, 58] as w, i (i)}
        <span style={`width:${w}%`}></span>
      {/each}
    </div>
  {:else if rows.length === 0}
    <p class="vt-note">This vault is empty.</p>
  {:else}
    {#each rows as row (row.entry.path)}
      {@const entry = row.entry}
      {@const ext = extOf(entry.name)}
      <button
        type="button"
        class="vt-row"
        class:is-active={!entry.isDir && entry.path === activePath}
        class:is-dir={entry.isDir}
        role="treeitem"
        aria-selected={!entry.isDir && entry.path === activePath}
        aria-expanded={entry.isDir ? !!expanded[entry.path] : undefined}
        tabindex={entry.path === (focusPath ?? rows[0]?.entry.path) ? 0 : -1}
        style={`--depth:${row.depth}`}
        data-tree-path={entry.path}
        data-testid="vault-tree-row"
        title={entry.name}
        onclick={(e) => activate(entry, e.metaKey || e.ctrlKey)}
        onfocus={() => (focusPath = entry.path)}
      >
        {#each Array(row.depth) as _, g (g)}
          <span class="vt-guide" style={`--g:${g}`} aria-hidden="true"></span>
        {/each}
        {#if entry.isDir}
          <svg class="vt-chevron" class:open={!!expanded[entry.path]} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        {:else}
          <span class="vt-chevron-spacer" aria-hidden="true"></span>
        {/if}
        <span class="vt-name">{displayName(entry)}</span>
        {#if !entry.isDir && ext && ext !== "md" && ext !== "markdown"}
          <span class="vt-ext">{ext}</span>
        {/if}
        {#if entry.isDir && loading[entry.path]}
          <span class="vt-spinner" aria-label="Loading"></span>
        {/if}
      </button>
    {/each}
  {/if}
</div>

<style>
  .vt {
    display: flex;
    flex-direction: column;
    padding: 4px 6px 16px;
    outline: none;
  }
  .vt-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 26px;
    padding: 0 8px 0 calc(6px + var(--depth) * 16px);
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }
  .vt-row:hover {
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }
  .vt-row:focus-visible {
    outline: 2px solid var(--v4-focus-ring);
    outline-offset: -2px;
  }
  .vt-row.is-dir {
    color: var(--v4-text-1);
  }
  .vt-row.is-active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
    font-weight: 500;
  }
  .vt-guide {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(13px + var(--g) * 16px);
    width: 1px;
    background: var(--v4-hairline);
  }
  .vt-chevron {
    flex: none;
    width: 14px;
    height: 14px;
    color: var(--v4-text-3);
    transition: transform 120ms ease;
  }
  .vt-chevron.open {
    transform: rotate(90deg);
  }
  .vt-chevron-spacer {
    flex: none;
    width: 14px;
  }
  .vt-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vt-ext {
    flex: none;
    margin-left: auto;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
    font-size: 10px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .vt-spinner {
    flex: none;
    width: 10px;
    height: 10px;
    margin-left: auto;
    border: 1.5px solid var(--v4-hairline);
    border-top-color: var(--v4-text-2);
    border-radius: 50%;
    animation: vt-spin 700ms linear infinite;
  }
  @keyframes vt-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .vt-note {
    margin: 12px 10px;
    color: var(--v4-text-3);
    font-size: 12px;
  }
  .vt-skeleton {
    display: grid;
    gap: 10px;
    padding: 10px;
  }
  .vt-skeleton span {
    height: 10px;
    border-radius: 4px;
    background: var(--v4-control-faint);
  }
  @media (prefers-reduced-motion: reduce) {
    .vt-chevron,
    .vt-spinner {
      transition: none;
      animation: none;
    }
  }
</style>
