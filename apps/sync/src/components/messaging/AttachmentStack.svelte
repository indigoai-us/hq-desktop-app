<script lang="ts">
  /**
   * Square file-card stack for a `file_share` DM. Shows up to four tiles
   * (type badge + name) and a `+N` overflow tile. Clicking any tile fires
   * `onopen` — US-008 attaches the picker; this component does not open one.
   */
  import {
    attachmentStackItems,
    attachmentTypeBadge,
    isFolderAttachment,
    type MessageAttachment,
  } from '../../lib/messageAttachments';

  interface Props {
    attachments: MessageAttachment[];
    /** Resolved sender display name for the group label. */
    senderName?: string;
    onopen?: () => void;
    /** Folder tiles skip the preview and open Files. */
    onfolder?: (attachment: MessageAttachment) => void;
  }

  let { attachments, senderName = '', onopen, onfolder }: Props = $props();

  const layout = $derived(attachmentStackItems(attachments));
  const sender = $derived(senderName.trim() || 'Someone');
  const groupLabel = $derived(
    attachments.length === 1
      ? `${sender} shared ${attachments[0]?.name ?? 'a file'}`
      : `${sender} shared ${attachments.length} files`,
  );

  function open(): void {
    onopen?.();
  }

  function openTile(item: MessageAttachment): void {
    if (isFolderAttachment(item) && onfolder) {
      onfolder(item);
      return;
    }
    open();
  }
</script>

<ul
  class="attachment-stack"
  data-testid="attachment-stack"
  aria-label={groupLabel}
>
  {#each layout.visible as item (item.id || item.vaultPath)}
    <li>
    <button
      type="button"
      class="attachment-tile"
      class:attachment-tile-folder={isFolderAttachment(item)}
      data-testid="attachment-tile"
      data-kind={isFolderAttachment(item) ? 'folder' : 'file'}
      aria-label={item.name}
      onclick={() => openTile(item)}
    >
      <span class="tile-icon" aria-hidden="true">
        {#if isFolderAttachment(item)}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.2c.3 0 .58.16.73.42L7.5 4.5H12A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4A1.5 1.5 0 0 1 2.5 11.5V4.5Z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
          </svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
            <path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
        {/if}
        <span class="tile-badge">{attachmentTypeBadge(item)}</span>
      </span>
      <span class="tile-name">{item.name}</span>
    </button>
    </li>
  {/each}
  {#if layout.overflow > 0}
    <li>
    <button
      type="button"
      class="attachment-tile attachment-tile-more"
      data-testid="attachment-tile-more"
      aria-label={`+${layout.overflow} more files`}
      onclick={open}
    >
      <span class="tile-more">+{layout.overflow}</span>
    </button>
    </li>
  {/if}
</ul>

<style>
  .attachment-stack {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .attachment-tile {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 72px;
    height: 72px;
    padding: 8px 6px 6px;
    border: 1px solid var(--border, var(--pop-border, rgba(255, 255, 255, 0.14)));
    border-radius: 10px;
    background: var(--surface-raise, var(--elevated, #1e1e24));
    color: var(--fg, var(--pop-text, #e8e8e8));
    cursor: pointer;
    text-align: center;
  }

  .attachment-tile:hover {
    border-color: var(--border-strong, var(--line2, rgba(255, 255, 255, 0.22)));
  }

  .attachment-tile:focus-visible {
    outline: 2px solid var(--vio-ink, currentColor);
    outline-offset: 2px;
  }

  .tile-icon {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: var(--muted-2, var(--pop-muted, #a0a0a0));
  }

  .tile-badge {
    position: absolute;
    right: -6px;
    bottom: -4px;
    padding: 0 3px;
    border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.18));
    border-radius: 3px;
    background: var(--surface-raise, #1e1e24);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.04em;
    line-height: 1.3;
    color: var(--muted-2, #a0a0a0);
  }

  .tile-name {
    max-width: 100%;
    overflow: hidden;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-tile-more {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }

  .tile-more {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--fg, var(--pop-text, #e8e8e8));
  }
</style>
