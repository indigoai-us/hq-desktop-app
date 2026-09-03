<script lang="ts">
  /**
   * ArtifactPanel — artifact mode for the host's right side pane (the same
   * `.reply-column` slot the Thread panel uses; there is no second overlay
   * system). Shows the FULL artifact content, scrollable and wrapped.
   */
  import { onMount } from "svelte";

  import type { ChatArtifact } from "./artifact-model.js";

  interface Props {
    artifact: ChatArtifact;
    onclose: () => void;
  }

  let { artifact, onclose }: Props = $props();

  let panel = $state<HTMLElement | null>(null);
  let copied = $state(false);
  let copying = $state(false);

  onMount(() => {
    panel?.focus();
  });

  $effect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onclose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function copy(): Promise<void> {
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

<section
  class="artifact-panel"
  data-testid="artifact-panel"
  data-artifact-id={artifact.id}
  data-kind={artifact.kind}
  aria-label={`${artifact.kindLabel} artifact: ${artifact.title}`}
  tabindex="-1"
  bind:this={panel}
>
  <header class="artifact-panel-head">
    <span class="artifact-panel-titles">
      <span class="artifact-panel-title" data-testid="artifact-panel-title"
        >{artifact.title}</span
      >
      <span class="artifact-panel-meta">
        <span data-testid="artifact-panel-kind">{artifact.kindLabel}</span>
        <span data-testid="artifact-panel-size">{artifact.sizeLabel}</span>
      </span>
    </span>
    <button
      type="button"
      class="artifact-panel-btn"
      data-testid="artifact-panel-copy"
      onclick={copy}
      disabled={copying}
      aria-label={copied ? "Artifact copied" : "Copy artifact"}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
    <button
      type="button"
      class="artifact-panel-btn artifact-panel-close"
      data-testid="artifact-panel-close"
      onclick={onclose}
      aria-label="Close artifact"
    >
      ✕
    </button>
  </header>
  <div class="artifact-panel-body">
    <pre class="artifact-panel-content" data-testid="artifact-panel-content">{artifact.text}</pre>
  </div>
</section>

<style>
  .artifact-panel {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    font-size: 13px;
    animation: artifact-panel-in 140ms ease-out;
  }

  @keyframes artifact-panel-in {
    from {
      opacity: 0;
      transform: translateX(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .artifact-panel {
      animation: none;
    }
  }

  .artifact-panel-head {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
  }

  .artifact-panel-titles {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .artifact-panel-title {
    overflow: hidden;
    color: var(--t1, rgba(255, 255, 255, 0.95));
    font-size: 13px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artifact-panel-meta {
    display: flex;
    gap: 8px;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 10px;
    letter-spacing: 0.04em;
  }

  .artifact-panel-btn {
    appearance: none;
    flex: 0 0 auto;
    padding: 3px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .artifact-panel-btn:hover:not(:disabled) {
    background: var(--hover, rgba(255, 255, 255, 0.08));
    color: var(--t1, rgba(255, 255, 255, 0.95));
  }

  .artifact-panel-body {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    padding: 12px;
    overflow-x: hidden;
    overflow-y: auto;
  }

  /* Long single-line content wraps; the pane never scrolls horizontally. */
  .artifact-panel-content {
    margin: 0;
    max-width: 100%;
    color: var(--t1, rgba(255, 255, 255, 0.9));
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 12px;
    line-height: 18px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
</style>
