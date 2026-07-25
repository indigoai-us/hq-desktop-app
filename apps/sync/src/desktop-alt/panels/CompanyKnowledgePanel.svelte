<script lang="ts">
  /**
   * CompanyKnowledgePanel — company Knowledge workspace (US-014 / DESKTOP-008).
   *
   * Compact stable workspace: search + tenant-scoped file tree + selected
   * document preview for `companies/<slug>/knowledge` only.
   *
   * Does not jump to global Files mode. Path guard (`inKnowledgeScope`) is
   * defense-in-depth on top of backend HQ-root checks — do not weaken it.
   *
   * DESKTOP-008: naked hairline tree/preview split, list-detail collapse,
   * keyboard-friendly search/tree, semantic type roles, reduced motion.
   */
  import { invoke } from '@tauri-apps/api/core';
  import CompanyFileTree from '../components/CompanyFileTree.svelte';
  import FilePreviewPane from '../components/FilePreviewPane.svelte';
  import type { DirEntry } from '../lib/file-tree';
  import '../v4/tokens.css';

  interface Props {
    slug: string;
  }

  let { slug }: Props = $props();

  let selectedPath = $state<string | null>(null);
  let hqFolderPath = $state('');
  let searchQuery = $state('');

  const rootPath = $derived(`companies/${slug}/knowledge`);

  // Reset selection + search when the company changes.
  $effect(() => {
    slug;
    selectedPath = null;
    searchQuery = '';
  });

  // HQ root for open/reveal/copy actions — fetched once on mount.
  $effect(() => {
    let cancelled = false;
    void invoke<{ hqFolderPath?: string }>('get_config')
      .then((config) => {
        if (!cancelled) hqFolderPath = config.hqFolderPath ?? '';
      })
      .catch((err) => {
        console.error('CompanyKnowledgePanel get_config failed:', err);
        if (!cancelled) hqFolderPath = '';
      });
    return () => {
      cancelled = true;
    };
  });

  /** True iff `path` sits at or under this company's knowledge subtree. The
   *  backend commands only enforce "inside HQ root", so the tenant boundary
   *  for this panel is enforced here too (defense-in-depth). */
  function inKnowledgeScope(path: string): boolean {
    return path === rootPath || path.startsWith(`${rootPath}/`);
  }

  function loadChildren(relPath: string): Promise<DirEntry[]> {
    if (!inKnowledgeScope(relPath)) {
      return Promise.reject(new Error(`path outside company knowledge scope: ${relPath}`));
    }
    return invoke<DirEntry[]>('list_hq_dir', { relPath });
  }

  function handleSelect(path: string): void {
    if (!inKnowledgeScope(path)) return;
    selectedPath = path;
  }

  function clearSelection(): void {
    selectedPath = null;
  }

  function focusSearch(): void {
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="knowledge-search"]',
    );
    el?.focus();
  }

  /** Cmd/Ctrl+F focuses search; Escape clears selection on narrow detail. */
  function handleWorkspaceKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      focusSearch();
      return;
    }
    if (event.key === 'Escape' && selectedPath) {
      // Let inputs keep Escape for clearing their own value first.
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea')) return;
      event.preventDefault();
      clearSelection();
    }
  }
</script>

<svelte:window onkeydown={handleWorkspaceKeydown} />

<section
  class="list-detail knowledge-workspace company-knowledge-panel"
  aria-label="Knowledge"
  data-testid="company-knowledge-panel"
  data-detail-open={selectedPath != null ? 'true' : 'false'}
