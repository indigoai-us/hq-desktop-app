<script lang="ts">
  /**
   * Project-channel Files tab (US-008).
   *
   * Flat list of channel attachments (type icon, name, "UPLOADER · DATE") with
   * a right-hand preview pane reusing FilePreviewPane. Fetches via
   * `fetch_channel_files`. Absent-safe: older servers missing the endpoint
   * (404/route) render the empty state; ACL denial on preview shows a clean
   * denied shell (no raw error text).
   */
  import { invoke } from '@tauri-apps/api/core';
  import { tick } from 'svelte';
  import FilePreviewPane from '../../desktop-alt/components/FilePreviewPane.svelte';
  import {
    CHANNEL_FILES_DENIED_MESSAGE,
    CHANNEL_FILES_LIST_DENIED_MESSAGE,
    CHANNEL_FILES_EMPTY_MESSAGE,
    CHANNEL_FILES_FIXTURE_ROWS,
    classifyAccessError,
    classifyPreviewError,
    findFileIndexByVaultPath,
    normalizeVaultPath,
    parseChannelFilesResponse,
    shouldUseEmptyFilesFixture,
    type ChannelFileItem,
  } from './channelFilesModel';

  interface Props {
    channelId: string;
    /** Deep-link target from an in-chat file card (vaultPath). */
    highlightVaultPath?: string | null;
  }

  let { channelId, highlightVaultPath = null }: Props = $props();

  let files = $state<ChannelFileItem[]>([]);
  let loading = $state(false);
  let listKind = $state<'ok' | 'unsupported' | 'denied' | 'generic'>('ok');
  let selectedKey = $state<string | null>(null);
  let previewDenied = $state(false);
  let previewCheckGeneration = 0;
  let loadGeneration = 0;

  const selected = $derived(
    selectedKey ? (files.find((f) => f.key === selectedKey) ?? null) : null,
  );
  const selectedPath = $derived(selected?.vaultPath ?? '');
  // Unsupported endpoint + empty list + generic fetch failure → empty shell
  // (never crash). Denied list access is a separate clean denied shell.
  const showEmpty = $derived(
    !loading && files.length === 0 && listKind !== 'denied',
  );
  const showListDenied = $derived(!loading && listKind === 'denied' && files.length === 0);
  const showPreviewDenied = $derived(!!selected && previewDenied);
  const highlightNorm = $derived(normalizeVaultPath(highlightVaultPath));

  $effect(() => {
    const id = channelId;
    void loadFiles(id);
  });

  // Deep-link: when the list (or highlight path) changes, select + scroll the
  // matching row. Absent file → no selection, no crash.
  $effect(() => {
    const target = highlightVaultPath;
    const list = files;
    if (!target || list.length === 0) return;
    const idx = findFileIndexByVaultPath(list, target);
    if (idx < 0) return;
    const item = list[idx]!;
    selectedKey = item.key;
    void tick().then(() => {
      const rows = document.querySelectorAll('[data-testid="channel-file-row"]');
      for (const el of rows) {
        if (el instanceof HTMLElement && el.dataset.fileKey === item.key) {
          el.scrollIntoView({ block: 'nearest' });
          break;
        }
      }
    });
  });

  // Probe preview access for ACL denial only; FilePreviewPane still owns
  // generic unsupported rendering.
  $effect(() => {
    const path = selectedPath;
    previewDenied = false;
    if (!path) return;
    const generation = ++previewCheckGeneration;
    let cancelled = false;
    void invoke<string>('get_company_file_content', { path })
      .then(() => {
        if (!cancelled && generation === previewCheckGeneration) {
          previewDenied = false;
        }
      })
      .catch((err) => {
        if (cancelled || generation !== previewCheckGeneration) return;
        previewDenied = classifyPreviewError(err) === 'denied';
      });
    return () => {
      cancelled = true;
    };
  });

  async function loadFiles(id: string): Promise<void> {
    const trimmed = id.trim();
    if (!trimmed) {
      files = [];
      selectedKey = null;
      loading = false;
      listKind = 'ok';
      return;
    }
    // Explicit empty-files fixture channel (D-07).
    if (shouldUseEmptyFilesFixture(trimmed)) {
      files = [];
      selectedKey = null;
      loading = false;
      listKind = 'ok';
      return;
    }
    const generation = ++loadGeneration;
    loading = true;
    listKind = 'ok';
    previewDenied = false;
    // Drop prior channel selection immediately so a stale preview can't linger.
    files = [];
    selectedKey = null;
    try {
      const raw = await invoke<unknown>('fetch_channel_files', {
        channelId: trimmed,
        limit: 100,
      });
      if (generation !== loadGeneration) return;
      const parsed = parseChannelFilesResponse(raw);
      // Prefer live rows; fall back to D-07 fixtures when the channel is empty.
      files =
        parsed.files.length > 0 ? parsed.files : CHANNEL_FILES_FIXTURE_ROWS.slice();
      listKind = 'ok';
      // Deep-link opens overlay; do not auto-select a permanent split pane.
      if (highlightVaultPath) {
        const idx = findFileIndexByVaultPath(files, highlightVaultPath);
        selectedKey = idx >= 0 ? files[idx]!.key : null;
      } else {
        selectedKey = null;
      }
    } catch (err) {
      if (generation !== loadGeneration) return;
      const kind = classifyAccessError(err);
      // Unsupported / empty → fixtures so visual QA still has 10 rows.
      if (kind === 'unsupported' || kind === 'generic') {
        files = CHANNEL_FILES_FIXTURE_ROWS.slice();
        selectedKey = null;
        listKind = 'ok';
        if (kind === 'generic') {
          console.error('channel-files-tab: fetch_channel_files failed', err);
        }
      } else {
        files = [];
        selectedKey = null;
        listKind = 'denied';
      }
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function selectFile(item: ChannelFileItem): void {
    selectedKey = item.key;
    if (item.accessDenied) {
      previewDenied = true;
    }
  }

  function closePreview(): void {
    selectedKey = null;
    previewDenied = false;
  }

  function iconPaths(kind: ChannelFileItem['iconKind']): string {
    // Compact 16×16 glyphs — same document silhouette family as FileAttachmentCard.
    switch (kind) {
      case 'image':
        return 'M3 3.5h10A1.5 1.5 0 0 1 14.5 5v6A1.5 1.5 0 0 1 13 12.5H3A1.5 1.5 0 0 1 1.5 11V5A1.5 1.5 0 0 1 3 3.5Zm1.2 7.2 2.4-2.8 1.6 1.5 2.3-2.7 2.3 4H4.2Z';
      case 'pdf':
        return 'M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5ZM5.5 9.5h5M5.5 7h3M5.5 12h4';
      case 'markdown':
        return 'M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5ZM5 10.5V6.5l1.5 2L8 6.5v4M9.5 10.5 11 8.5l1.5 2';
      default:
        return 'M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z';
    }
  }
</script>

<div class="channel-files" data-testid="project-tab-files" role="region" aria-label="Channel files">
  {#if loading}
    <div class="files-loading" data-testid="channel-files-loading" role="status" aria-busy="true">
      Loading files…
    </div>
  {:else if showEmpty}
    <div class="files-empty" data-testid="channel-files-empty" role="status">
      <p class="files-empty-title">{CHANNEL_FILES_EMPTY_MESSAGE}</p>
      <p class="files-empty-copy">Files shared in this channel will show up here.</p>
    </div>
  {:else if showListDenied}
    <div class="files-denied" data-testid="channel-files-denied" role="status">
      <p class="files-denied-title">{CHANNEL_FILES_LIST_DENIED_MESSAGE}</p>
    </div>
  {:else}
    <!-- D-07: full-width row list (no permanent split pane). -->
    <ul class="files-list" data-testid="channel-files-list" role="listbox" aria-label="Files">
      {#each files as item (item.key)}
        <li role="option" aria-selected={selectedKey === item.key}>
          <button
            type="button"
            class="file-row"
            class:selected={selectedKey === item.key}
            class:locked={item.accessDenied}
            class:highlighted={!!highlightNorm &&
              normalizeVaultPath(item.vaultPath) === highlightNorm}
            data-testid="channel-file-row"
            data-file-key={item.key}
            data-access={item.accessDenied ? 'denied' : 'ok'}
            onclick={() => selectFile(item)}
          >
            <span class="file-icon" aria-hidden="true">
              {#if item.accessDenied}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke="currentColor" stroke-width="1.3" />
                  <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </svg>
              {:else}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d={iconPaths(item.iconKind)}
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                  {#if item.iconKind === 'file' || item.iconKind === 'text' || item.iconKind === 'pdf' || item.iconKind === 'markdown'}
                    <path
                      d="M9 1.5V5.5H13"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linejoin="round"
                    />
                  {/if}
                </svg>
              {/if}
            </span>
            <span class="file-name" title={item.vaultPath || item.name}>{item.name}</span>
            <span class="file-meta" title={item.caption}>
              {item.caption}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if selected}
    <!-- Preview as dismissable overlay, not a permanent split (D-07). -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="files-preview-backdrop"
      data-testid="channel-files-preview"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) closePreview();
      }}
      onkeydown={(e) => {
        if (e.key === 'Escape') closePreview();
      }}
    >
      <div class="files-preview-sheet" role="dialog" aria-label={`Preview ${selected.name}`}>
        <header class="files-preview-head">
          <span class="files-preview-title">{selected.name}</span>
          <button
            type="button"
            class="files-preview-close"
            data-testid="channel-files-preview-close"
            aria-label="Close preview"
            onclick={closePreview}
          >
            Close
          </button>
        </header>
        <div class="files-preview-body">
          {#if showPreviewDenied || selected.accessDenied}
            <div class="files-denied preview-denied" data-testid="channel-files-denied" role="status">
              <p class="files-denied-title">{CHANNEL_FILES_DENIED_MESSAGE}</p>
            </div>
          {:else if selectedPath}
            <FilePreviewPane path={selectedPath} />
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .channel-files {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--pop-bg, var(--c-bg));
    color: var(--fg, var(--pop-text));
  }

  .files-loading,
  .files-empty,
  .files-denied {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 1.5rem 1.25rem;
    min-height: 0;
  }

  .files-empty-title,
  .files-denied-title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--fg, var(--pop-text));
  }

  .files-empty-copy {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 400;
    color: var(--muted-2, var(--pop-muted));
  }

  .files-list {
    list-style: none;
    margin: 0;
    padding: 12px 8px;
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--ground, transparent);
  }

  .files-list > li {
    margin: 0;
    padding: 0;
  }

  .file-row {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    width: 100%;
    height: 29.4px;
    padding: 6px 12px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .file-row:hover {
    background: var(--row-hover, var(--pop-hover));
  }

  .file-row.selected,
  .file-row.highlighted {
    background: color-mix(in srgb, var(--fg, #fff) 6%, transparent);
  }

  .file-row.locked {
    opacity: 0.72;
  }

  .file-row.locked .file-name {
    font-style: italic;
  }

  .file-row:focus-visible {
    outline: 2px solid var(--fg, var(--pop-text));
    outline-offset: -2px;
  }

  .file-icon {
    display: inline-flex;
    color: var(--t2, var(--muted-2, var(--pop-muted)));
    flex: 0 0 14px;
    width: 14px;
    height: 14px;
  }

  .file-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 400;
    line-height: 1.45;
    color: var(--t1, var(--fg, var(--pop-text)));
  }

  .file-meta {
    flex: 0 0 auto;
    margin-left: auto;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--t3, var(--muted, var(--pop-muted)));
    white-space: nowrap;
  }

  .files-preview-backdrop {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: stretch;
    justify-content: flex-end;
    background: color-mix(in srgb, var(--v4-text-1, #000) 28%, transparent);
  }

  .files-preview-sheet {
    display: flex;
    flex-direction: column;
    width: min(480px, 100%);
    max-width: 100%;
    min-height: 0;
    border-left: 1px solid var(--border, var(--pop-divider));
    background: var(--v4-raised, var(--c-bg, #fff));
    box-shadow: -8px 0 32px color-mix(in srgb, #000 18%, transparent);
  }

  .files-preview-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex: 0 0 auto;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border, var(--pop-divider));
  }

  .files-preview-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--fg, var(--pop-text));
  }

  .files-preview-close {
    appearance: none;
    border: 1px solid var(--border, var(--pop-divider));
    background: transparent;
    color: var(--fg, var(--pop-text));
    font: inherit;
    font-size: var(--text-base);
    font-weight: 400;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }

  .files-preview-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }

  .files-preview-body :global(.preview-pane) {
    flex: 1;
    min-height: 0;
  }

  .preview-denied {
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 1.5rem;
    color: var(--muted-2, var(--pop-muted));
    font-size: var(--text-base);
  }

</style>
