<script lang="ts">
  /**
   * Typed attachment preview + download. Shared by the message strip tray
   * and the right-side attachments browser.
   */
  import { onDestroy, type Snippet } from "svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";
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
      vaultPath: item.vaultPath,
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

  // ---- Image zoom (iOS #44: the picture fits, and zooms on a gesture) ----
  // 1 is "fit to the window". Double-click toggles 2x anchored at the click
  // and back; a trackpad pinch (a ctrl-wheel in WebKit and Chromium) zooms
  // smoothly between 1x and 4x. Zoomed, the stage scrolls to pan.
  const ZOOM_MAX = 4;
  let zoom = $state(1);
  let fitW = $state(0);
  let stageEl = $state<HTMLDivElement | null>(null);
  let imageEl = $state<HTMLImageElement | null>(null);

  function setZoom(next: number, anchor?: { x: number; y: number }): void {
    const img = imageEl;
    const stage = stageEl;
    if (!img || !stage) return;
    const clamped = Math.min(ZOOM_MAX, Math.max(1, next));
    if (zoom === 1) fitW = img.getBoundingClientRect().width;
    if (clamped === zoom) return;
    // Where the anchor sits in the picture, as a fraction, before the zoom.
    const before = img.getBoundingClientRect();
    const fx = anchor && before.width ? (anchor.x - before.left) / before.width : 0.5;
    const fy = anchor && before.height ? (anchor.y - before.top) / before.height : 0.5;
    const stageBox = stage.getBoundingClientRect();
    const ax = anchor ? anchor.x - stageBox.left : stageBox.width / 2;
    const ay = anchor ? anchor.y - stageBox.top : stageBox.height / 2;
    zoom = clamped;
    if (zoom === 1) return;
    requestAnimationFrame(() => {
      const after = img.getBoundingClientRect();
      // Keep the point under the cursor where it was.
      stage.scrollLeft += after.left - stageBox.left + fx * after.width - ax;
      stage.scrollTop += after.top - stageBox.top + fy * after.height - ay;
    });
  }

  function onImageDoubleClick(event: MouseEvent): void {
    setZoom(zoom === 1 ? 2 : 1, { x: event.clientX, y: event.clientY });
  }

  function onStageWheel(event: WheelEvent): void {
    if (kind !== "image" || !event.ctrlKey) return;
    event.preventDefault();
    setZoom(zoom * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY });
  }

  // Not `onwheel=`: Svelte attaches wheel handlers as passive, and a passive
  // listener cannot stop the pinch from zooming the whole window instead.
  $effect(() => {
    const stage = stageEl;
    if (!stage) return;
    stage.addEventListener("wheel", onStageWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onStageWheel);
  });

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
    }
    // A folder share is not an object: never presign, fetch or download it.
    if (preview === "folder") {
      loading = false;
      return;
    }
    if (resolveFailed) {
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
  <div class="att-preview-toolbar">
    <span class="att-preview-name">{item.name}</span>
    {#if item.sizeLabel}
      <span class="att-preview-meta">{item.sizeLabel}</span>
    {/if}
    <!-- A folder share is not an object: nothing to download (#1765). -->
    {#if kind !== "folder"}
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
      <RailIcon name="download" size={15} />
    </button>
    {/if}
    {@render trailing?.()}
  </div>

  <div
    class="att-preview-stage"
    class:is-zoomed={zoom > 1}
    bind:this={stageEl}
  >
    {#if kind === "folder"}
      <p class="att-preview-status" data-testid="attachment-folder-note">
        This is a shared folder. Open it in Files to see what is in it.
      </p>
    {:else if kind === "image" && (src || (!error && !thumbnailFailed && thumbnailUrl))}
      <img
        class="att-preview-image"
        bind:this={imageEl}
        style={zoom > 1 ? `width: ${Math.round(fitW * zoom)}px` : undefined}
        ondblclick={onImageDoubleClick}
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
      <!-- Anything we do not render inline states what it is and offers the
           one thing that is useful for it, Download in the toolbar. -->
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
          <!-- Say why there is no picture, rather than leaving a blank stage
               that reads as still loading (iOS #44). -->
          <p class="att-preview-status" data-testid="attachment-no-preview">
            No preview for this file. Download it to open it.
          </p>
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
  /* This preview always sits on a dark scrim, so its ink is FIXED rather
     than themed. `--t1` is near-black in light mode, which left the
     filename, the size and both toolbar icons invisible against the
     scrim — the surface is dark in both themes, so the text must be light
     in both themes. */
  .att-preview {
    --lb-ink: #fff;
    --lb-ink-mid: rgba(255, 255, 255, 0.72);
    --lb-ink-dim: rgba(255, 255, 255, 0.55);
    --lb-hover: rgba(255, 255, 255, 0.14);
    --lb-line: rgba(255, 255, 255, 0.12);
    --lb-surface: rgba(255, 255, 255, 0.06);
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
    color: var(--lb-ink);
    font: 500 12px/1.3 var(--font-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .att-preview-meta {
    flex-shrink: 0;
    color: var(--lb-ink-dim);
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
    color: var(--lb-ink-mid);
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
    background: var(--lb-hover);
    color: var(--lb-ink);
  }

  .att-preview-status {
    margin: 0;
    color: var(--lb-ink-dim);
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
    cursor: zoom-in;
  }

  /* Zoomed: the picture takes its zoomed width and the stage scrolls. */
  .att-preview-stage.is-zoomed {
    place-items: start;
    overflow: auto;
  }

  .is-zoomed .att-preview-image {
    max-width: none;
    max-height: none;
    height: auto;
    margin: auto;
    border-radius: 0;
    box-shadow: none;
    cursor: zoom-out;
  }


  .att-preview-text,
  .att-preview-md {
    margin: 0;
    max-height: 360px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--lb-line);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.05);
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
    max-height: 360px;
    overflow: auto;
    border: 1px solid var(--lb-line);
    border-radius: 8px;
    color: var(--lb-ink);
  }

  .att-preview-sheet {
    border-collapse: collapse;
    min-width: 100%;
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

  /* A literal colour, not `var(--bg)` — that token does not exist, so the
     fallback was the only thing ever applied. */
  .att-preview-sheet th {
    position: sticky;
    top: 0;
    background: #17171a;
    font-weight: 600;
  }

  .att-preview-file {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--lb-ink-dim);
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
    transition: background 0.12s;
  }

  .att-preview-open:hover:not(:disabled) {
    background: var(--lb-hover);
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
    color: var(--lb-ink-mid);
    font: 700 11px/1 var(--font-mono, ui-monospace, Menlo, monospace);
  }

  /* The PDF takes the stage, like an image does. */
  .att-preview-pdf {
    width: 100%;
    min-height: 280px;
    height: 100%;
    border: 1px solid var(--lb-line);
    border-radius: 8px;
    background: #fff;
  }

  .compact .att-preview-pdf {
    height: 220px;
    min-height: 180px;
  }
</style>