>
  <aside class="list-pane knowledge-tree-pane" data-testid="knowledge-tree-pane">
    <div class="knowledge-toolbar title-stack">
      <label class="knowledge-search-label">
        <span class="sr-only">Search knowledge files</span>
        <input
          type="search"
          class="knowledge-search"
          placeholder="Search knowledge…"
          autocomplete="off"
          spellcheck="false"
          bind:value={searchQuery}
          data-testid="knowledge-search"
          aria-label="Search knowledge files"
        />
      </label>
      <span class="knowledge-scope-meta" data-testid="knowledge-scope-meta">
        companies/{slug}/knowledge
      </span>
    </div>

    <div class="knowledge-tree" aria-label="Knowledge files" data-testid="knowledge-tree">
      {#key rootPath}
        <CompanyFileTree
          {rootPath}
          {loadChildren}
          selectedPath={selectedPath}
          filterQuery={searchQuery}
          onselect={handleSelect}
        />
      {/key}
    </div>
  </aside>

  <div class="detail-pane knowledge-preview-pane" data-testid="knowledge-preview-pane">
    {#if selectedPath}
      <button
        type="button"
        class="knowledge-detail-back"
        data-testid="knowledge-detail-back"
        aria-label="Back to knowledge tree"
        onclick={clearSelection}
      >
        Knowledge
      </button>
      <FilePreviewPane path={selectedPath} {hqFolderPath} />
    {:else}
      <div class="knowledge-empty" data-testid="company-knowledge-empty">
        <span class="knowledge-empty-title">Select a knowledge file</span>
        <p class="knowledge-empty-meta">
          Browse or search the company knowledge tree to preview markdown, images, PDFs, and text.
        </p>
      </div>
    {/if}
  </div>
</section>

<style>
  /* DESKTOP-008: naked canvas, hairline tree/preview split — no rounded outer shell. */
  .company-knowledge-panel,
  .knowledge-workspace {
    gap: 0;
    min-width: 0;
    min-height: 0;
    height: 100%;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    overflow: hidden;
    font-family: var(--font-sans);
  }

  .knowledge-tree-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--v4-hairline);
    background: transparent;
  }

  .knowledge-toolbar {
    display: grid;
    flex: 0 0 auto;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    padding: 8px 8px 6px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .knowledge-search-label {
    display: block;
    min-width: 0;
  }

  .knowledge-search {
    box-sizing: border-box;
    width: 100%;
    min-height: 28px;
    padding: 4px 8px;
    border: 1px solid var(--v4-control-border, var(--v4-hairline));
    border-radius: 6px;
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    line-height: 1.25;
  }

  .knowledge-search::placeholder {
    color: var(--v4-text-3);
  }

  .knowledge-search:focus-visible {
    outline: 2px solid var(--v4-unread, var(--blue, #0a6fd6));
    outline-offset: 1px;
  }

  .knowledge-scope-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .knowledge-tree {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 6px;
    background: transparent;
    scrollbar-color: var(--v4-hairline) transparent;
    scrollbar-width: thin;
  }

  .knowledge-tree::-webkit-scrollbar {
    width: 6px;
  }

  .knowledge-tree::-webkit-scrollbar-thumb {
    border-radius: var(--v4-radius-pill);
    background: var(--v4-hairline);
  }

  .knowledge-preview-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: transparent;
  }

  .knowledge-detail-back {
    display: none;
    align-self: flex-start;
    flex: 0 0 auto;
    min-height: 24px;
    margin: 8px 10px 0;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button, 6px);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 500;
    cursor: pointer;
  }

  .knowledge-detail-back:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .knowledge-detail-back:focus-visible {
    outline: 2px solid var(--v4-unread, var(--blue, #0a6fd6));
    outline-offset: 2px;
  }

  .knowledge-empty {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--v4-row-stack-gap, 3px);
    min-height: 200px;
    padding: 24px;
    text-align: center;
  }

  .knowledge-empty-title {
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1.3;
  }

  .knowledge-empty-meta {
    margin: 0;
    max-width: 280px;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 400;
    line-height: 1.35;
  }

  .title-stack {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 820px) {
    /* Shared .list-detail hides the list pane when detail is open.
       Surface a back control so the tree remains reachable. */
    .knowledge-workspace[data-detail-open='true'] .knowledge-detail-back {
      display: inline-flex;
      align-items: center;
    }
  }

  @media (max-width: 720px) {
    .knowledge-toolbar {
      padding: 8px 6px 6px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .knowledge-search,
    .knowledge-detail-back {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .company-knowledge-panel,
    .knowledge-workspace,
    .knowledge-tree-pane,
    .knowledge-preview-pane {
      background: var(--v4-ground, #f7f8fa);
    }

    .knowledge-search {
      background: var(--v4-raised, #fff);
    }
  }
</style>
