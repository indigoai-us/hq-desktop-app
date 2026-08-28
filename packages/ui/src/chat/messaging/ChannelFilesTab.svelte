<script lang="ts">
  /**
   * ChannelFilesTab — the project channel's Files view, ported faithfully from
   * the hq-sync desktop `components/messaging/ChannelFilesTab.svelte` MARKUP +
   * CSS (full-width row list + dismissable preview overlay).
   *
   * ZERO NETWORK / platform-pure: the file list is INJECTED as fixture rows and
   * the preview body renders the row's authored `previewText` — there is no
   * Tauri invoke, no `fetch_channel_files`, no self-fetching FilePreviewPane.
   * The host owns the data.
   */
  import type {
    ChannelFileIconKind,
    ChannelFileItemModel,
  } from "./channelTabModels";

  interface Props {
    files: ChannelFileItemModel[];
  }

  let { files }: Props = $props();

  let selectedKey = $state<string | null>(null);
  const selected = $derived<ChannelFileItemModel | null>(
    selectedKey ? (files.find((f) => f.key === selectedKey) ?? null) : null,
  );

  function selectFile(item: ChannelFileItemModel): void {
    selectedKey = item.key;
  }

  function closePreview(): void {
    selectedKey = null;
  }

  function iconPaths(kind: ChannelFileIconKind): string {
    // Compact 16×16 glyphs — same document silhouette family as the desktop.
    switch (kind) {
      case "image":
        return "M3 3.5h10A1.5 1.5 0 0 1 14.5 5v6A1.5 1.5 0 0 1 13 12.5H3A1.5 1.5 0 0 1 1.5 11V5A1.5 1.5 0 0 1 3 3.5Zm1.2 7.2 2.4-2.8 1.6 1.5 2.3-2.7 2.3 4H4.2Z";
      case "pdf":
        return "M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5ZM5.5 9.5h5M5.5 7h3M5.5 12h4";
      case "markdown":
        return "M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5ZM5 10.5V6.5l1.5 2L8 6.5v4M9.5 10.5 11 8.5l1.5 2";
      default:
        return "M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z";
    }
  }
</script>

<div
  class="channel-files chat-shell"
  data-testid="project-tab-files"
  role="region"
  aria-label="Channel files"
>
  {#if files.length === 0}
    <div class="files-empty" data-testid="channel-files-empty" role="status">
      <p class="files-empty-title">No files yet</p>
      <p class="files-empty-copy">
        Files shared in this channel will show up here.
      </p>
    </div>
  {:else}
    <!-- Full-width row list (no permanent split pane). -->
    <ul
      class="files-list"
      data-testid="channel-files-list"
      role="listbox"
      aria-label="Files"
    >
      {#each files as item (item.key)}
        <li role="option" aria-selected={selectedKey === item.key}>
          <button
            type="button"
            class="file-row"
            class:selected={selectedKey === item.key}
            class:locked={item.accessDenied}
            data-testid="channel-file-row"
            data-file-key={item.key}
            data-access={item.accessDenied ? "denied" : "ok"}
            onclick={() => selectFile(item)}
          >
            <span class="file-icon" aria-hidden="true">
              {#if item.accessDenied}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect
                    x="3.5"
                    y="7"
                    width="9"
                    height="6.5"
                    rx="1"
                    stroke="currentColor"
                    stroke-width="1.3"
                  />
                  <path
                    d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                  />
                </svg>
              {:else}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d={iconPaths(item.iconKind)}
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                  {#if item.iconKind === "file" || item.iconKind === "text" || item.iconKind === "pdf" || item.iconKind === "markdown"}
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
            <span class="file-name" title={item.vaultPath || item.name}
              >{item.name}</span
            >
            <span class="file-meta" title={item.caption}>{item.caption}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if selected}
    <!-- Preview as dismissable overlay, not a permanent split. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="files-preview-backdrop"
      data-testid="channel-files-preview"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) closePreview();
      }}
      onkeydown={(e) => {
        if (e.key === "Escape") closePreview();
      }}
    >
      <div
        class="files-preview-sheet"
        role="dialog"
        aria-label={`Preview ${selected.name}`}
      >
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
          {#if selected.accessDenied}
            <div class="files-denied preview-denied" role="status">
              <p class="files-denied-title">
                You don't have access to this file.
              </p>
            </div>
          {:else}
            <div class="preview-meta">
              {selected.caption} · {selected.vaultPath}
            </div>
            <pre class="preview-text">{selected.previewText ??
                "No preview available."}</pre>
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
    color: var(--t1);
  }

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
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
  }

  .files-empty-copy {
    margin: 0;
    font-size: 13px;
    font-weight: 400;
    color: var(--t2);
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
    background: transparent;
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
    background: var(--hover, var(--pop-hover));
  }

  .file-row.selected {
    background: color-mix(in srgb, var(--t1) 6%, transparent);
  }

  .file-row.locked {
    opacity: 0.72;
  }

  .file-row.locked .file-name {
    font-style: italic;
  }

  .file-row:focus-visible {
    outline: 2px solid var(--t1);
    outline-offset: -2px;
  }

  .file-icon {
    display: inline-flex;
    color: var(--t2);
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
    color: var(--t1);
  }

  .file-meta {
    flex: 0 0 auto;
    margin-left: auto;
    font-family: var(
      --font-mono,
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace
    );
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--t3);
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
    border-left: 1px solid var(--line);
    background: var(--elevated, var(--raised));
    box-shadow: -8px 0 32px color-mix(in srgb, #000 18%, transparent);
  }

  .files-preview-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex: 0 0 auto;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--line);
  }

  .files-preview-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
  }

  .files-preview-close {
    appearance: none;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }

  .files-preview-close:hover {
    background: var(--hover);
  }

  .files-preview-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
  }

  .preview-meta {
    font-family: var(
      --font-mono,
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace
    );
    font-size: 10px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--t3);
  }

  .preview-text {
    margin: 0;
    font-family: var(
      --font-mono,
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace
    );
    font-size: 12px;
    line-height: 1.5;
    color: var(--t2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .preview-denied {
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 1.5rem;
    color: var(--t2);
    font-size: 13px;
  }
</style>
