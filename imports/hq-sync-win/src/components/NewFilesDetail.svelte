<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';

  interface NewFile {
    path: string;
    bytes: number;
    addedBy: string | null;
  }

  // Inline-popover mode: App.svelte hands in `initialFiles` so we skip the
  // Rust ready-handshake. Without `onback` the back arrow is hidden and
  // the component renders the legacy standalone-window UI.
  interface Props {
    initialFiles?: NewFile[];
    onback?: () => void;
  }
  let { initialFiles = [], onback }: Props = $props();

  let files = $state<NewFile[]>(initialFiles ?? []);

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  $effect(() => {
    // Inline mode: data came in as a prop, no Rust handshake needed.
    if (initialFiles && initialFiles.length > 0) {
      return;
    }

    let unlisten: (() => void) | undefined;
    listen<NewFile[]>('new-files:list', (event) => {
      files = event.payload;
    }).then((fn) => {
      unlisten = fn;
      invoke('detail_window_ready');
    });

    return () => {
      unlisten?.();
    };
  });
</script>

<div class="detail-window">
  <header class="detail-header">
    {#if onback}
      <button
        type="button"
        class="detail-back"
        title="Back"
        aria-label="Back"
        onclick={() => onback?.()}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    {/if}
    <h1>New Files</h1>
    <span class="detail-count">{files.length} file{files.length === 1 ? '' : 's'}</span>
  </header>

  {#if files.length === 0}
    <div class="detail-empty">
      <p>Waiting for file data...</p>
    </div>
  {:else}
    <div class="detail-list">
      <div class="detail-list-header">
        <span class="col-path">File</span>
        <span class="col-author">Added by</span>
        <span class="col-size">Size</span>
      </div>
      {#each files as file}
        <div class="detail-row">
          <span class="col-path detail-path" title={file.path}>
            {file.path}
          </span>
          <span class="col-author detail-author">
            {file.addedBy ?? 'Unknown'}
          </span>
          <span class="col-size detail-size">
            {formatBytes(file.bytes)}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .detail-window {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    border-radius: 4px;
    background: var(--popover-bg, rgba(18, 18, 20, 0.68));
    backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    -webkit-backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    color: var(--popover-text, #e0e0e0);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    overflow: hidden;
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--popover-divider, rgba(255, 255, 255, 0.06));
    flex-shrink: 0;
  }

  .detail-back {
    background: transparent;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    color: var(--popover-text-heading, #ffffff);
    border-radius: 7px;
    width: 26px;
    height: 26px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    -webkit-app-region: no-drag;
  }
  .detail-back:hover {
    background: var(--popover-action-hover, rgba(255, 255, 255, 0.1));
  }

  .detail-header h1 {
    flex: 1;
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--popover-text-heading, #ffffff);
  }

  .detail-count {
    font-size: 0.75rem;
    color: var(--popover-text-muted, #a0a0b0);
  }

  .detail-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .detail-empty p {
    font-size: 0.8125rem;
    color: var(--popover-text-muted, #a0a0b0);
    margin: 0;
  }

  .detail-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 0;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
  }

  .detail-list::-webkit-scrollbar {
    width: 6px;
  }

  .detail-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .detail-list::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.12);
    border-radius: 3px;
  }

  .detail-list:hover::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.22);
  }

  .detail-list-header {
    display: flex;
    align-items: center;
    padding: 0.375rem 1.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--popover-text-muted, #a0a0b0);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--popover-divider, rgba(255, 255, 255, 0.06));
  }

  .detail-row {
    display: flex;
    align-items: center;
    padding: 0.5rem 1.25rem;
    font-size: 0.8125rem;
    border-bottom: 1px solid var(--popover-divider, rgba(255, 255, 255, 0.06));
    transition: background-color 0.1s ease;
  }

  .detail-row:last-child {
    border-bottom: none;
  }

  .detail-row:hover {
    background: var(--popover-action-hover, rgba(255, 255, 255, 0.05));
  }

  .col-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .col-author {
    width: 140px;
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    padding-left: 0.75rem;
  }

  .col-size {
    width: 70px;
    flex-shrink: 0;
    text-align: right;
    padding-left: 0.75rem;
  }

  .detail-path {
    color: var(--popover-text, #e0e0e0);
  }

  .detail-author {
    color: var(--popover-text-muted, #a0a0b0);
    font-size: 0.75rem;
  }

  .detail-size {
    color: var(--popover-text-muted, #a0a0b0);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
</style>
