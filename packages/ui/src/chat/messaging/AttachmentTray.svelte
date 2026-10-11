<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * Attachment lightbox. Click an image or document in the timeline to see it
   * full-window on a blurred scrim, with one bar for its name, size, download
   * and close.
   */
  import { onDestroy, onMount } from "svelte";
  import type { ImagePreviewCache } from "./image-preview-cache";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import AttachmentPreview from "./AttachmentPreview.svelte";

  interface Props {
    items: FileAttachmentModel[];
    previewCache?: ImagePreviewCache | null;
    selectedId: string | null;
    /**
     * Kept for hosts that still pass it; the lightbox no longer switches
     * between attachments. A filmstrip of thumbnails under the full-window
     * image duplicated what clicking the next thumbnail in the message
     * already does, and took a band off the bottom of every preview.
     */
    onselect?: (id: string) => void;
    onclose: () => void;
    resolveUrl?: (attachment: FileAttachmentModel) => Promise<string | null>;
    /** Releases host-created object URLs used for browser-strip thumbnails. */
    onreleaseurl?: (url: string) => void;
    onopenurl?: (url: string) => void;
  }

  let { items, selectedId, onclose, resolveUrl, onreleaseurl, previewCache }: Props = $props();

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
    <!-- The preview's own bar is the lightbox's title bar; close rides in
         it. A header here as well named the same file twice, six lines
         apart. -->
    {#snippet closeButton()}
      <button
        type="button"
        class="att-preview-ic"
        data-testid="attachment-tray-close"
        aria-label="Close attachments"
        onclick={onclose}
      >
        <RailIcon name="x" size={14} />
      </button>
    {/snippet}

    <div
      class="att-tray-stage"
      data-testid="attachment-tray-stage"
      onclick={(e) => {
        // The scrim is full-bleed now, so the empty stage around the artwork
        // is the "outside" — a click there dismisses, as the scrim beyond
        // the old card did. Clicks on the artwork or the bar do not.
        const target = e.target as Element | null;
        if (
          target === e.currentTarget ||
          target?.classList?.contains("att-preview-stage")
        ) {
          onclose();
        }
      }}
      role="presentation"
    >
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
  /* A full-bleed scrim over the shell rather than a dark card floating on
     one: the card spent a band of chrome on every side and still clipped
     the strip at its foot. The scrim is dark in BOTH themes — that is what
     makes the fixed light ink below correct in light mode too. */
  .att-modal {
    position: absolute;
    inset: 0;
    z-index: 10000;
    display: flex;
    background: rgba(0, 0, 0, 0.74);
    -webkit-backdrop-filter: blur(4px);
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
    /* Fixed ink: the scrim is dark in BOTH themes, so the themed
       `--t1`/`--t2`/`--t3` (near-black in light mode) made the title, close
       button and empty-state text invisible. */
    --lb-ink: #fff;
    --lb-ink-mid: rgba(255, 255, 255, 0.72);
    --lb-ink-dim: rgba(255, 255, 255, 0.55);
    --lb-hover: rgba(255, 255, 255, 0.14);
    --lb-line: rgba(255, 255, 255, 0.08);
    color: var(--lb-ink);
  }

  .att-tray:focus {
    outline: none;
  }

  .att-tray-stage {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .att-tray-stage :global(.att-preview) {
    flex: 1 1 auto;
    min-height: 0;
  }

  /* With nothing to preview there is no preview bar, so close gets a bar of
     the same height of its own. */
  .att-tray-empty-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    height: 46px;
    box-sizing: border-box;
    padding: 0 14px;
  }

  .att-tray-empty-head :global(.att-preview-ic) {
    appearance: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--lb-ink);
    cursor: pointer;
  }

  .att-tray-empty-head :global(.att-preview-ic:hover) {
    background: var(--lb-hover);
  }

  .att-tray-empty {
    flex: 1 1 auto;
    display: grid;
    place-items: center;
    margin: 0;
    color: var(--lb-ink-dim);
    font: 400 12px/1.3 var(--font-ui);
  }
</style>
