<script lang="ts">
  // Reaction pills + add-reaction trigger under one message bubble (US-025,
  // ported verbatim from the hq-sync desktop source). Pure presentation: the
  // parent owns the reaction map and the toggle call; this component renders the
  // pills and bubbles a (messageId, emoji) toggle up.
  import { type ReactionAggregate, reactionAttribution } from "./reactions";
  import EmojiPicker from "./EmojiPicker.svelte";

  interface Props {
    messageId: string;
    reactions?: ReactionAggregate[];
    ontoggle: (messageId: string, emoji: string) => void;
    compact?: boolean;
    selfPersonUid?: string | null;
    displayNameByUid?: Record<string, string>;
  }

  let {
    messageId,
    reactions = [],
    ontoggle,
    compact = false,
    selfPersonUid = null,
    displayNameByUid = {},
  }: Props = $props();

  let pickerOpen = $state(false);

  function reactorTitle(r: ReactionAggregate): string {
    return reactionAttribution(r, selfPersonUid, displayNameByUid);
  }

  function toggle(emoji: string): void {
    ontoggle(messageId, emoji);
  }

  function pick(emoji: string): void {
    pickerOpen = false;
    ontoggle(messageId, emoji);
  }
</script>

<div class="reaction-bar" class:compact>
  {#each reactions as r (r.emoji)}
    <button
      class="reaction-pill"
      class:reacted={r.reactedByMe}
      type="button"
      onclick={() => toggle(r.emoji)}
      aria-pressed={r.reactedByMe}
      title={reactorTitle(r)}
      aria-label={reactorTitle(r) ??
        `${r.emoji} ${r.count} ${r.count === 1 ? "reaction" : "reactions"}${r.reactedByMe ? ", you reacted" : ""}`}
    >
      <span class="reaction-emoji">{r.emoji}</span>
      <span class="reaction-count">{r.count}</span>
      <span class="reaction-tooltip" aria-hidden="true">{reactorTitle(r)}</span>
    </button>
  {/each}

  <div class="reaction-add-wrap">
    <button
      class="reaction-add"
      type="button"
      onclick={() => (pickerOpen = !pickerOpen)}
      aria-haspopup="menu"
      aria-expanded={pickerOpen}
      aria-label="Add a reaction"
      title="Add a reaction"
    >
      <span class="reaction-add-glyph" aria-hidden="true">☺</span>
      <span class="reaction-add-plus" aria-hidden="true">+</span>
    </button>
    {#if pickerOpen}
      <EmojiPicker onpick={pick} onclose={() => (pickerOpen = false)} />
    {/if}
  </div>
</div>

<style>
  /* Tap-visible (NOT hover-gated) — always rendered so the frameless window's
     missing hover never hides the affordance. Mirrors .thread-affordance. */
  .reaction-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    align-self: inherit; /* hug the bubble side (in/out) it sits under */
    margin: 0.25rem 0.125rem 0;
  }

  .reaction-tooltip {
    display: none;
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 20;
    width: max-content;
    max-width: 280px;
    padding: 6px 8px;
    border: 1px solid var(--pop-border);
    border-radius: 6px;
    /* Attribution must remain readable over a translucent chat window. */
    background: var(--v4-surface-solid, #ffffff);
    color: var(--pop-text);
    text-align: left;
    line-height: 1.4;
    pointer-events: none;
  }
  .reaction-pill:hover .reaction-tooltip,
  .reaction-pill:focus-visible .reaction-tooltip { display: block; }
  .reaction-pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 1.75rem; /* 28px tap target */
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--pop-border);
    border-radius: 999px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-family: inherit;
    font-size: var(--text-base);
    line-height: 1;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease;
  }

  .reaction-pill:hover,
  .reaction-pill:focus-visible {
    background: var(--c-field-bg);
    outline: none;
  }

  .reaction-pill.reacted {
    background: var(--c-field-bg);
    border-color: var(--c-field-border);
    color: var(--pop-text);
  }

  .reaction-pill.reacted:hover,
  .reaction-pill.reacted:focus-visible {
    background: var(--pop-hover);
  }

  .reaction-emoji {
    font-size: var(--text-base);
    line-height: 1;
  }

  .reaction-count {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .reaction-add-wrap {
    position: relative;
    display: inline-flex;
  }

  .reaction-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.0625rem;
    min-width: 1.75rem; /* 28px tap target */
    min-height: 1.75rem;
    padding: 0 0.375rem;
    border: 1px solid var(--pop-border);
    border-radius: 999px;
    background: var(--pop-hover);
    color: var(--pop-muted);
    font-family: inherit;
    font-size: var(--text-base);
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }

  .reaction-add:hover,
  .reaction-add:focus-visible,
  .reaction-add[aria-expanded="true"] {
    background: var(--c-field-bg);
    color: var(--pop-text);
    outline: none;
  }

  .reaction-add-glyph {
    font-size: var(--text-base);
    line-height: 1;
  }

  .reaction-add-plus {
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 1;
  }

  .reaction-bar.compact {
    gap: 0.1875rem;
    margin: 0.25rem 0 0;
  }

  .reaction-bar.compact .reaction-pill {
    min-height: 1.375rem;
    padding: 0.0625rem 0.4375rem;
    font-size: 11px;
  }

  /* Tap-visible like the regular variant — the frameless Tauri window has no
     reliable hover, so the affordance must never be opacity-gated. */
  .reaction-bar.compact .reaction-add {
    min-width: 1.375rem;
    min-height: 1.375rem;
    padding: 0 0.25rem;
    font-size: 11px;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }
</style>
