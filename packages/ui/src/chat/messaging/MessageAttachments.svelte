<script lang="ts">
  /**
   * Inline attachment strip on a chat message: image thumbs + file cards.
   * Clicking opens the host's attachments tray (zero network here).
   */
  import type { FileAttachmentModel } from "./channelMessageModels";
  import { attachmentPreviewKind } from "./attachment-preview";
  import { fileTypeLabel } from "./chat-attachments";

  interface Props {
    attachments: FileAttachmentModel[];
    onopen?: (attachment: FileAttachmentModel) => void;
    resolveUrl?: (attachment: FileAttachmentModel) => Promise<string | null>;
  }

  let { attachments, onopen, resolveUrl }: Props = $props();

  let urls = $state<Record<string, string>>({});
  let broken = $state<Record<string, boolean>>({});

  function isImage(item: FileAttachmentModel): boolean {
    return (
      attachmentPreviewKind({
        name: item.name,
        contentType: item.contentType,
        kind: item.kind,
      }) === "image"
    );
  }

  const imageCount = $derived(attachments.filter(isImage).length);

  $effect(() => {
    if (!resolveUrl) return;
    for (const item of attachments) {
      if (!isImage(item)) continue;
      const key = item.id || item.vaultPath;
      if (urls[key] || item.previewUrl) continue;
      // Host resolver owns companyUid fallback — don't gate on item.companyUid.
      if (!item.vaultPath) continue;
      void resolveUrl(item).then((url) => {
        if (url) urls = { ...urls, [key]: url };
      });
    }
  });

  function srcFor(item: FileAttachmentModel): string {
    const key = item.id || item.vaultPath;
    if (broken[key]) return "";
    return item.previewUrl || urls[key] || "";
  }

  function markBroken(item: FileAttachmentModel): void {
    const key = item.id || item.vaultPath;
    broken = { ...broken, [key]: true };
  }
</script>

{#if attachments.length > 0}
  <div class="msg-attachments" data-testid="message-attachments">
    {#each attachments as item (item.id || item.vaultPath)}
      {#if isImage(item)}
        <button
          type="button"
          class="att-thumb"
          class:is-single={imageCount === 1}
          data-testid="attachment-thumb"
          aria-label={`Open ${item.name}`}
          onclick={() => onopen?.(item)}
        >
          {#if srcFor(item)}
            <img
              src={srcFor(item)}
              alt={item.name}
              onerror={() => markBroken(item)}
            />
          {:else}
            <span class="att-thumb-fallback">{item.name}</span>
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="att-card"
          data-testid="attachment-card"
          aria-label={`Open ${item.name}`}
          onclick={() => onopen?.(item)}
        >
          <span class="att-icon" aria-hidden="true"
            >{fileTypeLabel(item.name, item.contentType)}</span
          >
          <span class="att-copy">
            <span class="att-name">{item.name}</span>
            {#if item.sizeLabel}
              <span class="att-meta">{item.sizeLabel}</span>
            {/if}
          </span>
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .msg-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }

  .att-thumb {
    appearance: none;
    position: relative;
    flex: 0 0 auto;
    width: 160px;
    height: 120px;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--sel);
    cursor: pointer;
  }

  .att-thumb.is-single {
    width: auto;
    height: auto;
    max-width: 320px;
    max-height: 220px;
  }

  .att-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .att-thumb.is-single img {
    width: auto;
    height: auto;
    max-width: 320px;
    max-height: 220px;
    object-fit: contain;
  }

  .att-thumb-fallback {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    color: var(--t2);
    font: 600 11px/1 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.06em;
  }

  .att-card {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 160px;
    max-width: 240px;
    padding: 8px 10px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: var(--sel, rgba(255, 255, 255, 0.05));
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .att-card:hover,
  .att-thumb:hover {
    background: var(--hover, rgba(255, 255, 255, 0.08));
  }

  .att-icon {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--t2);
    font: 700 9px/1 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.04em;
  }

  .att-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .att-name {
    overflow: hidden;
    color: var(--t1);
    font: 500 12px/1.3 var(--font-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .att-meta {
    color: var(--t3, var(--t2));
    font: 400 11px/1.2 var(--font-ui);
  }
</style>
