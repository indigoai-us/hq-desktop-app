<script lang="ts">
  /**
   * CompanyFileTree — Obsidian-style collapsible folder tree (US-002, made LAZY
   * in US-010; DESKTOP-008 keyboard + filter).
   *
   * The tree LOADS CHILDREN ON FOLDER EXPAND instead of consuming a fully
   * pre-walked tree. This keeps the large HQ root (esp. `repos/`) fast: only
   * the visible level is fetched, and a folder's children are requested the
   * first time it is expanded.
   *
   * Data flow:
   *  - `rootPath` is the HQ-relative directory the tree is rooted at (`''` = HQ
   *    root; `companies/<slug>` when the company filter is active). Changing it
   *    resets the tree and reloads the top level.
   *  - `loadChildren(relPath)` is supplied by the parent and returns that
   *    directory's immediate children as `DirEntry[]` (the lazy `list_hq_dir`
   *    command). This component never calls `invoke()` directly — it stays
   *    presentational + cache-managing.
   *  - `filterQuery` optionally filters loaded nodes by name (DESKTOP-008).
   *
   * Clicking a folder toggles expansion (and lazily fetches its children once);
   * clicking a file fires `onselect(node.path)` with the HQ-relative path.
   *
   * Styling mirrors V4SecondarySidebar's `.v4-row` (28px fixed height, 6px
   * radius, faint hover) via V4 tokens. No purple (hard Indigo policy).
   */
  import {
    dirEntryToLazyNode,
    filterLazyNodes,
    flattenLazy,
    parentPathOf,
    type DirEntry,
    type LazyNode,
  } from '../lib/file-tree';
  import '../v4/tokens.css';

  interface Props {
    /**
     * HQ-relative directory the tree is rooted at. `''` (or `'.'`) = HQ root;
     * `companies/<slug>` scopes to a company. The root row itself is not shown —
     * its immediate children are the top-level rows.
     */
    rootPath?: string;
    /** Lazy children loader (the `list_hq_dir` command), supplied by the parent. */
    loadChildren: (relPath: string) => Promise<DirEntry[]>;
    /** Fired when a FILE row is activated, with its HQ-folder-relative path. */
    onselect?: (path: string) => void;
    /** The currently-selected file path; the matching row is highlighted. */
    selectedPath?: string | null;
    /** Optional case-insensitive name filter over loaded nodes (DESKTOP-008). */
    filterQuery?: string;
  }

  let {
    rootPath = '',
    loadChildren,
    onselect,
    selectedPath = null,
    filterQuery = '',
  }: Props = $props();

  // The lazily-built top-level node list (children of `rootPath`).
  let roots = $state<LazyNode[]>([]);
  // Expansion state keyed by node `path`. Reassigned (new Set) on every change
  // so Svelte's reactivity fires.
  let expanded = $state(new Set<string>());
  // Per-directory load state keyed by path so a spinner / re-fetch guard works.
  let loadingPaths = $state(new Set<string>());
  let rootLoading = $state(false);
  let rootError = $state<string | null>(null);
  // Keyboard focus path (roving tabindex) — independent of file selection.
  let focusedPath = $state<string | null>(null);

  // (Re)load the top level whenever the root path changes. A cancel flag guards
  // against an out-of-order completion when the user switches the filter fast.
  $effect(() => {
    const base = rootPath;
    roots = [];
    expanded = new Set();
    loadingPaths = new Set();
    rootError = null;
    rootLoading = true;
    focusedPath = null;

    let cancelled = false;
    void loadChildren(base)
      .then((entries) => {
        if (!cancelled) roots = entries.map(dirEntryToLazyNode);
      })
      .catch((err) => {
        console.error('list_hq_dir failed:', err);
        if (!cancelled) {
          rootError = String(err);
          roots = [];
        }
      })
      .finally(() => {
        if (!cancelled) rootLoading = false;
      });

    return () => {
      cancelled = true;
    };
  });

  const filteredRoots = $derived(filterLazyNodes(roots, filterQuery));
  const filtering = $derived(filterQuery.trim().length > 0);
  // When filtering, expand loaded dirs so matching descendants stay visible.
  const rows = $derived(
    flattenLazy(filteredRoots, (path) => filtering || expanded.has(path)),
  );

  // Keep keyboard focus on a visible row when the list changes.
  $effect(() => {
    if (rows.length === 0) {
      focusedPath = null;
      return;
    }
    if (focusedPath && rows.some((r) => r.node.path === focusedPath)) return;
    if (selectedPath && rows.some((r) => r.node.path === selectedPath)) {
      focusedPath = selectedPath;
      return;
    }
    focusedPath = rows[0]?.node.path ?? null;
  });

  /** Recursively replace the node at `path` with its loaded children. Pure-ish:
   *  returns a NEW array so Svelte sees the change. */
  function withLoadedChildren(
    nodes: LazyNode[],
    path: string,
    children: LazyNode[],
  ): LazyNode[] {
    return nodes.map((node) => {
      if (node.path === path) {
        return { ...node, loaded: true, children };
      }
      if (node.isDir && node.children && path.startsWith(`${node.path}/`)) {
        return { ...node, children: withLoadedChildren(node.children, path, children) };
      }
      return node;
    });
  }

  async function ensureLoaded(node: LazyNode): Promise<void> {
    if (node.loaded || loadingPaths.has(node.path)) return;
    const next = new Set(loadingPaths);
    next.add(node.path);
    loadingPaths = next;
    try {
      const entries = await loadChildren(node.path);
      roots = withLoadedChildren(roots, node.path, entries.map(dirEntryToLazyNode));
    } catch (err) {
      console.error('list_hq_dir failed:', err);
      // Mark loaded with empty children so we don't spin forever; the empty
      // folder simply shows nothing under it.
      roots = withLoadedChildren(roots, node.path, []);
    } finally {
      const done = new Set(loadingPaths);
      done.delete(node.path);
      loadingPaths = done;
    }
  }

  function toggle(node: LazyNode): void {
    const next = new Set(expanded);
    if (next.has(node.path)) {
      next.delete(node.path);
    } else {
      next.add(node.path);
      // Lazily fetch this folder's children the first time it opens.
      if (!node.loaded) void ensureLoaded(node);
    }
    expanded = next;
  }

  function onRowClick(node: LazyNode): void {
    focusedPath = node.path;
    if (node.isDir) {
      toggle(node); // Folders toggle expansion only — no select fires.
    } else {
      onselect?.(node.path);
    }
  }

  function focusRow(path: string): void {
    focusedPath = path;
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-testid="file-tree-row"][data-path="${CSS.escape(path)}"]`,
      );
      el?.focus();
    });
  }

  /**
   * Keyboard tree navigation (DESKTOP-008): ArrowUp/Down, Home/End move focus;
   * Enter/Space activates (expand folder / select file); ArrowRight/Left expand
   * or collapse folders.
   */
  function handleTreeKeydown(event: KeyboardEvent): void {
    if (rows.length === 0) return;
    const paths = rows.map((r) => r.node.path);
    const index = focusedPath ? paths.indexOf(focusedPath) : -1;
    const current = index >= 0 ? rows[index]?.node : null;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = Math.min(rows.length - 1, Math.max(0, index) + (index < 0 ? 0 : 1));
      focusRow(paths[nextIndex]!);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = Math.max(0, index < 0 ? 0 : index - 1);
      focusRow(paths[nextIndex]!);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusRow(paths[0]!);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusRow(paths[paths.length - 1]!);
      return;
    }
    if (event.key === 'ArrowRight' && current?.isDir) {
      event.preventDefault();
      if (!expanded.has(current.path) && !filtering) {
        toggle(current);
      } else if (current.hasChildren || current.loaded) {
        // Move into first child when already expanded.
        const child = rows[index + 1];
        if (child && child.depth > (rows[index]?.depth ?? 0)) {
          focusRow(child.node.path);
        }
      }
      return;
    }
    if (event.key === 'ArrowLeft' && current) {
      event.preventDefault();
      if (current.isDir && expanded.has(current.path) && !filtering) {
        toggle(current);
      } else {
        const parent = parentPathOf(current.path);
        if (parent && paths.includes(parent)) focusRow(parent);
      }
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && current) {
      event.preventDefault();
      onRowClick(current);
    }
  }

  function rowMeta(node: LazyNode): string {
    const parent = parentPathOf(node.path);
    if (!parent) return node.isDir ? 'Folder' : 'File';
    // Show path relative to tree root when possible.
    const relative =
      rootPath && parent.startsWith(`${rootPath}/`)
        ? parent.slice(rootPath.length + 1)
        : rootPath && parent === rootPath
          ? '.'
          : parent;
    return relative || (node.isDir ? 'Folder' : 'File');
  }
</script>

<div
  class="file-tree"
  role="tree"
  tabindex="-1"
  aria-label="Files"
  data-testid="company-file-tree"
  onkeydown={handleTreeKeydown}
>
  {#if rootLoading}
    <div class="ft-status" aria-label="Loading files" data-testid="file-tree-loading">Loading…</div>
  {:else if rootError}
    <div class="ft-status" role="alert" data-testid="file-tree-error">Files unavailable</div>
  {:else if rows.length === 0}
    <div class="ft-status" data-testid="file-tree-empty">
      {filtering ? 'No matching files' : 'No files'}
    </div>
  {:else}
    {#each rows as { node, depth } (node.path)}
      {#if node.isDir}
        <button
          type="button"
          class="ft-row ft-dir"
          class:focused={node.path === focusedPath}
          style={`padding-left: ${8 + depth * 14}px`}
          role="treeitem"
          aria-expanded={filtering ? true : expanded.has(node.path)}
          aria-selected={node.path === selectedPath}
          tabindex={node.path === focusedPath ? 0 : -1}
          data-testid="file-tree-row"
          data-path={node.path}
          onclick={() => onRowClick(node)}
        >
          <span
            class="ft-chevron"
            class:open={filtering || expanded.has(node.path)}
            class:hidden={!node.hasChildren && !node.loaded}
            aria-hidden="true"
          >
            <svg viewBox="0 0 12 12" width="12" height="12">
              <path d="M4.5 2.5 L8 6 L4.5 9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="ft-copy title-stack">
            <span class="ft-label">{node.name}</span>
            <span class="ft-meta">{rowMeta(node)}</span>
          </span>
          {#if loadingPaths.has(node.path)}
            <span class="ft-spinner" aria-hidden="true"></span>
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="ft-row ft-file"
          class:selected={node.path === selectedPath}
          class:focused={node.path === focusedPath}
          role="treeitem"
          aria-current={node.path === selectedPath ? 'true' : undefined}
          aria-selected={node.path === selectedPath}
          tabindex={node.path === focusedPath ? 0 : -1}
          style={`padding-left: ${8 + (depth + 1) * 14}px`}
          data-testid="file-tree-row"
          data-path={node.path}
          onclick={() => onRowClick(node)}
        >
          <span class="ft-copy title-stack">
            <span class="ft-label">{node.name}</span>
            <span class="ft-meta">{rowMeta(node)}</span>
          </span>
        </button>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .file-tree {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    font-family: var(--font-sans);
  }

  .ft-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 32px;
    height: auto;
    padding: 4px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.2;
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease;
  }

  .ft-row:hover {
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .ft-row:focus-visible {
    outline: 2px solid var(--v4-unread, var(--blue, #0a6fd6));
    outline-offset: 1px;
  }

  /* Selected file row — neutral emphasis (no purple, hard Indigo policy). */
  .ft-row.selected {
    background: var(--v4-control-bg, var(--v4-active-row));
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .ft-copy {
    display: grid;
    flex: 1 1 auto;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .title-stack {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .ft-label {
    overflow: hidden;
    min-width: 0;
    color: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: inherit;
    line-height: 1.25;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .ft-meta {
    overflow: hidden;
    min-width: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.3;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .ft-row.selected .ft-meta {
    color: var(--v4-text-2);
  }

  .ft-chevron {
    display: inline-flex;
    flex: 0 0 12px;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    color: var(--v4-text-3);
    transition: transform 0.12s ease;
  }

  .ft-chevron.open {
    transform: rotate(90deg);
  }

  /* Empty dirs keep the chevron column for alignment but hide the glyph. */
  .ft-chevron.hidden {
    visibility: hidden;
  }

  /* Files have no chevron; pad the label so it aligns past the chevron column. */
  .ft-file .ft-copy {
    padding-left: 18px;
  }

  .ft-spinner {
    flex: 0 0 10px;
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--v4-hairline);
    border-top-color: var(--v4-text-3);
    border-radius: 50%;
    animation: ft-spin 0.7s linear infinite;
  }

  @keyframes ft-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ft-spinner {
      animation: none;
    }

    .ft-chevron,
    .ft-row {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .ft-row.selected {
      background: var(--v4-active-row);
    }
  }

  .ft-status {
    padding: 12px;
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
    text-align: center;
  }
</style>
