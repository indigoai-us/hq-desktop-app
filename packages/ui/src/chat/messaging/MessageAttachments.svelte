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
    width: min(320px, 100%);
    height: 220px;
    max-width: 100%;
  }

  .att-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .att-thumb.is-single img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .att-thumb-fallback {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    color: var(--t2);
    font: 400 13px/1.4 var(--font-ui);
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
