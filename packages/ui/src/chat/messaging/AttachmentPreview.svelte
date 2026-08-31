<script lang="ts">
  /**
   * Typed attachment preview + download. Shared by the message strip tray
   * and the right-side attachments browser.
   */
  import { onDestroy } from "svelte";
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
    resolveUrl?: (attachment: FileAttachmentModel) => Promise<string | null>;
    /** Releases a host-created object URL after this preview no longer uses it. */
    onreleaseurl?: (url: string) => void;
    compact?: boolean;
  }

  let { item, resolveUrl, onreleaseurl, compact = false }: Props = $props();

  const kind = $derived(
    attachmentPreviewKind({
      name: item.name,
      contentType: item.contentType,
      kind: item.kind,
    }),
  );

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
  </div>

  <div class="att-preview-stage">
    <button
      type="button"
      class="att-download"
      data-testid="attachment-download"
      aria-label={downloading ? "Saving" : `Download ${item.name}`}
      disabled={!src || downloading}
      onclick={(e) => {
        e.stopPropagation();
        void download();
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          fill="currentColor"
          d="M8 1.5a.75.75 0 0 1 .75.75v6.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V2.25A.75.75 0 0 1 8 1.5Zm-4.5 10a.75.75 0 0 0-1.5 0V13A1.5 1.5 0 0 0 3.5 14.5h9A1.5 1.5 0 0 0 14 13v-1.5a.75.75 0 0 0-1.5 0V13h-9v-1.5Z"
        />
      </svg>
    </button>
    {#if kind === "image" && src}
      <img
        class="att-preview-image"
        {src}
        alt={item.name}
        onerror={() => {
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
    gap: 10px;
    width: 100%;
    min-width: 0;
    min-height: 0;
  }

  .att-preview-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .att-preview-stage {
    position: relative;
    display: grid;
    place-items: center;
    min-width: 0;
    min-height: 0;
    width: 100%;
  }

  .att-preview-name {
    min-width: 0;
    overflow: hidden;
    color: var(--t1);
    font: 600 13px/1.3 var(--font-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .att-preview-meta {
    color: var(--t3, var(--t2));
    font: 400 11px/1.2 var(--font-ui);
  }

  .att-download {
    appearance: none;
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 2;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: rgba(12, 12, 14, 0.72);
    color: #fff;
    cursor: pointer;
  }

  .att-download:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .att-download:hover:not(:disabled) {
    background: rgba(12, 12, 14, 0.9);
  }

  .att-preview-status {
    margin: 0;
    color: var(--t2);
    font: 400 12px/1.4 var(--font-ui);
  }

  .att-preview-status.error {
    color: #f87171;
  }

  .att-preview-image {
    max-width: 100%;
    max-height: 100%;
    border-radius: 8px;
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
