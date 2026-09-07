<script lang="ts">
  /**
   * ArtifactCard — the collapsed tile under a chat bubble for a long
   * structured artifact (`hq dm --details` / `--prompt`, delegation + handoff
   * cards).
   *
   * Deliberately small: a kind-tinted mesh tile with an icon, the title, a
   * one-line plain-text summary, and the size. No preview body — the card is
   * a handle; the host's right side pane (artifact mode) shows the FULL
   * content. Copy / Open surface on hover and focus, and the whole card is a
   * keyboard-reachable button.
   */
  import {
    artifactSummary,
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
  const summary = $derived(artifactSummary(text, kind));

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
  <span class="artifact-tile" aria-hidden="true">
    <span class="artifact-tile-mesh"></span>
    {#if kind === "prompt"}
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        <path
          d="M3.5 4.75l3.5 3.25-3.5 3.25M8.5 11.25h4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    {:else}
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        <path
          d="M4 2h5.2L12.5 5.3V14H4z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
        <path d="M9.2 2.2v3.3h3.3" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path d="M6 8.25h4.5M6 10.75h4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    {/if}
  </span>
  <span class="artifact-copy">
    <span class="artifact-card-title" data-testid="artifact-card-title"
      >{artifact.title}</span
    >
    {#if summary}
      <span class="artifact-card-summary" data-testid="artifact-card-preview"
        >{summary}</span
      >
    {/if}
    <span class="artifact-card-meta">
      <span class="artifact-card-kind" data-testid="artifact-card-kind"
        >{artifact.kindLabel}</span
      >
      <span class="artifact-card-dot" aria-hidden="true">·</span>
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

<style>
  .artifact-card {
    /* Kind-tinted mesh. Details = violet/ice; prompt = ice/emerald. Hue
       tokens are the shell's own accents so light + dark both hold. */
    --mesh-a: var(--vio, #c084fc);
    --mesh-b: #5b8def;
    --mesh-c: #f472b6;
    --mesh-base: #2a2340;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: 520px;
    box-sizing: border-box;
    margin-top: 4px;
    padding: 8px 10px 8px 8px;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    border-radius: 12px;
    background: var(--elevated, #1e1e24);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    transition:
      border-color 120ms ease,
      background-color 120ms ease;
  }

  .artifact-card[data-kind="prompt"] {
    --mesh-a: #7dd3fc;
    --mesh-b: #34d399;
    --mesh-c: #a78bfa;
    --mesh-base: #1f2f3a;
  }

  .artifact-card:hover {
    border-color: var(--line2, rgba(255, 255, 255, 0.12));
  }

  .artifact-card:focus-visible {
    border-color: var(--vio-ink, #854dee);
    outline: none;
  }

  .artifact-card:active {
    transform: scale(0.995);
  }

  /* Mesh tile — layered soft radial gradients, subtly animated on hover. */
  .artifact-tile {
    position: relative;
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    width: 44px;
    height: 44px;
    overflow: hidden;
    border-radius: 9px;
    background: var(--mesh-base);
    color: #fff;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  }

  .artifact-tile-mesh {
    position: absolute;
    inset: -30%;
    background:
      radial-gradient(closest-side at 28% 26%, var(--mesh-a) 0%, transparent 100%),
      radial-gradient(closest-side at 78% 34%, var(--mesh-b) 0%, transparent 100%),
      radial-gradient(closest-side at 50% 88%, var(--mesh-c) 0%, transparent 100%);
    opacity: 0.9;
    filter: saturate(115%);
    transition: transform 600ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .artifact-card:hover .artifact-tile-mesh {
    transform: rotate(12deg) scale(1.08);
  }

  .artifact-tile svg {
    position: relative;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
  }

  .artifact-copy {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 1px;
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

  .artifact-card-summary {
    overflow: hidden;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 12.5px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artifact-card-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    margin-top: 2px;
    color: var(--t3, rgba(255, 255, 255, 0.32));
    font-size: 11px;
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .artifact-card-kind {
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .artifact-card-actions {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 2px;
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .artifact-card:hover .artifact-card-actions,
  .artifact-card:focus-within .artifact-card-actions {
    opacity: 1;
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

  @media (prefers-reduced-motion: reduce) {
    .artifact-tile-mesh,
    .artifact-card,
    .artifact-card-btn {
      transition: none;
    }
    .artifact-card:hover .artifact-tile-mesh {
      transform: none;
    }
  }
</style>
