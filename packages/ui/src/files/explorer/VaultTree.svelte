<script lang="ts">
  import ReadLoader from "../../common/ReadLoader.svelte";
  /**
   * VaultTree: the lazy folder tree for one vault in the Files explorer.
   *
   * Folders load their children on first expand through `listDir` (the
   * native `list_hq_dir`, which applies the HQ path, noise and company
   * checks). Rows come from one flattened list, and only the rows in view
   * (plus a margin) are in the DOM, so a folder with thousands of files
   * scrolls as smoothly as a small one. Arrow keys move and open, like
   * Obsidian's file pane.
   */
  import { untrack } from "svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";
  import type { RailIconName } from "../../common/button/rail-icons.js";
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
    /** AUDIT-3-22: false when the vault home already shows the one Try again. */
    retryHere?: boolean;
    /** Retries every vault read, not just the tree. */
    onretry?: () => void;
    /** Open every folder as it loads (a filtered tree shows each match). */
    revealAll?: boolean;
    /** A short muted note after a row's name (e.g. "conflict copy"). */
    noteFor?: (entry: TreeEntry) => string | null;
    /** OWNER-R17: a folder row was selected (it also opens or closes). */
    onfocusdir?: (path: string) => void;
    /** Display name for a row (e.g. a note's frontmatter title); null keeps the file name. */
    labelFor?: (entry: TreeEntry) => string | null;
    /** Count shown at the end of a folder row (e.g. files inside). */
    countFor?: (entry: TreeEntry) => number | null;
    /** Small kind icon before a file row's name. */
    iconFor?: (entry: TreeEntry) => RailIconName | null;
  }

  let { vault, listDir, activePath, showSystem, reloadKey, onopen, retryHere = true, onretry, revealAll = false, noteFor, onfocusdir, labelFor, countFor, iconFor }: Props = $props();

  let children = $state<Record<string, TreeEntry[]>>({});
  let expanded = $state<Record<string, boolean>>({});
  let loading = $state<Record<string, boolean>>({});
  let rootError = $state<string | null>(null);
  let focusPath = $state<string | null>(null);
  let generation = 0;

  /** Every row is this tall, which is what lets the tree window its rows. */
  const ROW_HEIGHT = 26;
  /** Rows rendered above and below the visible ones. */
  const OVERSCAN = 12;
  /** Assumed viewport before the tree has been measured. */
  const FALLBACK_VIEWPORT = 640;

  let scroller = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  $effect(() => {
    const el = scroller;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => (viewportHeight = el.clientHeight));
    ro.observe(el);
    viewportHeight = el.clientHeight;
    return () => ro.disconnect();
  });

  async function load(path: string): Promise<void> {
    const gen = generation;
    loading = { ...loading, [path]: true };
    const res = await listDir(path).catch((err: unknown) => {
      console.warn("VaultTree: folder read did not finish:", path, err);
      return { ok: false as const, message: "folder read did not finish" };
    });
    if (gen !== generation) return;
    loading = { ...loading, [path]: false };
    if (!res.ok) {
      // AUDIT-3: plain copy only; the host message goes to the log.
      console.warn("VaultTree: folder read failed:", path, res.message);
      if (path === vault.root) rootError = "Couldn't read this vault.";
      children = { ...children, [path]: [] };
      return;
    }
    const entries = (res.value ?? []).map(toTreeEntry).filter((e): e is TreeEntry => e !== null);
    children = { ...children, [path]: entries };
    if (revealAll) {
      const dirs = entries.filter((e) => e.isDir);
      if (dirs.length) {
        expanded = { ...expanded, ...Object.fromEntries(dirs.map((d) => [d.path, true])) };
        for (const d of dirs) if (!children[d.path]) void load(d.path);
      }
    }
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

  const windowed = $derived.by(() => {
    const height = viewportHeight || FALLBACK_VIEWPORT;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    return { start, rows: rows.slice(start, end) };
  });

  /** Scroll so row `index` is fully visible. */
  function scrollToRow(index: number): void {
    const el = scroller;
    if (!el || index < 0) return;
    const top = index * ROW_HEIGHT;
    const height = el.clientHeight || FALLBACK_VIEWPORT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + height) el.scrollTop = top + ROW_HEIGHT - height;
    scrollTop = el.scrollTop;
  }

  // Keep the open file in view once its folders have loaded.
  let revealed: string | null = null;
  $effect(() => {
    const path = activePath;
    const index = rows.findIndex((r) => r.entry.path === path);
    if (!path || index < 0 || revealed === path) return;
    revealed = path;
    untrack(() => scrollToRow(index));
  });

  function toggle(entry: TreeEntry): void {
    const open = !expanded[entry.path];
    expanded = { ...expanded, [entry.path]: open };
    if (open && !children[entry.path]) void load(entry.path);
  }

  function activate(entry: TreeEntry, newTab: boolean): void {
    focusPath = entry.path;
    if (entry.isDir) {
      toggle(entry);
      onfocusdir?.(entry.path);
    } else onopen(entry.path, { newTab });
  }

  function onkeydown(event: KeyboardEvent): void {
    const idx = rows.findIndex((r) => r.entry.path === focusPath);
    const current = rows[idx]?.entry;
    const move = (to: number) => {
      const index = Math.max(0, Math.min(rows.length - 1, to));
      const row = rows[index];
      if (!row) return;
      focusPath = row.entry.path;
      // The row may be outside the rendered window: scroll it in, let the
      // window re-render, then focus it.
      scrollToRow(index);
      requestAnimationFrame(() => {
        scroller
          ?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(row.entry.path)}"]`)
          ?.focus();
      });
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
    const label = labelFor?.(entry);
    if (label) return label;
    if (entry.isDir) return entry.name;
    return entry.name.replace(/\.(md|markdown)$/i, "");
  }
