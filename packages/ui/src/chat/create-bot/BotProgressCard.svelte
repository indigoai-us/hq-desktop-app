<script lang="ts">
  /**
   * The card a new Local bot's DM shows until the bot is online: Creating
   * identity → Installing on this Mac → Online. A failure shows the reason
   * inline with one Retry. The host removes the card once presence reports
   * online or the bot's first message lands.
   */
  export type BotProgressState = "creating" | "installing" | "online" | "failed";

  interface Props {
    name: string;
    state: BotProgressState;
    /** Why it failed (CLI's own words); shown with Retry. */
    reason?: string | null;
    onretry?: () => void | Promise<void>;
    retrying?: boolean;
  }

  let { name, state, reason = null, onretry, retrying = false }: Props = $props();

  const STEPS = [
    { id: "creating", label: "Creating identity" },
    { id: "installing", label: "Installing on this Mac" },
    { id: "online", label: "Online" },
  ] as const;

  /** Index of the step currently in progress; `failed` freezes the last one reached. */
  const activeIndex = $derived(state === "creating" ? 0 : state === "installing" ? 1 : 2);

  function stepState(index: number): "done" | "active" | "todo" | "failed" {
    if (state === "failed") {
      return index < activeIndex ? "done" : index === activeIndex ? "failed" : "todo";
    }
    if (state === "online") return "done";
    return index < activeIndex ? "done" : index === activeIndex ? "active" : "todo";
  }

  const title = $derived(
    state === "online"
      ? `${name} is online`
      : state === "failed"
        ? `${name} could not start`
        : `Setting up ${name}…`,
  );
</script>

<div class="progress" data-testid="bot-progress-card" data-state={state} role="status" aria-live="polite">
  <div class="progress-head">
    <span class="progress-title">{title}</span>
    {#if state !== "online" && state !== "failed"}
      <span class="progress-hint">About half a minute</span>
    {/if}
  </div>
  <ol class="progress-steps">
    {#each STEPS as step, index (step.id)}
      {@const s = stepState(index)}
      <li class="progress-step" data-testid={`bot-progress-step-${step.id}`} data-step-state={s}>
        <span class="progress-dot" aria-hidden="true">
          {#if s === "done"}
            <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 6.5l2.2 2.2L9.5 3.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
          {:else if s === "failed"}
            <svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          {/if}
        </span>
        <span class="progress-label">{step.label}</span>
      </li>
    {/each}
  </ol>
  {#if state === "failed"}
    <div class="progress-failed">
      <span class="progress-reason" data-testid="bot-progress-reason">{reason || "Something went wrong while starting the bot."}</span>
      {#if onretry}
        <button
          type="button"
          class="progress-retry"
          data-testid="bot-progress-retry"
          disabled={retrying}
          onclick={() => void onretry?.()}
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .progress {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 12px 16px;
    padding: 14px 16px;
    border: 1px solid var(--v4-hairline);
    border-radius: 12px;
    background: var(--v4-control-faint, rgba(127, 127, 127, 0.06));
    color: var(--t1);
    font-size: 13px;
  }
  .progress-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .progress-title {
    font-weight: 600;
  }
  .progress-hint {
    color: var(--t3);
    font-size: 11px;
  }
  .progress-steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .progress-step {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--t3);
  }
  .progress-step[data-step-state="done"] {
    color: var(--t2);
  }
  .progress-step[data-step-state="active"] {
    color: var(--t1);
  }
  .progress-step[data-step-state="failed"] {
    color: var(--v4-error, #d9534f);
  }
  .progress-dot {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1.5px solid currentColor;
    flex: 0 0 auto;
  }
  .progress-step[data-step-state="done"] .progress-dot {
    background: var(--v4-ok, #2e9e5b);
    border-color: var(--v4-ok, #2e9e5b);
    color: #fff;
  }
  .progress-step[data-step-state="active"] .progress-dot {
    border-style: dashed;
    animation: spin 1.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress-step[data-step-state="active"] .progress-dot {
      animation: none;
    }
  }
  .progress-failed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding-top: 4px;
    border-top: 1px solid var(--v4-hairline);
  }
  .progress-reason {
    flex: 1 1 200px;
    color: var(--t2);
    line-height: 1.4;
  }
  .progress-retry {
    font: inherit;
    font-size: 12px;
    padding: 5px 12px;
    border: 0;
    border-radius: 6px;
    background: var(--v4-cta-bg, var(--v4-brand-accent, #4c6fff));
    color: var(--v4-cta-text, #fff);
    cursor: pointer;
  }
  .progress-retry:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .progress-retry:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 2px;
  }
</style>
