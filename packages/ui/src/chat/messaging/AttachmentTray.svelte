<script lang="ts">
  /**
   * Attachment preview modal. Click a file in the timeline to browse the
   * conversation's assets without taking a sidebar column.
   */
  import { onDestroy, onMount } from "svelte";
  import type { ImagePreviewCache } from "./image-preview-cache";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import { fileTypeLabel } from "./chat-attachments";
  import AttachmentPreview from "./AttachmentPreview.svelte";

  interface Props {
    items: FileAttachmentModel[];
    previewCache?: ImagePreviewCache | null;
    selectedId: string | null;
    onselect: (id: string) => void;
    onclose: () => void;
    resolveUrl?: (attachment: FileAttachmentModel) => Promise<string | null>;
    /** Releases host-created object URLs used for browser-strip thumbnails. */
    onreleaseurl?: (url: string) => void;
    onopenurl?: (url: string) => void;
  }

  let { items, selectedId, onselect, onclose, resolveUrl, onreleaseurl, previewCache }: Props = $props();

  const selected = $derived(
    items.find((item) => (item.id || item.vaultPath) === selectedId) ??
      items[0] ??
      null,
  );

  let urls = $state<Record<string, string>>({});
  const resolving = new Set<string>();
  const leases = new Map<string, () => void>();
  let modalEl = $state<HTMLDivElement | null>(null);
  let dialogEl = $state<HTMLDivElement | null>(null);
  let mounted = true;

  onDestroy(() => {
    mounted = false;
    for (const release of leases.values()) release();
  });

  $effect(() => {
    const item = selected;
    if (!item) return;
    const key = item.id || item.vaultPath;
    if (item.previewUrl || urls[key] || resolving.has(key)) return;
    if (!resolveUrl) return;
    resolving.add(key);
    const work = previewCache && item.kind === "image" && item.contentType !== "image/svg+xml" && !/\.svg$/i.test(item.name)
      ? previewCache.acquire(item.companyUid, item.vaultPath)
      : resolveUrl(item).then((url) => url ? { url, release: () => onreleaseurl?.(url) } : null);
    void work.then((lease) => {
        if (!lease) return;
        if (!mounted) { lease.release(); return; }
        leases.set(key, lease.release);
        urls = { ...urls, [key]: lease.url };
      })
      .catch(() => {
        // The preview pane renders the actionable error state for this item.
      })
      .finally(() => resolving.delete(key));
  });

  function srcFor(item: FileAttachmentModel): string {
    const resolved = urls[item.id || item.vaultPath];
    return item.previewUrl || previewCache?.peek(item.companyUid, item.vaultPath)?.url || resolved || "";
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    }
  }

  onMount(() => {
    // Stay inside `.desktop-shell`. Moving this node to `document.body`
    // survives Svelte HMR and leaves a full-window click shield.
    dialogEl?.focus();
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener("keydown", onWindowKey);
    return () => {
      window.removeEventListener("keydown", onWindowKey);
    };
  });
</script>

