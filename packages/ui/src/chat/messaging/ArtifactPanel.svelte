<script lang="ts">
  /**
   * ArtifactPanel — artifact mode for the host's right side pane (the same
   * `.reply-column` slot the Thread panel uses; there is no second overlay
   * system). Shows the FULL artifact content, scrollable and wrapped.
   *
   * Markdown artifacts render as a document (same CSP-safe renderer as message
   * bodies); plain artifacts keep their line structure. Both read in the UI
   * face at reading size — monospace only for real code.
   */
  import { onMount } from "svelte";

  import { handleLinkActivate } from "../../common/external-links.js";
  import { renderMarkdown } from "../../common/markdown.js";
  import {
    artifactLooksLikeMarkdown,
    type ChatArtifact,
  } from "./artifact-model.js";
  import "./artifact-prose.css";

  interface Props {
    artifact: ChatArtifact;
    onclose: () => void;
    /** Host-owned external link opener (same contract as message bodies). */
    onopenurl?: (url: string) => void;
  }

  let { artifact, onclose, onopenurl }: Props = $props();

  /** Above this the Markdown pass is skipped — a dump this size is not prose,
      and rendering it would stall the pane open animation. */
  const MARKDOWN_MAX_CHARS = 200_000;

  const isMarkdown = $derived(
    artifact.text.length <= MARKDOWN_MAX_CHARS &&
      artifactLooksLikeMarkdown(artifact.text),
  );

  /* Links never navigate the webview: route them through the host opener. */
  function onLinkActivate(e: Event): void {
    handleLinkActivate(e, { onopenurl, mode: "message" });
  }
  const html = $derived(
    isMarkdown ? renderMarkdown(artifact.text, { softBreak: "br" }) : "",
  );

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
        <span class="artifact-panel-kind" data-testid="artifact-panel-kind"
          >{artifact.kindLabel}</span
        >
        <span class="artifact-panel-size" data-testid="artifact-panel-size"
          >{artifact.sizeLabel}</span
        >
      </span>
    </span>
    <span class="artifact-panel-actions">
      <button
        type="button"
        class="artifact-panel-btn"
        data-testid="artifact-panel-copy"
        onclick={copy}
        disabled={copying}
        aria-label={copied ? "Artifact copied" : "Copy artifact"}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        class="artifact-panel-btn artifact-panel-close"
        data-testid="artifact-panel-close"
        onclick={onclose}
        aria-label="Close artifact"
      >
        <svg viewBox="0 0 12 12" width="12" height="12" focusable="false" aria-hidden="true">
          <path
            d="M3 3l6 6M9 3l-6 6"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </span>
  </header>
  <div class="artifact-panel-body">
    {#if isMarkdown}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <article
        class="artifact-panel-content artifact-md"
        data-testid="artifact-panel-content"
        data-render="markdown"
        onclick={onLinkActivate}
        onauxclick={onLinkActivate}
        onkeydown={onLinkActivate}
      >
        {@html html}
      </article>
    {:else}
      <pre
        class="artifact-panel-content artifact-plain"
        data-testid="artifact-panel-content"
        data-render="plain">{artifact.text}</pre>
    {/if}
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
    animation: artifact-panel-in 160ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .artifact-panel:focus {
    outline: none;
  }

  @keyframes artifact-panel-in {
    from {
      opacity: 0;
      transform: translateX(8px);
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
    align-items: flex-start;
    gap: 10px;
    padding: 14px 14px 12px 18px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.07));
  }

  .artifact-panel-titles {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .artifact-panel-title {
    display: -webkit-box;
    overflow: hidden;
    color: var(--t1, rgba(255, 255, 255, 0.95));
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.012em;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .artifact-panel-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .artifact-panel-kind {
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

  .artifact-panel-size {
    overflow: hidden;
    color: var(--t3, rgba(255, 255, 255, 0.32));
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artifact-panel-actions {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 2px;
  }

  .artifact-panel-btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
    height: 26px;
    padding: 0 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease;
  }

  .artifact-panel-btn:hover:not(:disabled) {
    background: var(--hover, rgba(255, 255, 255, 0.08));
    color: var(--t1, rgba(255, 255, 255, 0.95));
  }

  .artifact-panel-btn:active:not(:disabled) {
    transform: scale(0.97);
  }

  .artifact-panel-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .artifact-panel-close {
    padding: 0;
  }

  .artifact-panel-body {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    padding: 16px 18px 32px;
    overflow-x: hidden;
    overflow-y: auto;
  }

  /* Reading measure. Long single-line content wraps; the pane never scrolls
     horizontally. */
  .artifact-panel-content {
    max-width: 70ch;
    font-size: 14px;
    line-height: 1.6;
    color: var(--t1, rgba(255, 255, 255, 0.92));
    word-break: break-word;
  }
</style>
