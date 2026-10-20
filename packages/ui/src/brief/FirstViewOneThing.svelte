<script lang="ts">
  /**
   * First view, the one-thing slot: Core's primary welcome action, its reason
   * and one way to start it. Sized to its content, so it never holds an empty
   * area open.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import { useBrief } from "./brief-context.svelte.js";
  import type { WelcomeAction } from "./brief-welcome-contract.js";
  import { plainReason, withoutZeroCounts } from "./brief-first-view-copy.js";

  interface Props {
    action: WelcomeAction;
    /** Runs an action that is not a prompt (open a harness, connect); absent shows no button for one. */
    onaction?: ((action: WelcomeAction) => void) | null;
    /** The button's words for an action that is not a prompt. */
    actionLabel?: string | null;
    /** The action is in flight (a harness opening): the button is disabled until it settles. */
    busy?: boolean;
  }
  let { action, onaction = null, actionLabel = null, busy = false }: Props = $props();
  const brief = useBrief();
  const quote = $derived(/[.!?]$/.test(action.label.trim()) ? action.label.trim() : `${action.label.trim()}.`);
  const because = $derived(withoutZeroCounts(plainReason(action.reason)));
  /** Open and connect actions run through the host; the rest start their prompt in the brief's engine. */
  const prompt = $derived(action.kind === "open_harness" || action.kind.startsWith("connect_") ? "" : (action.launch_prompt ?? ""));
</script>

<div class="w c-violet fv-one" data-testid="first-view-one-thing" data-kind={action.kind}>
  <div class="q" data-testid="first-view-one-thing-quote">{quote}</div>
  {#if because}<div class="because">{because}</div>{/if}
  <div class="go-row">
    {#if prompt}
      <BriefLaunch id={action.id} {prompt} compact />
    {:else if onaction && actionLabel}
      <button type="button" class="fv-btn" data-testid="first-view-one-thing-action" disabled={busy} aria-busy={busy} onclick={() => onaction?.(action)}>{actionLabel}</button>
    {/if}
  </div>
  {#if brief.notes[action.id]}<div class="note" role="status">{brief.notes[action.id]}</div>{/if}
</div>

<style>
  .fv-one {
    padding-top: 48px;
  }
  .q {
    font-size: var(--b-fs-title-lg);
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  .because {
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.4;
    color: rgb(var(--b-ink) / 0.76);
    max-width: 62ch;
  }
  .go-row {
    display: flex;
    justify-content: flex-end;
    padding-top: 14px;
  }
  .go-row:empty {
    display: none;
  }
  .fv-btn {
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 6px 13px;
    border-radius: 999px;
    border: 0;
    cursor: pointer;
    background: rgb(var(--b-ink) / 0.92);
    color: #1b1b22;
  }
  .fv-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .note {
    margin-top: 6px;
    font-size: 11px;
    color: #fff;
  }
</style>