<div
  bind:this={modalEl}
  class="att-modal"
  data-testid="attachment-tray"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="att-tray"
    bind:this={dialogEl}
    role="dialog"
    aria-modal="true"
    aria-label="Attachments"
    tabindex="-1"
    onkeydown={onKey}
  >
    <header class="att-tray-head">
      <div class="att-tray-title-wrap">
        <p class="att-tray-kicker">Attachments</p>
        <h2 class="att-tray-title">{selected?.name ?? "No file"}</h2>
      </div>
      <button
        type="button"
        class="att-tray-close"
        data-testid="attachment-tray-close"
        aria-label="Close attachments"
        onclick={onclose}
      >
        ×
      </button>
    </header>

    <div class="att-tray-stage" data-testid="attachment-tray-stage">
      {#if !selected}
        <p class="att-tray-empty">No attachments in this conversation.</p>
      {:else}
        {#key selected.id || selected.vaultPath}
          <AttachmentPreview item={selected} thumbnailUrl={previewCache ? srcFor(selected) : null} {resolveUrl} {onreleaseurl} />
        {/key}
      {/if}
    </div>

    <nav class="att-tray-browser" aria-label="Attachment browser">
      {#each items as item (item.id || item.vaultPath)}
        {@const id = item.id || item.vaultPath}
        <button
          type="button"
          class="att-tray-item"
          class:active={selected && id === (selected.id || selected.vaultPath)}
          data-testid="attachment-tray-item"
          onclick={() => onselect(id)}
        >
          {#if (item.kind === "image" || /\.(png|jpe?g|gif|webp|svg)$/i.test(item.name)) && srcFor(item)}
            <img src={srcFor(item)} alt="" />
          {:else}
            <span class="att-tray-item-icon"
              >{fileTypeLabel(item.name, item.contentType)}</span
            >
          {/if}
          <span class="att-tray-item-name">{item.name}</span>
        </button>
      {/each}
    </nav>
  </div>
</div>

<style>
  .att-modal {
    position: absolute;
    inset: 0;
    z-index: 10000;
    display: grid;
    place-items: center;
    padding: 28px 32px;
    background: rgba(8, 8, 10, 0.78);
    pointer-events: auto;
  }

  .att-tray {
    display: flex;
    flex-direction: column;
    width: min(1100px, calc(100% - 8px));
    height: calc(100% - 8px);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    background: #161618;
    color: var(--t1, #e8e8e8);
  }

  .att-tray-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 16px 12px;
    border-bottom: 1px solid var(--line2, rgba(255, 255, 255, 0.08));
  }

  .att-tray-kicker {
    margin: 0 0 4px;
    color: var(--t3, var(--t2));
    font: 600 10px/1 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .att-tray-title {
    margin: 0;
    font: 600 14px/1.3 var(--font-ui);
    overflow-wrap: anywhere;
  }

  .att-tray-close {
    appearance: none;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
  }

  .att-tray-close:hover {
    background: var(--hover, rgba(255, 255, 255, 0.08));
  }

  .att-tray-stage {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: 16px 20px;
    overflow: auto;
    background: #161618;
  }

  .att-tray-stage :global(.att-preview) {
    height: 100%;
  }

  .att-tray-stage :global(.att-preview-stage) {
    height: 100%;
  }

  .att-tray-stage :global(.att-preview-image) {
    max-height: 100%;
  }

  .att-tray-image {
    max-width: 100%;
    max-height: 100%;
    border-radius: 8px;
    object-fit: contain;
  }

  .att-tray-file {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
  }

  .att-tray-file-icon {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.08);
    font: 700 12px/1 var(--font-mono, ui-monospace, Menlo, monospace);
  }

  .att-tray-file-name {
    margin: 0;
    font: 500 13px/1.3 var(--font-ui);
    overflow-wrap: anywhere;
  }

  .att-tray-file-meta,
  .att-tray-empty {
    margin: 0;
    color: var(--t3, var(--t2));
    font: 400 12px/1.3 var(--font-ui);
  }

  .att-tray-open {
    appearance: none;
    margin-top: 6px;
    padding: 6px 12px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 6px;
    background: var(--btn-bg, rgba(255, 255, 255, 0.07));
    color: inherit;
    cursor: pointer;
  }

  .att-tray-browser {
    display: flex;
    gap: 8px;
    padding: 12px 16px 16px;
    overflow-x: auto;
    border-top: 1px solid var(--line2, rgba(255, 255, 255, 0.08));
  }

  .att-tray-item {
    appearance: none;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 4px;
    width: 72px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .att-tray-item.active {
    border-color: var(--ice-ink, #c9d6e4);
  }

  .att-tray-item img,
  .att-tray-item-icon {
    width: 72px;
    height: 56px;
    border-radius: 6px;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.06);
  }

  .att-tray-item-icon {
    display: grid;
    place-items: center;
    font: 700 10px/1 var(--font-mono, ui-monospace, Menlo, monospace);
  }

  .att-tray-item-name {
    overflow: hidden;
    color: var(--t3, var(--t2));
    font: 400 10px/1.2 var(--font-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
