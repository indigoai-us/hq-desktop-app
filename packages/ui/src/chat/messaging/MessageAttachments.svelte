<script lang="ts">
  /**
   * Inline attachment strip on a chat message: image thumbs + file cards.
   * Clicking opens the host's attachments tray (zero network here).
   */
  import { onDestroy } from "svelte";
  import type { ImagePreviewCache } from "./image-preview-cache";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import { attachmentPreviewKind } from "./attachment-preview";
  import { fileTypeLabel } from "./chat-attachments";

  interface Props {
    attachments: FileAttachmentModel[];
    previewCache?: ImagePreviewCache | null;
    vaultCompanyUid?: string | null;
    onopen?: (attachment: FileAttachmentModel) => void;
    resolveUrl?: (attachment: FileAttachmentModel) => Promise<string | null>;
    /** Releases host-created object URLs when this strip leaves the DOM. */
    onreleaseurl?: (url: string) => void;
  }

  let { attachments, onopen, resolveUrl, onreleaseurl, previewCache, vaultCompanyUid }: Props = $props();
  let urls = $state<Record<string, string>>({});
  let broken = $state<Record<string, boolean>>({});
  let retryVersion = $state(0);
  const requests = new Map<string, { cancel: () => void }>();
  function scopeFor(item: FileAttachmentModel): string { return item.companyUid || vaultCompanyUid || ""; }
  function keyFor(item: FileAttachmentModel): string { return JSON.stringify([previewCache?.instanceId, scopeFor(item), item.vaultPath, item.id]); }
  function isImage(item: FileAttachmentModel): boolean {
    return attachmentPreviewKind({ name: item.name, contentType: item.contentType, kind: item.kind }) === "image";
  }
  function usesCache(item: FileAttachmentModel): boolean {
    return !!previewCache && !!scopeFor(item) && item.contentType !== "image/svg+xml" && !/\.svg$/i.test(item.name);
  }
  const imageCount = $derived(attachments.filter(isImage).length);

  onDestroy(() => { for (const request of requests.values()) request.cancel(); });

  $effect(() => {
    void retryVersion;
    const cache = previewCache;
    const resolve = resolveUrl;
    const releaseUrl = onreleaseurl;
    const items = attachments.filter(isImage);
    const keys = new Set(items.map(keyFor));
    for (const [key, request] of requests) {
      if (!keys.has(key)) { request.cancel(); requests.delete(key); }
    }
    for (const item of items) {
      const key = keyFor(item);
      if (item.previewUrl || !item.vaultPath || requests.has(key)) continue;
      const scope = scopeFor(item);
      const cached = cache && usesCache(item);
      if (!cached && !resolve) continue;
      let cancelled = false;
      let release: (() => void) | undefined;
      requests.set(key, { cancel: () => { cancelled = true; release?.(); } });
      const work = cached
        ? cache.acquire(scope, item.vaultPath)
        : resolve!(item).then((url) => url ? { url, release: () => releaseUrl?.(url) } : null);
      void work.then((lease) => {
        if (cancelled) { lease?.release(); return; }
        if (!lease) { broken = { ...broken, [key]: true }; return; }
        release = lease.release;
        urls = { ...urls, [key]: lease.url };
      }).catch(() => {
        if (!cancelled) broken = { ...broken, [key]: true };
      });
    }
    // An account/cache replacement releases every lease before the next effect.
    return () => {
      for (const request of requests.values()) request.cancel();
      requests.clear();
    };
  });

  function srcFor(item: FileAttachmentModel): string {
    const key = keyFor(item);
    const resolved = urls[key]; // Track async acquisition even though cache.peek is synchronous.
    if (broken[key]) return "";
    // Synchronous lookup: a warm chat has an image in its very first render.
    return item.previewUrl || (usesCache(item)
      ? previewCache!.peek(scopeFor(item), item.vaultPath)?.url || ""
      : resolved || "");
  }
  function markBroken(item: FileAttachmentModel): void {
    broken = { ...broken, [keyFor(item)]: true };
    void previewCache?.invalidate(scopeFor(item), item.vaultPath).catch((error) => {
      console.warn("[image-preview] Could not discard broken preview", error);
    });
  }
  function activate(item: FileAttachmentModel): void {
    const key = keyFor(item);
    if (!broken[key]) { onopen?.(item); return; }
    requests.get(key)?.cancel();
    requests.delete(key);
    urls = { ...urls, [key]: "" };
    broken = { ...broken, [key]: false };
    retryVersion++;
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
          aria-label={broken[keyFor(item)] ? `Retry ${item.name}` : `Open ${item.name}`}
          onclick={() => activate(item)}
        >
          {#if srcFor(item)}
            <img
              src={srcFor(item)}
              alt={item.name}
              onerror={() => markBroken(item)}
            />
          {:else}
            <span class="att-thumb-fallback" class:is-loading={!broken[keyFor(item)]} role="status">{broken[keyFor(item)] ? "Image unavailable · Retry" : "Loading image…"}</span>
          {/if}
          <!-- Concept `.msg-img-meta`: the tile names itself in a small pill
               on the artwork, rather than in a caption row beneath it. -->
          <span class="att-thumb-meta">{item.name}</span>
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
  /* `align-items: flex-start` so a document card keeps its own height —
     stretched to an image tile's height it read as a tall empty panel. */
  .msg-attachments {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px;
    margin-top: 8px;
  }

  /* Concept `.msg-img`: a 320x168 tile on a hairline that only warms on
     hover. The old 220px-tall single-image tile dominated the timeline. */
  .att-thumb {
    appearance: none;
    position: relative;
    display: flex;
    align-items: flex-end;
    flex: 0 0 auto;
    width: 160px;
    height: 120px;
    padding: 10px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--raised);
    cursor: pointer;
    transition: border-color 0.12s;
  }

  /* A lone image hugs its own artwork. The fixed 320x168 box letterboxed
     anything that was not 40:21 — a portrait shot sat in a wide tile with
     dead margin down both sides. Here the tile shrink-wraps the image and
     only the cap (320 wide / 220 tall) constrains it. */
  .att-thumb.is-single {
    width: auto;
    height: auto;
    max-width: min(320px, 100%);
    padding: 0;
  }

  .att-thumb:hover {
    border-color: var(--line2);
  }

  /* The artwork fills the tile; the pill sits on top of it. */
  .att-thumb img {
    position: absolute;
    inset: 0;
  }

  .att-thumb-meta {
    position: relative;
    max-width: 100%;
    padding: 3px 7px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.42);
    color: rgba(255, 255, 255, 0.86);
    font: 400 9px/1.4 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.03em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .att-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* In flow, not `inset: 0` — the image is what gives the tile its size. */
  .att-thumb.is-single img {
    position: static;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 220px;
    object-fit: contain;
  }

  .att-thumb.is-single .att-thumb-meta {
    position: absolute;
    left: 10px;
    bottom: 10px;
    max-width: calc(100% - 20px);
  }

  /* Nothing to hug yet, so the placeholder keeps the old box. */
  .att-thumb.is-single .att-thumb-fallback {
    width: 320px;
    height: 168px;
  }

  .att-thumb-fallback {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    color: var(--t2);
    font: 400 13px/1.4 var(--font-ui);
  }

  /* Same tile language as the image, sized to its own content: a document
     has no thumbnail, so it states what it is instead of faking one. */
  .att-card {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 240px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--raised);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.12s;
  }

  .att-card:hover {
    border-color: var(--line2);
  }

  .att-icon {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    background: var(--btn-bg);
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
