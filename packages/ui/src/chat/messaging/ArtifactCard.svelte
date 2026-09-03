<script lang="ts">
  /**
   * ArtifactCard — the compact card under a chat bubble for a long structured
   * artifact (`hq dm --details` / `--prompt`, delegation + handoff cards).
   *
   * Replaces the old hard 180-char clamp that ended in a bare "…" with no way
   * to read the rest: the preview fades and the whole card opens the FULL
   * content in the host's right side pane (artifact mode).
   *
   * Desktop-alt chrome: 13px, hairline border, muted uppercase labels, one
   * violet accent, ghost styling. Monospace is for the preview only.
   */
  import {
    artifactHasMore,
    artifactPreview,
    chatArtifact,
    type ArtifactKind,
    type ChatArtifact,
  } from "./artifact-model.js";

  interface Props {
    text: string;
    eventId: string;
    kind?: ArtifactKind;
    /** Host opens the artifact in the side pane. */
    onopen?: (artifact: ChatArtifact) => void;
  }

  let { text, eventId, kind = "prompt", onopen }: Props = $props();

  const artifact = $derived(chatArtifact({ text, eventId, kind }));
  const preview = $derived(artifactPreview(text));
  const hasMore = $derived(artifactHasMore(text));

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
      <svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
        <path
          d="M2.5 1.5h4.2L9.5 4.3v6.2h-7z"
          fill="none"
          stroke="currentColor"
          stroke-width="1"
          stroke-linejoin="round"
        />
        <path d="M6.6 1.6v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1" />
      </svg>
    </span>
    <span class="artifact-card-title" data-testid="artifact-card-title"
      >{artifact.title}</span
    >
    <span class="artifact-card-kind" data-testid="artifact-card-kind"
      >{artifact.kindLabel}</span
    >
    <span class="artifact-card-size" data-testid="artifact-card-size"
      >{artifact.sizeLabel}</span
    >
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
        {copied ? "Copied!" : "Copy"}
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
    <pre class="artifact-card-preview" data-testid="artifact-card-preview">{preview}</pre>
    {#if hasMore}
      <span class="artifact-card-fade" aria-hidden="true"></span>
    {/if}
  </div>
</div>

<style>
  .artifact-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 2px;
    padding: 8px 10px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: transparent;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .artifact-card:hover,
  .artifact-card:focus-visible {
    border-color: var(--vio-ink, #854dee);
    outline: none;
  }

  .artifact-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .artifact-card-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--vio-ink, #854dee);
  }

  .artifact-card-title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--t1, rgba(255, 255, 255, 0.95));
    font-size: 13px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artifact-card-kind,
  .artifact-card-size {
    flex: 0 0 auto;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .artifact-card-size {
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: none;
  }

  .artifact-card-actions {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 4px;
    margin-left: auto;
  }

  .artifact-card-btn {
    appearance: none;
    padding: 2px 7px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .artifact-card-btn:hover:not(:disabled) {
    background: var(--hover, rgba(255, 255, 255, 0.08));
    color: var(--t1, rgba(255, 255, 255, 0.95));
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
    overflow: hidden;
  }

  .artifact-card-preview {
    margin: 0;
    color: var(--t1, rgba(255, 255, 255, 0.88));
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
    line-height: 16px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .artifact-card-fade {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 28px;
    background: linear-gradient(
      to bottom,
      transparent,
      var(--bubble-bg, var(--bg, rgba(20, 20, 24, 0.96)))
    );
    pointer-events: none;
  }
</style>
