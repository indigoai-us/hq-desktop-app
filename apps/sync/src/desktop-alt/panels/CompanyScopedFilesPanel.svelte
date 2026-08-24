<script lang="ts">
  /** Shared company-scoped, read-only tree and preview workspace. */
  import { invoke } from '@tauri-apps/api/core';
  import CompanyFileTree from '../components/CompanyFileTree.svelte';
  import FilePreviewPane from '../components/FilePreviewPane.svelte';
  import {
    companyScopedRoot,
    inCompanyScopedRoot,
    isMissingScopedRootError,
    type CompanyScopedDirectory,
  } from '../lib/company-scoped-files';
  import type { DirEntry } from '../lib/file-tree';
  import '../v4/tokens.css';

  interface Props {
    slug: string;
    directory: CompanyScopedDirectory;
  }

  let { slug, directory }: Props = $props();

  let selectedPath = $state<string | null>(null);
  let searchQuery = $state('');
  let rootMissing = $state(false);

  const isClients = $derived(directory === 'clients');
  const label = $derived(isClients ? 'Clients' : 'Knowledge');
  const labelLower = $derived(label.toLowerCase());
  const rootPath = $derived(companyScopedRoot(slug, directory));
  const searchPlaceholder = $derived(isClients ? 'Search clients…' : 'Search knowledge…');

  $effect(() => {
    slug;
    directory;
    selectedPath = null;
    searchQuery = '';
    rootMissing = false;
  });

  async function loadChildren(relPath: string): Promise<DirEntry[]> {
    if (!inCompanyScopedRoot(relPath, rootPath)) {
      throw new Error(`path outside company ${labelLower} scope: ${relPath}`);
    }
    try {
      return await invoke<DirEntry[]>('list_hq_dir', { relPath });
    } catch (error) {
      if (
        isClients &&
        relPath === rootPath &&
        isMissingScopedRootError(error, rootPath)
      ) {
        rootMissing = true;
        return [];
      }
      throw error;
    }
  }

  function handleSelect(path: string): void {
    if (!inCompanyScopedRoot(path, rootPath)) return;
    selectedPath = path;
  }

  function clearSelection(): void {
    selectedPath = null;
  }

  function focusSearch(): void {
    document
      .querySelector<HTMLInputElement>(`[data-testid="${directory}-search"]`)
      ?.focus();
  }

  function handleWorkspaceKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      focusSearch();
      return;
    }
    if (event.key === 'Escape' && selectedPath) {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea')) return;
      event.preventDefault();
      clearSelection();
    }
  }
</script>

<svelte:window onkeydown={handleWorkspaceKeydown} />

<section
  class="list-detail scoped-files-workspace"
  class:company-clients-panel={isClients}
  class:company-knowledge-panel={!isClients}
  aria-label={label}
  data-testid={`company-${directory}-panel`}
  data-detail-open={selectedPath != null ? 'true' : 'false'}
>
  <aside class="list-pane scoped-tree-pane" data-testid={`${directory}-tree-pane`}>
    <div class="scoped-toolbar title-stack">
      <label class="scoped-search-label">
        <span class="sr-only">Search {labelLower} files</span>
        <input
          type="search"
          class="scoped-search"
          placeholder={searchPlaceholder}
          autocomplete="off"
          spellcheck="false"
          bind:value={searchQuery}
          data-testid={`${directory}-search`}
          aria-label={`Search ${labelLower} files`}
        />
      </label>
      <span class="scoped-scope-meta" data-testid={`${directory}-scope-meta`}>
        {rootPath}
      </span>
    </div>

    <div class="scoped-tree" aria-label={`${label} files`} data-testid={`${directory}-tree`}>
      {#if rootMissing}
        <div
          class="scoped-missing"
          data-testid={`company-${directory}-missing`}
          role="status"
        >
          <span class="scoped-empty-title">No {labelLower} yet</span>
          <p class="scoped-empty-meta">
            {isClients
              ? `Add folders under ${rootPath} and they’ll appear here.`
              : `Add files under ${rootPath} and they’ll appear here.`}
          </p>
        </div>
      {:else}
        {#key rootPath}
          <CompanyFileTree
            {rootPath}
            {loadChildren}
            selectedPath={selectedPath}
            filterQuery={searchQuery}
            onselect={handleSelect}
          />
        {/key}
      {/if}
    </div>
  </aside>

  <div class="detail-pane scoped-preview-pane" data-testid={`${directory}-preview-pane`}>
    {#if selectedPath}
      <button
        type="button"
        class="scoped-detail-back"
        data-testid={`${directory}-detail-back`}
        aria-label={`Back to ${labelLower} tree`}
        onclick={clearSelection}
      >
        {label}
      </button>
      <FilePreviewPane path={selectedPath} />
    {:else}
      <div
        class="scoped-empty"
        data-testid={`company-${directory}-empty`}
        role="status"
        aria-labelledby={`${directory}-empty-title`}
        aria-describedby={`${directory}-empty-description`}
      >
        <span id={`${directory}-empty-title`} class="scoped-empty-title">
          Choose a file to preview
        </span>
        <p id={`${directory}-empty-description`} class="scoped-empty-meta">
          Select a file from the {labelLower} tree, or search by name. Markdown, images, PDFs,
          and text open here.
        </p>
      </div>
    {/if}
  </div>
</section>

<style>
  .scoped-files-workspace {
    gap: 0;
    min-width: 0;
    min-height: 0;
    height: 100%;
    border: 0;
    border-radius: 0;
    background: transparent;
    overflow: hidden;
    font-family: var(--font-sans);
  }

  .scoped-tree-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--v4-hairline);
    background: transparent;
  }

  .scoped-toolbar {
    display: grid;
    flex: 0 0 auto;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    padding: 8px 8px 6px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .scoped-search-label { display: block; min-width: 0; }

  .scoped-search {
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

  .scoped-search::placeholder { color: var(--v4-text-3); }
  .scoped-search:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-text-1));
    outline-offset: 1px;
  }

  .scoped-scope-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scoped-tree {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 6px;
    background: transparent;
    scrollbar-color: var(--v4-hairline) transparent;
    scrollbar-width: thin;
  }

  .scoped-tree::-webkit-scrollbar { width: 6px; }
  .scoped-tree::-webkit-scrollbar-thumb {
    border-radius: var(--v4-radius-pill);
    background: var(--v4-hairline);
  }

  .scoped-preview-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: transparent;
  }

  .scoped-detail-back {
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

  .scoped-detail-back:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .scoped-detail-back:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-text-1));
    outline-offset: 2px;
  }

  .scoped-empty,
  .scoped-missing {
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

  .scoped-empty-title {
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
    line-height: 1.3;
  }

  .scoped-empty-meta {
    margin: 0;
    max-width: 320px;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, var(--text-sm));
    line-height: 1.35;
  }

  .title-stack { display: grid; gap: var(--v4-row-stack-gap, 3px); min-width: 0; }
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
    .scoped-files-workspace[data-detail-open='true'] .scoped-detail-back {
      display: inline-flex;
      align-items: center;
    }
  }
  @media (max-width: 720px) { .scoped-toolbar { padding: 8px 6px 6px; } }
  @media (prefers-reduced-motion: reduce) {
    .scoped-search,
    .scoped-detail-back { transition: none; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .scoped-files-workspace,
    .scoped-tree-pane,
    .scoped-preview-pane { background: var(--v4-ground, #f2f2f2); }
    .scoped-search { background: var(--v4-raised, #fff); }
  }
</style>
