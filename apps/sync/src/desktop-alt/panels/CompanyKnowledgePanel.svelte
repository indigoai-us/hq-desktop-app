<script lang="ts">
  /**
   * CompanyKnowledgePanel — inline company Knowledge tab (US-014).
   *
   * Tenant-scoped file tree + preview for `companies/<slug>/knowledge` only.
   * Uses the shared lazy CompanyFileTree + FilePreviewPane; does not jump to
   * global Files mode.
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

  const rootPath = $derived(`companies/${slug}/knowledge`);

  // Reset selection when the company changes.
  $effect(() => {
    slug;
    selectedPath = null;
  });

  // HQ root for open/reveal actions — fetched once on mount.
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
</script>

<section
  class="company-knowledge-panel"
  aria-label="Knowledge"
  data-testid="company-knowledge-panel"
>
  <div class="knowledge-tree" aria-label="Knowledge files">
    {#key rootPath}
      <CompanyFileTree
        {rootPath}
        {loadChildren}
        selectedPath={selectedPath}
        onselect={handleSelect}
      />
    {/key}
  </div>

  <div class="knowledge-preview">
    {#if selectedPath}
      <FilePreviewPane path={selectedPath} {hqFolderPath} />
    {:else}
      <div class="knowledge-empty" data-testid="company-knowledge-empty">
        Select a knowledge file to preview it
      </div>
    {/if}
  </div>
</section>

<style>
  .company-knowledge-panel {
    display: flex;
    gap: 0;
    min-width: 0;
    min-height: 0;
    height: 100%;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card, 10px);
    background: var(--v4-raised);
    overflow: hidden;
    font-family: var(--font-sans);
  }

  .knowledge-tree {
    flex: 0 0 260px;
    width: 260px;
    min-width: 240px;
    max-width: 280px;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 6px;
    border-right: 1px solid var(--v4-hairline);
    background: var(--v4-chrome);
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

  .knowledge-preview {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    background: var(--v4-raised);
  }

  .knowledge-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    padding: 24px;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    line-height: 20px;
    text-align: center;
  }
</style>
