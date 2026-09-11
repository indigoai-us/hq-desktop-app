<script lang="ts">
  import DownloadSimple from "phosphor-svelte/lib/DownloadSimple";
  /**
   * Typed attachment preview + download. Shared by the message strip tray
   * and the right-side attachments browser.
   */
  import { onDestroy, type Snippet } from "svelte";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import { fileTypeLabel } from "./chat-attachments";
  import { renderMessageBodyMarkdown } from "../../common/messageMarkdown.js";
  import {
    attachmentPreviewKind,
    downloadAttachment,
    parseCsv,
    parseSpreadsheetBytes,
    readAttachmentResponse,
  } from "./attachment-preview";

  interface Props {
    item: FileAttachmentModel;
    /** Borrowed raster preview while the original loads; never used for download. */
    thumbnailUrl?: string | null;
    resolveUrl?: (attachment: FileAttachmentModel) => Promise<string | null>;
    /** Releases a host-created object URL after this preview no longer uses it. */
    onreleaseurl?: (url: string) => void;
    compact?: boolean;
    /**
     * Extra controls for the end of the toolbar. The toolbar IS the preview's
     * chrome — a host that needs a close button puts it here rather than
     * stacking a second bar of its own above this one.
     */
    trailing?: Snippet;
  }

  let { item, resolveUrl, onreleaseurl, thumbnailUrl = null, compact = false, trailing }: Props = $props();

  const kind = $derived(
    attachmentPreviewKind({
      name: item.name,
      contentType: item.contentType,
      kind: item.kind,
    }),
  );

  let thumbnailFailed = $state(false);
  let src = $state("");
  let text = $state("");
  let sheet = $state<string[][]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let downloading = $state(false);
  let loadedKey = $state("");
  let resolvedUrl = $state("");
  /** The record's previewUrl failed to load (expired presign / revoked blob)
   * — ignore it and resolve a fresh URL instead. */
  let previewFailed = $state(false);
  /** A freshly resolved URL also failed — stop retrying, show the error. */
  let resolveFailed = $state(false);

  function releaseResolvedUrl(): void {
    if (!resolvedUrl) return;
    onreleaseurl?.(resolvedUrl);
    resolvedUrl = "";
  }

  onDestroy(releaseResolvedUrl);

  $effect(() => {
    const key = item.id || item.vaultPath;
    const preview = kind;
    const previewUrl = item.previewUrl || "";
    const companyUid = item.companyUid;
    const vaultPath = item.vaultPath;
    const name = item.name;
    const resolve = resolveUrl;
    const previewDead = previewFailed;
    if (key !== loadedKey) {
      releaseResolvedUrl();
      loadedKey = key;
      previewFailed = false;
      thumbnailFailed = false;
      resolveFailed = false;
      src = previewUrl;
      text = "";
      sheet = [];
      error = null;
    } else if (resolveFailed) {
      loading = false;
      return;
    } else if (previewUrl && !src && !previewDead) {
      src = previewUrl;
    }
    if (
      !previewDead &&
      (preview === "image" || preview === "pdf") &&
      (src || previewUrl)
    ) {
      if (previewUrl) src = previewUrl;
      loading = false;
      if (src || previewUrl) return;
    }
    // The host's resolveUrl owns the companyUid fallback (conversation vault
    // company), so an attachment record with an empty companyUid must still
    // reach resolve — gating on it here left the detail pane blank while the
    // tray thumbnails (which don't gate) rendered fine.
    if (!resolve || !vaultPath) {
      loading = false;
      return;
    }
    let cancelled = false;
    if (!src) loading = true;
    void resolve({
      ...item,
      id: key,
      companyUid,
      vaultPath,
      name,
      // A dead previewUrl must not short-circuit the host's resolver.
      previewUrl: previewDead ? null : item.previewUrl,
    })
      .then(async (url) => {
        if (!url) {
          if (!cancelled) error = "Could not load the file";
          return;
        }
        if (cancelled) {
          onreleaseurl?.(url);
          return;
        }
        resolvedUrl = url;
        src = url;
        if (preview === "image" || preview === "pdf" || preview === "file") {
          return;
        }
        const res = await readAttachmentResponse(url);
        if (preview === "sheet") {
          const bytes = await res.arrayBuffer();
          sheet =
            (await parseSpreadsheetBytes(name, bytes)) ??
            parseCsv(new TextDecoder().decode(bytes));
          return;
        }
        const body = await res.text();
        text = body.length > 200_000 ? `${body.slice(0, 200_000)}\n…` : body;
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          error =
            err instanceof Error && err.message
              ? err.message
              : "Could not load the file";
        }
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  async function download(): Promise<void> {
    if (!src || downloading) return;
    downloading = true;
    try {
      await downloadAttachment(src, item.name);
    } catch (err) {
      error =
        err instanceof Error && err.message
          ? err.message
          : "Could not download the file";
    } finally {
      downloading = false;
    }
  }
</script>

<div
  class="att-preview"
  class:compact
  data-testid="attachment-preview"
  data-kind={kind}
>
  <div class="att-preview-toolbar">
    <span class="att-preview-name">{item.name}</span>
    {#if item.sizeLabel}
      <span class="att-preview-meta">{item.sizeLabel}</span>
    {/if}
    <button
      type="button"
      class="att-preview-ic push-right"
      data-testid="attachment-download"
      aria-label={downloading ? "Saving" : `Download ${item.name}`}
      disabled={!src || downloading}
      onclick={(e) => {
        e.stopPropagation();
        void download();
      }}
    >
      <DownloadSimple size={15} aria-hidden="true" />
    </button>
    {@render trailing?.()}
  </div>

  <div class="att-preview-stage">
    {#if kind === "image" && (src || (!error && !thumbnailFailed && thumbnailUrl))}
      <img
        class="att-preview-image"
        src={src || thumbnailUrl || ""}
        alt={item.name}
        onerror={() => {
          if (!src) { thumbnailFailed = true; return; }
          if (!previewFailed && item.previewUrl && src === item.previewUrl) {
            previewFailed = true;
            src = "";
          } else {
            resolveFailed = true;
            error = "Could not load the file";
            src = "";
          }
        }}
      />
    {:else if kind === "pdf" && src}
      <iframe
        class="att-preview-pdf"
        title={item.name}
        {src}
        data-testid="attachment-pdf"
      ></iframe>
    {:else if kind === "markdown" && text}
      <div class="att-preview-md selectable-text">
        {@html renderMessageBodyMarkdown(text)}
      </div>
    {:else if kind === "text" && text}
      <pre class="att-preview-text selectable-text">{text}</pre>
    {:else if kind === "sheet" && sheet.length > 0}
      <div class="att-preview-sheet-wrap">
        <table class="att-preview-sheet" data-testid="attachment-sheet">
          <tbody>
            {#each sheet as row, r (r)}
              <tr>
                {#each row as cell, c (`${r}:${c}`)}
                  {#if r === 0}
                    <th>{cell}</th>
                  {:else}
                    <td>{cell}</td>
                  {/if}
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="att-preview-file">
        <span class="att-preview-icon"
          >{fileTypeLabel(item.name, item.contentType)}</span
        >
        <p>{item.name}</p>
        {#if loading}
          <p class="att-preview-status">Loading…</p>
        {:else if error}
          <p class="att-preview-status error">{error}</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .att-preview {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    min-height: 0;
  }

  /* Concept `.lb-bar`: one 46px row that names the file and holds every
     control. The file used to be named twice — once by the host's header and
     again here — with a download button stranded over the artwork. */
  .att-preview-toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 46px;
    padding: 0 14px 0 20px;
    min-width: 0;
  }

  .att-preview-stage {
    position: relative;
    flex: 1 1 auto;
    display: grid;
    place-items: center;
    min-width: 0;
    min-height: 0;
    width: 100%;
    padding: 4px 40px 40px;
  }

  .att-preview-name {
    min-width: 0;
    overflow: hidden;
    color: var(--t1);
    font: 500 12px/1.3 var(--font-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .att-preview-meta {
    flex-shrink: 0;
    color: var(--t3, var(--t2));
    font: 400 10px/1.2 var(--font-mono, ui-monospace, Menlo, monospace);
  }

  .push-right {
    margin-left: auto;
  }

  /* Concept `.lb-ic`. `:global` so a host can drop its own button into the
     `trailing` snippet and have it match without restating this. */
  .att-preview-toolbar :global(.att-preview-ic) {
    appearance: none;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
    transition:
      background 0.12s,
      color 0.12s;
  }

  .att-preview-toolbar :global(.att-preview-ic:disabled) {
    opacity: 0.35;
    cursor: default;
  }

  .att-preview-toolbar :global(.att-preview-ic:hover:not(:disabled)) {
    background: var(--hover, rgba(255, 255, 255, 0.14));
    color: var(--t1);
  }

  .att-preview-status {
    margin: 0;
    color: var(--t2);
    font: 400 12px/1.4 var(--font-ui);
  }

  .att-preview-status.error {
    color: #f87171;
  }

  /* Concept `.lb-img`: the artwork is the point, so it takes the stage. */
  .att-preview-image {
    max-width: 100%;
    max-height: 100%;
    border-radius: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    object-fit: contain;
  }

  .att-preview-pdf {
    width: 100%;
    min-height: 280px;
    height: 52vh;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    background: #fff;
  }

  .compact .att-preview-pdf {
    height: 220px;
    min-height: 180px;
  }

  .att-preview-text,
  .att-preview-md {
    margin: 0;
    max-height: 360px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    background: var(--sel, rgba(255, 255, 255, 0.03));
    color: var(--t1);
    font: 400 12px/1.45 var(--font-mono, ui-monospace, Menlo, monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .att-preview-md {
    font-family: var(--font-ui);
    white-space: normal;
  }

  .att-preview-sheet-wrap {
    max-height: 360px;
    overflow: auto;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
  }

  .att-preview-sheet {
    border-collapse: collapse;
    min-width: 100%;
    font: 400 12px/1.3 var(--font-ui);
  }

  .att-preview-sheet th,
  .att-preview-sheet td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--line2, rgba(255, 255, 255, 0.08));
    border-right: 1px solid var(--line2, rgba(255, 255, 255, 0.06));
    text-align: left;
    white-space: nowrap;
  }

  .att-preview-sheet th {
    position: sticky;
    top: 0;
    background: var(--bg, #121418);
    font-weight: 600;
  }

  .att-preview-file {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--t2);
  }

  .att-preview-icon {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.08);
    font: 700 11px/1 var(--font-mono, ui-monospace, Menlo, monospace);
  }
</style>
