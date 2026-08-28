<script lang="ts">
  /**
   * Project-about dialog — opened from the channel-header info control.
   * Shows the PROJECT_VIEW description for the open project channel.
   */
  import { projectAboutBody } from "./channel-status-model.js";
  import "./tokens.css";
  import "./chat-tokens.css";

  interface Props {
    title: string;
    description?: string | null;
    onclose?: () => void;
  }

  let { title, description = null, onclose }: Props = $props();

  const body = $derived(projectAboutBody(description));
  let dialogEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    dialogEl?.focus();
  });

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose?.();
    }
  }
</script>

<div
  class="about-backdrop"
  data-testid="project-about-dialog"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose?.();
  }}
>
  <div
    bind:this={dialogEl}
    class="about-dialog chat-shell"
    role="dialog"
    aria-modal="true"
    aria-labelledby="project-about-title"
    tabindex="-1"
    onkeydown={onKey}
    onclick={(event) => event.stopPropagation()}
  >
    <header class="about-head">
      <div class="about-head-text">
        <p class="about-kicker">Project</p>
        <h2 id="project-about-title" class="about-title">{title}</h2>
      </div>
      <button
        type="button"
        class="about-close"
        data-testid="project-about-close"
        aria-label="Close project description"
        onclick={() => onclose?.()}
      >
        <span aria-hidden="true">×</span>
      </button>
    </header>
    <p class="about-body" data-testid="project-about-body">{body}</p>
  </div>
</div>

<style>
  .about-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(8, 8, 10, 0.72);
  }

  .about-dialog {
    width: min(100%, 420px);
    max-height: min(80vh, 520px);
    overflow: auto;
    padding: 16px 18px 18px;
    border: 1px solid var(--line);
    border-radius: 12px;
    /* D-03: never use --v4-ground here — that token is glass and lets
       timeline text bleed through the description. */
    background: var(--v4-surface-solid, #161618);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
    outline: none;
  }

  .about-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 12px;
  }

  .about-head-text {
    min-width: 0;
    flex: 1;
  }

  .about-kicker {
    margin: 0 0 2px;
    color: var(--t3);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .about-title {
    margin: 0;
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
  }

  .about-close {
    appearance: none;
    -webkit-appearance: none;
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--t3);
    font: inherit;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .about-close:hover {
    border-color: var(--line2);
    color: var(--t1);
  }

  .about-body {
    margin: 0;
    color: var(--t2);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
</style>
