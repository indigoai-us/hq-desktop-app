<script lang="ts">
  /**
   * ArtifactCard — the compact card under a chat bubble for a long structured
   * artifact (`hq dm --details` / `--prompt`, delegation + handoff cards).
   *
   * Replaces the old hard 180-char clamp that ended in a bare "…" with no way
   * to read the rest: the preview fades and the whole card opens the FULL
   * content in the host's right side pane (artifact mode).
   *
   * Artifacts are documents, not terminal output. Markdown artifacts render
   * through the same CSP-safe renderer as message bodies (headings, lists,
   * tables, fences); plain artifacts keep their line structure. Both read in
   * the UI face — monospace is reserved for real code.
   */
  import { renderMarkdown } from "../../common/markdown.js";
  import {
    artifactBodyAfterTitle,
    artifactHasMore,
    artifactLooksLikeMarkdown,
    artifactPreview,
    chatArtifact,
    type ArtifactKind,
    type ChatArtifact,
  } from "./artifact-model.js";
  import "./artifact-prose.css";

  interface Props {
    text: string;
    eventId: string;
    kind?: ArtifactKind;
    /** Host opens the artifact in the side pane. */
    onopen?: (artifact: ChatArtifact) => void;
  }

  let { text, eventId, kind = "prompt", onopen }: Props = $props();

  /** Markdown previews get more source lines: block syntax (a heading plus a
      blank line, a table header row) spends lines before any prose shows. The
      card clamps the rendered height and fades regardless. */
  const PLAIN_PREVIEW_LINES = 6;
  const MARKDOWN_PREVIEW_LINES = 14;

  const artifact = $derived(chatArtifact({ text, eventId, kind }));
  const isMarkdown = $derived(artifactLooksLikeMarkdown(text));
  const previewLines = $derived(
    isMarkdown ? MARKDOWN_PREVIEW_LINES : PLAIN_PREVIEW_LINES,
  );
  /* The head already shows the title; the preview starts after it. */
  const body = $derived(artifactBodyAfterTitle(text, kind));
  const preview = $derived(artifactPreview(body, previewLines));
  const previewHtml = $derived(
    isMarkdown ? renderMarkdown(preview, { softBreak: "br" }) : "",
  );
  const hasMore = $derived(artifactHasMore(body, previewLines));

  let copied = $state(false);
  let copying = $state(false);

  function open(): void {
    onopen?.(artifact);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    open();
  }

  async function copy(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    const payload = artifact.text.trim();
    if (!payload || copying) return;
    copying = true;
    try {
      await navigator.clipboard.writeText(payload);
      copied = true;
      setTimeout(() => {
        if (copied) copied = false;
      }, 1800);
    } catch (err) {
      console.error("artifact copy failed", err);
    } finally {
      copying = false;
    }
  }
</script>

<div
  class="artifact-card chat-shell"
  class:has-more={hasMore}
  class:is-markdown={isMarkdown}
  data-testid={kind === "details" ? "message-details" : "message-prompt"}
  data-artifact-card="true"
  data-kind={kind}
  data-event={eventId}
  data-artifact-id={artifact.id}
  role="button"
  tabindex="0"
  aria-label={`Open ${artifact.kindLabel.toLowerCase()} artifact: ${artifact.title}`}
  onclick={open}
  onkeydown={onKeydown}
