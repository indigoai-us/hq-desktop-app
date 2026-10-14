<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * Typed attachment preview + download — the body of the attachment
   * lightbox (AttachmentTray). One 46px bar names the file and holds every
   * control (Download included, for every kind); the stage below it shows the
   * image, PDF, text or sheet, or for a file that is not rendered inline,
   * says what it is and offers Download.
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
     * Extra controls for the end of the bar. The bar IS the lightbox chrome —
     * a host that needs a close button puts it here rather than stacking a
     * second header of its own above this one (which named the file twice).
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
    // An image or a PDF renders straight from a URL the record already
    // carries; the text kinds below need the bytes, so they always resolve.
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
        console.warn("[attachment-preview] load failed", err);
        if (!cancelled) error = "Could not load the file. Try again.";
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
      console.warn("[attachment-preview] download failed", err);
      error = "Could not download the file. Try again.";
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
  <!-- One bar: name, size, then the controls. Download used to float over
       the artwork in the corner of the stage. -->
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
      <RailIcon name="download" size={14} />
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
      <!-- A PDF reads in place, like an image: a document card in the
           timeline opens this lightbox (owner decision 2026-10-08), and the
           bar above keeps Download for anyone who wants the file. -->
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
      <!-- Anything not rendered inline (or still loading) states what it is
           and offers the one useful thing for it. -->
      <div class="att-preview-file">
        <span class="att-preview-icon"
          >{fileTypeLabel(item.name, item.contentType)}</span
        >
        <p class="att-preview-file-name">{item.name}</p>
        {#if loading}
          <p class="att-preview-status">Loading…</p>
        {:else if error}
          <p class="att-preview-status error">{error}</p>
        {:else}
          <button
            type="button"
            class="att-preview-open"
            data-testid="attachment-file-download"
            disabled={!src || downloading}
            onclick={() => void download()}
          >
            {downloading ? "Saving…" : "Download"}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* The preview only ever renders inside the attachment lightbox, which sits
     on a dark scrim in BOTH themes. Its ink is therefore fixed light rather
     than themed: `--t1`/`--t2`/`--t3` are near-black in light mode, which
     left the filename, size, status and toolbar icons invisible against the
     dark surface. The theme tokens are re-pointed here too so globally
     styled descendants (rendered markdown) inherit light ink. */
  .att-preview {
    --lb-ink: #fff;
    --lb-ink-mid: rgba(255, 255, 255, 0.72);
    --lb-ink-dim: rgba(255, 255, 255, 0.55);
    --lb-hover: rgba(255, 255, 255, 0.14);
    --lb-line: rgba(255, 255, 255, 0.12);
    --lb-surface: rgba(255, 255, 255, 0.06);
    /* Opaque reading surface for text / sheet previews, so the blurred
       timeline behind the scrim never shows through the words. */
    --lb-panel: #161618;
    --t1: var(--lb-ink);
    --t2: var(--lb-ink-mid);
    --t3: var(--lb-ink-dim);
    color: var(--lb-ink);
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    min-height: 0;
  }

  /* One 46px bar that names the file and holds every control. */
  .att-preview-toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 46px;
    box-sizing: border-box;
    padding: 0 14px 0 20px;
    min-width: 0;
  }

  /* One definite cell, so the artwork's `max-height: 100%` resolves
     against the stage rather than against its own content. */
  .att-preview-stage {
    position: relative;
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    place-items: center;
    min-width: 0;
    min-height: 0;
    width: 100%;
    box-sizing: border-box;
    padding: 4px 40px 40px;
  }

  .att-preview-name {
    min-width: 0;
    overflow: hidden;
    color: var(--lb-ink);
    font: 500 12px/1.3 var(--font-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .att-preview-meta {
    flex-shrink: 0;
    color: var(--lb-ink-dim);
    font: 400 10px/1.2 var(--font-mono, ui-monospace, Menlo, monospace);
    font-variant-numeric: tabular-nums;
  }

  .push-right {
    margin-left: auto;
  }

  /* `:global` so a host can drop its own button into the `trailing` snippet
     (the lightbox's close) and have it match without restating this. */
  .att-preview-toolbar :global(.att-preview-ic) {
    appearance: none;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    /* Icon-only buttons read the one button standard (button-standard.css). */
    width: var(--hq-btn-h);
    height: var(--hq-btn-h);
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--lb-ink);
    cursor: pointer;
    transition: background-color 0.12s ease;
  }

  .att-preview-toolbar :global(.att-preview-ic:disabled) {
    opacity: 0.35;
    cursor: default;
  }

  .att-preview-toolbar :global(.att-preview-ic:hover:not(:disabled)) {
    background: var(--lb-hover);
  }

  .att-preview-toolbar :global(.att-preview-ic:focus-visible) {
    outline: 2px solid var(--lb-ink-mid);
    outline-offset: -2px;
  }

  .att-preview-status {
    margin: 0;
    color: var(--lb-ink-mid);
    font: 400 12px/1.4 var(--font-ui);
  }

  .att-preview-status.error {
    color: #f87171;
  }

  /* The artwork is the point, so it takes the stage and lifts off it. */
  .att-preview-image {
    max-width: 100%;
    max-height: 100%;
    border-radius: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    object-fit: contain;
  }

  /* A reading surface the size of the stage, at the same measure as the
     text preview, lifted off the scrim like the artwork. White behind it so
     a page never flashes the scrim through while the viewer paints. */
  .att-preview-pdf {
    box-sizing: border-box;
    width: min(900px, 100%);
    height: 100%;
    border: 1px solid var(--lb-line);
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  }

  .att-preview-text,
  .att-preview-md {
    box-sizing: border-box;
    width: min(900px, 100%);
    max-height: 100%;
    margin: 0;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--lb-line);
    border-radius: 8px;
    background: var(--lb-panel);
    color: var(--lb-ink);
    font: 400 12px/1.45 var(--font-mono, ui-monospace, Menlo, monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .att-preview-md {
    font-family: var(--font-ui);
    white-space: normal;
  }

  .att-preview-sheet-wrap {
    box-sizing: border-box;
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
    border: 1px solid var(--lb-line);
    border-radius: 8px;
    background: var(--lb-panel);
  }

  .att-preview-sheet {
    border-collapse: collapse;
    min-width: 100%;
    color: var(--lb-ink);
    font: 400 12px/1.3 var(--font-ui);
  }

  .att-preview-sheet th,
  .att-preview-sheet td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--lb-line);
    border-right: 1px solid var(--lb-line);
    text-align: left;
    white-space: nowrap;
  }

  .att-preview-sheet th {
    position: sticky;
    top: 0;
    /* Opaque so scrolled rows do not show through; matches the panel. */
    background: var(--lb-panel);
    font-weight: 600;
  }

  .att-preview-file {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--lb-ink-mid);
    text-align: center;
  }

  .att-preview-file-name {
    margin: 0;
    color: var(--lb-ink);
    font: 500 13px/1.3 var(--font-ui);
    overflow-wrap: anywhere;
  }

  .att-preview-open {
    appearance: none;
    height: 28px;
    margin-top: 2px;
    padding: 0 12px;
    border: 1px solid var(--lb-line);
    border-radius: 8px;
    background: var(--lb-surface);
    color: var(--lb-ink);
    font: 500 12px/1 var(--font-ui);
    cursor: pointer;
    transition: background-color 0.12s ease;
  }

  .att-preview-open:hover:not(:disabled) {
    background: var(--lb-hover);
  }

  .att-preview-open:focus-visible {
    outline: 2px solid var(--lb-ink-mid);
    outline-offset: 2px;
  }

  .att-preview-open:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .att-preview-icon {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 10px;
    background: var(--lb-surface);
    color: var(--lb-ink);
    font: 700 11px/1 var(--font-mono, ui-monospace, Menlo, monospace);
  }

  @media (prefers-reduced-motion: reduce) {
    .att-preview-toolbar :global(.att-preview-ic),
    .att-preview-open {
      transition: none;
    }
  }
</style>
