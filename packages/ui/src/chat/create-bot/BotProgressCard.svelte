<script lang="ts">
  /**
   * The card a new Local bot's DM shows until the bot is online: Creating
   * identity → Installing on this Mac → Online. A failure shows the reason
   * inline with one Retry. The host removes the card once presence reports
   * online or the bot's first message lands.
   */
  import { untrack } from "svelte";
  import { hostComputerNoun } from "@hq/platform";

  export type BotProgressState = "creating" | "installing" | "online" | "failed";

  interface Props {
    name: string;
    /**
     * Where the bot is. Named `phase`, not `state`: a prop called `state`
     * shadows the `$state` rune inside this component and Svelte then reads
     * `$state(...)` as a store subscription.
     */
    phase: BotProgressState;
    /** Why it failed (CLI's own words); shown with Retry. */
    reason?: string | null;
    onretry?: () => void | Promise<void>;
    retrying?: boolean;
    /**
     * False once nothing more may be tried for this bot (a definitive start
     * failure closed its gate). The button then renders disabled rather than
     * offering a Retry that the host would silently drop; `reason` already
     * carries the sentence that says what to do instead.
     */
    canRetry?: boolean;
  }

  let { name, phase, reason = null, onretry, retrying = false, canRetry = true }: Props = $props();

  /**
   * The plain-language name for the host machine ("Mac", "PC", or
   * "computer"). Read once so the "Installing on this ___" label never
   * flashes from one name to another after the OS-plugin probe lands.
   */
  const hostNoun = hostComputerNoun();

  const STEPS = [
    { id: "creating", label: "Creating identity" },
    { id: "installing", label: `Installing on this ${hostNoun}` },
    { id: "online", label: "Online" },
  ] as const;

  /**
   * Index of the step currently in progress. A failure has no step of its own,
   * so it freezes the furthest step this card ever reached — the host flips
   * `installing → failed`, and the card must not blame "Online" for it. The
   * card only exists once the identity is created, so a card that mounts
   * already failed died installing.
   */
  let reached = $state(untrack(() => (phase === "creating" ? 0 : 1)));
  $effect(() => {
    if (phase === "creating") reached = Math.max(reached, 0);
    else if (phase === "installing") reached = Math.max(reached, 1);
    else if (phase === "online") reached = 2;
  });
  const activeIndex = $derived(
    phase === "failed" ? reached : phase === "creating" ? 0 : phase === "installing" ? 1 : 2,
  );

  function stepState(index: number): "done" | "active" | "todo" | "failed" {
    if (phase === "failed") {
      return index < activeIndex ? "done" : index === activeIndex ? "failed" : "todo";
    }
    if (phase === "online") return "done";
    return index < activeIndex ? "done" : index === activeIndex ? "active" : "todo";
  }

  const title = $derived(
    phase === "online"
      ? `${name} is online`
      : phase === "failed"
        ? `${name} could not start`
        : `Setting up ${name}…`,
  );
</script>

<div class="progress" data-testid="bot-progress-card" data-state={phase} role="status" aria-live="polite">
  <div class="progress-head">
    <span class="progress-title">{title}</span>
    {#if phase !== "online" && phase !== "failed"}
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
  {#if phase === "failed"}
    <div class="progress-failed">
      <span class="progress-reason" data-testid="bot-progress-reason">{reason || "Something went wrong while starting the bot."}</span>
      {#if onretry}
        <button
          type="button"
          class="progress-retry"
          data-testid="bot-progress-retry"
          disabled={retrying || !canRetry}
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
    border-radius: 8px;
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
    font-weight: 500;
  }
  .progress-hint {
    color: var(--t3);
    font-size: 13px;
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
    gap: 8px;
    min-height: 20px;
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
  /* Status is a 6px dot plus text. Done is neutral; red only on failure. */
  .progress-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.6;
    flex: 0 0 auto;
  }
  .progress-dot :global(svg) {
    display: none;
  }
  .progress-step[data-step-state="active"] .progress-dot {
    opacity: 1;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .progress-step[data-step-state="failed"] .progress-dot {
    opacity: 1;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
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
    font-size: 13px;
    height: 28px;
    padding: 0 12px;
    border: 0;
    border-radius: 6px;
    background: var(--t1, #111);
    color: var(--panel-bg, #fff);
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