>
  <div class="artifact-card-head">
    <span class="artifact-card-icon" aria-hidden="true">
      {#if kind === "prompt"}
        <svg viewBox="0 0 14 14" width="14" height="14" focusable="false">
          <path
            d="M3 4.5l3 2.5-3 2.5M7.5 9.5H11"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      {:else}
        <svg viewBox="0 0 14 14" width="14" height="14" focusable="false">
          <path
            d="M3.5 1.75h4.6l2.9 2.9v7.6h-7.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linejoin="round"
          />
          <path d="M8 1.9v2.9h2.9" fill="none" stroke="currentColor" stroke-width="1.1" />
          <path d="M5 7h4M5 9.25h4" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
        </svg>
      {/if}
    </span>
    <span class="artifact-card-titles">
      <span class="artifact-card-title" data-testid="artifact-card-title"
        >{artifact.title}</span
      >
      <span class="artifact-card-meta">
        <span class="artifact-card-kind" data-testid="artifact-card-kind"
          >{artifact.kindLabel}</span
        >
        <span class="artifact-card-size" data-testid="artifact-card-size"
          >{artifact.sizeLabel}</span
        >
      </span>
    </span>
    <span class="artifact-card-actions">
      <button
        type="button"
        class="artifact-card-btn"
        data-testid={kind === "details"
          ? "message-details-copy"
          : "message-prompt-copy"}
        onclick={copy}
        disabled={copying}
        aria-label={copied
          ? `${artifact.kindLabel} copied`
          : `Copy ${artifact.kindLabel.toLowerCase()}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        class="artifact-card-btn artifact-card-open"
        data-testid="artifact-card-open"
        onclick={(e) => {
          e.stopPropagation();
          open();
        }}
        aria-label={`Open ${artifact.kindLabel.toLowerCase()} in side pane`}
      >
        Open
      </button>
    </span>
  </div>
  <div class="artifact-card-body">
    {#if isMarkdown}
      <div
        class="artifact-card-preview artifact-md"
        data-testid="artifact-card-preview"
        data-render="markdown"
      >
        {@html previewHtml}
      </div>
    {:else}
      <pre
        class="artifact-card-preview artifact-plain"
        data-testid="artifact-card-preview"
        data-render="plain">{preview}</pre>
    {/if}
    {#if hasMore}
      <span class="artifact-card-fade" aria-hidden="true"></span>
    {/if}
  </div>
</div>

<style>
  .artifact-card {
    /* Opaque surface so the preview fade has a colour to fade INTO in both
       themes; --elevated is the shell's opaque panel colour. */
    --artifact-surface: var(--elevated, #1e1e24);
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    margin-top: 4px;
    padding: 11px 14px 12px;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    border-radius: 10px;
    background: var(--artifact-surface);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    transition:
      border-color 120ms ease,
      background-color 120ms ease;
  }

  .artifact-card:hover {
    border-color: var(--line2, rgba(255, 255, 255, 0.12));
  }

  .artifact-card:focus-visible {
    border-color: var(--vio-ink, #854dee);
    outline: none;
  }

  .artifact-card-head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
  }

  .artifact-card-icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-top: 1px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--vio-ink, #854dee) 14%, transparent);
    color: var(--vio-ink, #854dee);
  }

  .artifact-card-titles {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .artifact-card-title {
    overflow: hidden;
    color: var(--t1, rgba(255, 255, 255, 0.95));
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artifact-card-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .artifact-card-kind {
    flex: 0 0 auto;
    padding: 1px 6px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--t1, #fff) 7%, transparent);
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    line-height: 16px;
    text-transform: uppercase;
  }

  .artifact-card-size {
    flex: 0 1 auto;
    overflow: hidden;
    color: var(--t3, rgba(255, 255, 255, 0.32));
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artifact-card-actions {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 2px;
    margin-left: auto;
  }

  .artifact-card-btn {
    appearance: none;
    padding: 3px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 18px;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease;
  }

  .artifact-card-btn:hover:not(:disabled) {
    background: var(--hover, rgba(255, 255, 255, 0.08));
    color: var(--t1, rgba(255, 255, 255, 0.95));
  }

  .artifact-card-btn:active:not(:disabled) {
    transform: scale(0.97);
  }

  .artifact-card-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .artifact-card-open {
    color: var(--vio-ink, #854dee);
  }

  /* Faded preview — never a hard cut with a bare ellipsis. */
  .artifact-card-body {
    position: relative;
    max-height: 168px;
    overflow: hidden;
  }

  .artifact-card-preview {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
  }

  /* Headings inside a card preview stay close to body size — the card title
     already carries the document's title. */
  .artifact-card-preview.artifact-md :global(h1) {
    font-size: 1.12em;
  }

  .artifact-card-preview.artifact-md :global(h2) {
    font-size: 1.06em;
  }

  .artifact-card-preview.artifact-md :global(h3),
  .artifact-card-preview.artifact-md :global(h4) {
    font-size: 1em;
  }

  .artifact-card-fade {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 56px;
    background: linear-gradient(to bottom, transparent, var(--artifact-surface));
    pointer-events: none;
  }
</style>
