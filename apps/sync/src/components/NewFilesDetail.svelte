<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../lib/listener-registry';

  interface NewFile {
    path: string;
    bytes: number;
    addedBy: string | null;
  }

  let files = $state<NewFile[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  onMount(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<NewFile[]>('new-files:list', (event) => {
      files = event.payload;
      loading = false;
      error = null;
    })
      .then(async (off) => {
        if (disposed) {
          safeUnlisten(off)();
          return;
        }
        unlisten = safeUnlisten(off);
        // Rust creates this window hidden. Signal only after the event listener
        // exists so the first payload cannot disappear into the webview startup
        // gap; Rust then emits the snapshot and makes the window visible.
        await invoke('detail_window_ready');
      })
      .catch((reason) => {
        if (disposed) return;
        loading = false;
        error = reason instanceof Error ? reason.message : String(reason);
      });

    return () => {
      disposed = true;
      safeUnlisten(unlisten)();
    };
  });
</script>

<main
  class="new-files-detail"
  data-testid="new-files-detail"
  aria-labelledby="new-files-title"
  aria-busy={loading}
>
  <header class="detail-header" data-tauri-drag-region>
    <div class="title-copy">
      <h1 id="new-files-title">New files</h1>
      <p>Recently added to your synced workspaces</p>
    </div>
    <span class="detail-count" data-testid="new-files-count" aria-live="polite">
      {files.length} file{files.length === 1 ? '' : 's'}
    </span>
  </header>

  {#if loading}
    <div class="detail-state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>Loading file details…</p>
    </div>
  {:else if error}
    <div class="detail-state error" role="alert">
      <strong>File details could not be loaded</strong>
      <p>{error}</p>
    </div>
  {:else if files.length === 0}
    <div class="detail-state" role="status">
      <strong>No new files</strong>
      <p>The synced file list is empty.</p>
    </div>
  {:else}
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Added by</th>
            <th scope="col" class="size-column">Size</th>
          </tr>
        </thead>
        <tbody>
          {#each files as file, index (`${file.path}:${file.addedBy ?? ''}:${index}`)}
            <tr data-testid="new-file-row">
              <td class="path-cell" title={file.path}>{file.path}</td>
              <td class="author-cell">{file.addedBy ?? 'Unknown contributor'}</td>
              <td class="size-cell">{formatBytes(file.bytes)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</main>

<style>
  :global(html[data-window='new-files-detail']),
  :global(html[data-window='new-files-detail'] body),
  :global(html[data-window='new-files-detail'] #app) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    color: var(--c-text);
    font-family: var(--font-sans);
  }

  .new-files-detail {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    overflow: hidden;
    background: var(--compact-glass-bg);
    backdrop-filter: var(--glass-filter, blur(30px) saturate(130%) contrast(102%));
    -webkit-backdrop-filter: var(--glass-filter, blur(30px) saturate(130%) contrast(102%));
    color: var(--c-text);
  }

  .detail-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--compact-glass-hairline);
    flex: 0 0 auto;
  }

  .title-copy {
    display: grid;
    min-width: 0;
    gap: 3px;
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    font-size: 15px;
    font-weight: 650;
    line-height: 1.25;
  }

  .title-copy p,
  .detail-count {
    color: var(--c-muted);
    font-size: 12px;
    line-height: 1.35;
  }

  .detail-count {
    flex: 0 0 auto;
    padding-top: 1px;
    font-variant-numeric: tabular-nums;
  }

  .table-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 13px;
  }

  th,
  td {
    padding: 10px 20px;
    border-bottom: 1px solid var(--compact-glass-hairline);
    text-align: left;
    vertical-align: middle;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: color-mix(in srgb, var(--compact-glass-bg) 92%, transparent);
    backdrop-filter: var(--glass-filter-soft, blur(16px) saturate(120%));
    -webkit-backdrop-filter: var(--glass-filter-soft, blur(16px) saturate(120%));
    color: var(--c-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.045em;
    text-transform: uppercase;
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  .path-cell {
    width: auto;
    overflow: hidden;
    color: var(--c-text);
    font-weight: 520;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .author-cell {
    width: 140px;
    overflow: hidden;
    color: var(--c-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size-column,
  .size-cell {
    width: 72px;
    text-align: right;
  }

  .size-cell {
    color: var(--c-muted);
    font-variant-numeric: tabular-nums;
  }

  .detail-state {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 32px;
    color: var(--c-muted);
    text-align: center;
  }

  .detail-state strong {
    color: var(--c-text);
    font-size: 14px;
    font-weight: 620;
  }

  .detail-state p {
    max-width: 38ch;
    font-size: 12px;
    line-height: 1.45;
  }

  .detail-state.error strong {
    color: var(--c-text);
  }

  .spinner {
    width: 14px;
    height: 14px;
    box-sizing: border-box;
    border: 1.5px solid color-mix(in srgb, var(--c-muted) 28%, transparent);
    border-top-color: var(--c-muted);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (hover: hover) and (pointer: fine) {
    tbody tr:hover {
      background: var(--compact-glass-rail);
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .new-files-detail,
    th {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 1.4s;
    }
  }

  @media (max-width: 520px) {
    .author-cell,
    th:nth-child(2) {
      display: none;
    }

    th,
    td {
      padding-inline: 14px;
    }
  }
</style>
