<script lang="ts">
  /**
   * Inline attachment strip on a chat message: image thumbs + file cards.
   * Clicking opens the host's attachments tray (zero network here).
   */
  import { onDestroy } from "svelte";
  import type { ImagePreviewCache } from "./image-preview-cache";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import { attachmentPreviewKind } from "./attachment-preview";
  import { fileKind, fileMetaLine } from "./chat-attachments";
  import RailIcon from "../../common/button/RailIcon.svelte";
  import "./doc-card.css";

  const KIND_ICON = { folder: "folder", image: "image", document: "file-text" } as const;

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
              loading="lazy"
              decoding="async"
              onerror={() => markBroken(item)}
            />
          {:else}
            <span class="att-thumb-fallback" class:is-loading={!broken[keyFor(item)]} role="status">{broken[keyFor(item)] ? "Image unavailable · Retry" : "Loading image…"}</span>
          {/if}
        </button>
      {:else}
        {@const kind = fileKind(item)}
        <!-- The shared document card (doc-card.css), as on iOS: a fill with
             no outline, an icon tile tinted by the file's kind, the name over
             "PDF · 12 KB", and the whole card one button with a caret. -->
        <button
          type="button"
          class="doc-card is-compact att-card"
          data-testid="attachment-card"
          data-kind={kind}
          aria-label={`Open ${item.name}`}
          onclick={() => onopen?.(item)}
        >
          <span class={`doc-card-icon is-${kind}`} aria-hidden="true">
            <RailIcon name={KIND_ICON[kind]} size={16} />
          </span>
          <span class="doc-card-copy">
            <span class="doc-card-title att-name">{item.name}</span>
            <span class="doc-card-meta att-meta">{fileMetaLine(item)}</span>
          </span>
          <span class="doc-card-caret" aria-hidden="true">
            <RailIcon name="caret-right" size={12} />
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
    /* Each attachment keeps its own height. Stretched, a file card beside a
       screenshot grew to the image's height and floated in a tall grey box. */
    align-items: flex-start;
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

  /* A lone image hugs its artwork. A fixed 320x220 tile letterboxed every
     portrait or square image with dead margin down both sides (owner, #772);
     only the cap constrains it now. */
  .att-thumb.is-single {
    width: auto;
    height: auto;
    max-width: min(320px, 100%);
  }

  .att-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* The image gives the tile its size. */
  .att-thumb.is-single img {
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 220px;
    object-fit: contain;
  }

  /* Nothing to hug yet, so the placeholder keeps the old box. */
  .att-thumb.is-single .att-thumb-fallback {
    width: min(320px, 100%);
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

  .att-thumb:hover {
    background: var(--hover, rgba(255, 255, 255, 0.08));
  }
</style>
