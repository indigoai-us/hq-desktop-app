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
    CHANNEL_FILES_EMPTY_MESSAGE,
    classifyAccessError,
    classifyPreviewError,
    findFileIndexByVaultPath,
    normalizeVaultPath,
    parseChannelFilesResponse,
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
      files = parsed.files;
      listKind = 'ok';
      // Deep-link selection is applied by the highlight effect; otherwise first row.
      if (highlightVaultPath) {
        const idx = findFileIndexByVaultPath(files, highlightVaultPath);
        selectedKey = idx >= 0 ? files[idx]!.key : (files[0]?.key ?? null);
      } else {
        selectedKey = files[0]?.key ?? null;
      }
    } catch (err) {
      if (generation !== loadGeneration) return;
      const kind = classifyAccessError(err);
      files = [];
      selectedKey = null;
      // Unsupported endpoint → clean empty state (never crash).
      listKind = kind === 'unsupported' ? 'unsupported' : kind === 'denied' ? 'denied' : 'generic';
      if (listKind === 'generic') {
        console.error('channel-files-tab: fetch_channel_files failed', err);
      }
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function selectFile(item: ChannelFileItem): void {
    selectedKey = item.key;
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
      <p class="files-denied-title">{CHANNEL_FILES_DENIED_MESSAGE}</p>
    </div>
  {:else}
    <div class="files-split">
      <ul class="files-list" data-testid="channel-files-list" role="listbox" aria-label="Files">
        {#each files as item (item.key)}
          <li role="option" aria-selected={selectedKey === item.key}>
            <button
              type="button"
              class="file-row"
              class:selected={selectedKey === item.key}
              class:highlighted={!!highlightNorm &&
                normalizeVaultPath(item.vaultPath) === highlightNorm}
              data-testid="channel-file-row"
              data-file-key={item.key}
              onclick={() => selectFile(item)}
            >
              <span class="file-icon" aria-hidden="true">
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
              </span>
              <span class="file-name" title={item.vaultPath || item.name}>{item.name}</span>
              <span class="file-meta" title={item.caption}>
                {item.caption}
              </span>
            </button>
          </li>
        {/each}
      </ul>

      <div class="files-preview">
        {#if showPreviewDenied && selected}
          <div class="files-denied preview-denied" data-testid="channel-files-denied" role="status">
            <p class="files-denied-title">{CHANNEL_FILES_DENIED_MESSAGE}</p>
          </div>
        {:else if selectedPath}
          <FilePreviewPane path={selectedPath} />
        {:else}
          <div class="preview-placeholder" role="status">
            Select a file to preview
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .channel-files {
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

  .files-split {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(280px, 1.25fr);
    min-height: 0;
    min-width: 0;
  }

  .files-list {
    list-style: none;
    margin: 0;
    padding: 0.5rem 0;
    overflow-y: auto;
    border-right: 1px solid var(--border, var(--pop-divider));
    min-height: 0;
  }

  .files-list > li {
    margin: 0;
    padding: 0;
  }

  .file-row {
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.5rem 1rem;
    border: none;
    border-left: 2px solid transparent;
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
    border-left-color: var(--fg, var(--pop-text));
  }

  .file-row:focus-visible {
    outline: 2px solid var(--fg, var(--pop-text));
    outline-offset: -2px;
  }

  .file-icon {
    display: inline-flex;
    color: var(--muted-2, var(--pop-muted));
    flex: 0 0 auto;
  }

  .file-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--fg, var(--pop-text));
  }

  .file-meta {
    flex: 0 0 auto;
    margin-left: auto;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: var(--text-micro, 0.6875rem);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted, var(--pop-muted));
    white-space: nowrap;
  }

  .files-preview {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .files-preview :global(.preview-pane) {
    flex: 1;
    min-height: 0;
  }

  .preview-placeholder,
  .preview-denied {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    color: var(--muted-2, var(--pop-muted));
    font-size: var(--text-base);
  }

  .preview-denied {
    align-items: flex-start;
    justify-content: flex-start;
  }
</style>
