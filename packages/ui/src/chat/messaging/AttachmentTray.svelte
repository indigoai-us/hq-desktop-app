<script lang="ts">
  /**
   * Attachment preview modal. Click a file in the timeline to browse the
   * conversation's assets without taking a sidebar column.
   */
  import { onDestroy, onMount } from "svelte";
  import type { ImagePreviewCache } from "./image-preview-cache";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import X from "phosphor-svelte/lib/X";
  import AttachmentPreview from "./AttachmentPreview.svelte";

  interface Props {
    items: FileAttachmentModel[];
    previewCache?: ImagePreviewCache | null;
    selectedId: string | null;
    /**
     * Kept for hosts that still pass it; the tray no longer switches between
     * attachments. A filmstrip under a full-window image was a second way to
     * do what clicking the next thumbnail in the message already does, and it
     * took a band off the bottom of every preview to offer it.
     */
    onselect?: (id: string) => void;
    onclose: () => void;
    resolveUrl?: (attachment: FileAttachmentModel) => Promise<string | null>;
    /** Releases host-created object URLs used for browser-strip thumbnails. */
    onreleaseurl?: (url: string) => void;
    onopenurl?: (url: string) => void;
  }

  let { items, selectedId, onselect: _onselect, onclose, resolveUrl, onreleaseurl, previewCache }: Props = $props();

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
    <!-- The preview's own toolbar is the tray's title bar; the close button
         rides in it. Naming the file in a header here as well meant the user
         read the same filename twice, six lines apart. -->
    {#snippet closeButton()}
      <button
        type="button"
        class="att-preview-ic"
        data-testid="attachment-tray-close"
        aria-label="Close attachments"
        onclick={onclose}
      >
        <X size={14} weight="bold" aria-hidden="true" />
      </button>
    {/snippet}

    <div class="att-tray-stage" data-testid="attachment-tray-stage">
      {#if !selected}
        <header class="att-tray-empty-head">
          {@render closeButton()}
        </header>
        <p class="att-tray-empty">No attachments in this conversation.</p>
      {:else}
        {#key selected.id || selected.vaultPath}
          <AttachmentPreview
            item={selected}
            thumbnailUrl={previewCache ? srcFor(selected) : null}
            {resolveUrl}
            {onreleaseurl}
            trailing={closeButton}
          />
        {/key}
      {/if}
    </div>

  </div>
</div>

<style>
  /* Concept `.lb`: a scrim over the shell rather than a card floating on
     one. The card wasted a band of dark chrome on every side and still cut
     the browser strip off at the bottom. */
  .att-modal {
    position: absolute;
    inset: 0;
    z-index: 10000;
    display: flex;
    background: rgba(0, 0, 0, 0.74);
    backdrop-filter: blur(4px);
    pointer-events: auto;
  }

  .att-tray {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: transparent;
    /* Fixed ink: the scrim is dark in both themes (see AttachmentPreview). */
    color: #fff;
  }

  .att-tray-stage {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .att-tray-empty-head {
    flex: 0 0 auto;
    display: flex;
    justify-content: flex-end;
    height: 46px;
    padding: 0 14px;
    align-items: center;
  }

  .att-tray-stage :global(.att-preview) {
    flex: 1 1 auto;
    min-height: 0;
  }

  .att-tray-empty {
    flex: 1 1 auto;
    display: grid;
    place-items: center;
    margin: 0;
    color: rgba(255, 255, 255, 0.55);
    font: 400 12px/1.3 var(--font-ui);
  }
</style>
