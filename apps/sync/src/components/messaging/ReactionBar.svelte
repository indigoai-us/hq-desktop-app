<script lang="ts">
  // Reaction pills + add-reaction trigger under one message bubble (US-025).
  // Mounted by <Conversation/> beneath every bubble across DMs, channels, and
  // threads. Pure presentation: the parent owns the reaction map and the toggle
  // call (optimistic, reconciled by the message:reaction event) — this component
  // just renders the pills and bubbles a (messageId, emoji) toggle up.
  //
  // Tap-visible affordances (NOT hover-gated): the standalone window is frameless
  // and has no reliable hover, so the add-reaction "+" trigger is ALWAYS rendered
  // (mirrors the thread-affordance pattern in Conversation.svelte). Pills wrap at
  // narrow widths; every interactive element is a >=28px tap target.
  import { type ReactionAggregate } from '../../lib/reactions';
  import EmojiPicker from './EmojiPicker.svelte';

  interface Props {
    // This bubble's eventId — bubbled back with the chosen emoji so the host can
    // toggle the right message.
    messageId: string;
    // Aggregated reactions for this message (already sorted by the host). Empty
    // when the message has none — only the add-reaction trigger renders then.
    reactions?: ReactionAggregate[];
    // Called with (messageId, emoji) when a pill or a picked emoji is tapped. The
    // host performs the optimistic toggle + the toggle_reaction invoke.
    ontoggle: (messageId: string, emoji: string) => void;
    // Compact treatment for dense list rows (the notification feed): smaller
    // pills, and the add-reaction trigger stays visually quiet until the row
    // is hovered / focused (it remains in the tab order — hidden by opacity,
    // not display, so keyboard users can still reach it).
    compact?: boolean;
  }

  let { messageId, reactions = [], ontoggle, compact = false }: Props = $props();

  let pickerOpen = $state(false);

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
      aria-label={`${r.emoji} ${r.count} ${r.count === 1 ? 'reaction' : 'reactions'}${r.reactedByMe ? ', you reacted' : ''}`}
    >
      <span class="reaction-emoji">{r.emoji}</span>
      <span class="reaction-count">{r.count}</span>
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

  .reaction-pill {
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
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }

  .reaction-pill:hover,
  .reaction-pill:focus-visible {
    background: var(--c-field-bg);
    outline: none;
  }

  /* Highlighted when the caller is among the reactors. Count color is
     token-driven — the old #dce8ff literal vanished on light-mode hosts
     (popover feed / desktop notifications). */
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
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .reaction-add:hover,
  .reaction-add:focus-visible,
  .reaction-add[aria-expanded='true'] {
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

  /* ── Compact mode (dense feed rows) ─────────────────────────────────────
     Smaller pills; the add trigger fades in on hover/focus of the bar (or of
     an ancestor `.reaction-hover-scope`, e.g. the whole feed row) so the
     resting row stays quiet. Existing reaction chips stay inline always. */
  .reaction-bar.compact {
    gap: 0.1875rem;
    margin: 0.25rem 0 0;
  }

  .reaction-bar.compact .reaction-pill {
    min-height: 1.375rem;
    padding: 0.0625rem 0.4375rem;
    font-size: 11px;
  }

  .reaction-bar.compact .reaction-add {
    min-width: 1.375rem;
    min-height: 1.375rem;
    padding: 0 0.25rem;
    font-size: 11px;
    opacity: 0;
    transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
  }

  .reaction-bar.compact:hover .reaction-add,
  .reaction-bar.compact:focus-within .reaction-add,
  .reaction-bar.compact .reaction-add[aria-expanded='true'],
  :global(.reaction-hover-scope:hover) .reaction-bar.compact .reaction-add,
  :global(.reaction-hover-scope:focus-within) .reaction-bar.compact .reaction-add {
    opacity: 1;
  }
</style>