</script>

<div
  class="vt"
  role="tree"
  aria-label={`${vault.label} files`}
  tabindex="-1"
  {onkeydown}
  bind:this={scroller}
  onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
  data-testid="vault-tree"
>
  {#if rootError}
    <div class="vt-note vt-error" role="alert" data-testid="vault-tree-error">
      <p>{rootError}</p>
      {#if retryHere}
        <RailButton icon="refresh" data-testid="vault-tree-retry" onclick={() => { rootError = null; if (onretry) onretry(); else void load(vault.root); }}>Try again</RailButton>
      {/if}
    </div>
  {:else if loading[vault.root] && !children[vault.root]}
    <ReadLoader testid="vault-tree-loader" onretry={() => { if (onretry) onretry(); else void load(vault.root); }} />
  {:else if rows.length === 0}
    <p class="vt-note">This vault is empty.</p>
  {:else}
    <div class="vt-rows" style={`height:${rows.length * ROW_HEIGHT}px`}>
      <div class="vt-window" style={`transform:translateY(${windowed.start * ROW_HEIGHT}px)`}>
        {#each windowed.rows as row (row.entry.path)}
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
            {#if !entry.isDir && iconFor?.(entry)}
              <span class="vt-kind" aria-hidden="true"><RailIcon name={iconFor(entry)!} size={13} /></span>
            {/if}
            <span class="vt-name">{displayName(entry)}</span>
            {#if noteFor?.(entry)}<span class="vt-note-inline">{noteFor(entry)}</span>{/if}
            {#if !entry.isDir && ext && ext !== "md" && ext !== "markdown"}
              <span class="vt-ext">{ext}</span>
            {/if}
            {#if entry.isDir && countFor?.(entry) != null}
              <span class="vt-count" data-testid="vault-tree-count">{countFor(entry)}</span>
            {/if}
            {#if entry.isDir && loading[entry.path]}
              <span class="vt-spinner" aria-label="Loading"></span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .vt-kind {
    display: inline-flex;
    flex: none;
    margin-right: 2px;
    color: var(--text-3, var(--v4-text-3, currentColor));
  }
  .vt-count {
    flex: none;
    margin-left: auto;
    padding-left: 8px;
    color: var(--text-3, var(--v4-text-3, currentColor));
    font-variant-numeric: tabular-nums;
  }
  .vt-note-inline {
    flex: none;
    margin-left: 6px;
    color: var(--text-3, var(--v4-text-3, currentColor));
    opacity: 0.75;
  }
  .vt {
    box-sizing: border-box;
    height: 100%;
    overflow-y: auto;
    /* OWNER-R13: long names truncate (full name on hover); never a sideways scroll. */
    overflow-x: hidden;
    padding: 4px 6px 16px;
    outline: none;
  }
  .vt-rows {
    position: relative;
  }
  .vt-window {
    display: flex;
    flex-direction: column;
    will-change: transform;
  }
  .vt-row {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 26px;
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
    min-width: 0;
    max-width: 100%;
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
    font-size: 13px;
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
  .vt-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .vt-error p { margin: 0; }
  .vt-note {
    margin: 12px 10px;
    color: var(--v4-text-3);
    font-size: 13px;
  }
  @media (prefers-reduced-motion: reduce) {
    .vt-chevron,
    .vt-spinner {
      transition: none;
      animation: none;
    }
  }
</style>
