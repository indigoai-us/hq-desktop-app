<script lang="ts">
  /**
   * The sync strip: one slim line across the top of a cloud bot's direct
   * message, directly under the conversation header, while the bot's copy of
   * the company's files is being brought up to date.
   *
   * It is drawn from plain facts (bot-sync-model.ts), so anything that knows
   * about a sync can show it: the first download after a bot is created, a
   * later sync the server reports, a sync the app asked for. With no facts,
   * or once a finished sync has been shown for a few seconds, it is not there.
   *
   * The host puts it above the message scroller, outside the scroll flow, so
   * it stays in view while the person reads. It takes its own room and never
   * covers a message. Its height opens and closes gently, and it fades, so
   * the thread under it does not jump.
   *
   * One line, left aligned from the strip's left edge: a still sync glyph,
   * the title, the short status line in the muted ink (the phase and the
   * counts, or "Preparing."), and the percent at the right when there is an
   * honest one. Nothing in the strip turns or spins.
   * The progress bar is a two pixel line along the strip's bottom edge, in
   * the theme's muted grey ink so it stays low profile. It is always
   * determinate: filled to the real fraction done, or an empty track while
   * no honest total is known. It never sweeps or shimmers; only its length
   * eases when the number changes (a scale on the compositor, not a width
   * the page lays out again). No border, no shadow, no panel: a faint
   * tint of the accent over the pane, from the theme's own tokens, so it
   * reads in both themes. The copy is the same for every sync, first or
   * later, and never names the bot.
   */
  import { onDestroy, tick, untrack } from "svelte";
  import { botSyncHideDeadline, botSyncView, type BotSyncFacts, type BotSyncView } from "./bot-sync-model.js";

  interface Props {
    facts: BotSyncFacts | null;
    /** Accepted so hosts from before need not change. The copy no longer uses it. */
    botName?: string | null;
  }

  let { facts }: Props = $props();

  /** The height and opacity transitions below, plus a little. The strip leaves the page after it. */
  const CLOSE_MS = 320;

  let now = $state(Date.now());
  const view = $derived(botSyncView(facts, { now }));

  // Time changes the strip in one case only: "up to date" goes away after a
  // few seconds. So there is no ticking clock: one timer is set to that
  // moment. New facts are always read at the present moment, however long
  // ago the last timer fired.
  $effect(() => {
    const current = Date.now();
    now = current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (at: number): void => {
      const deadline = botSyncHideDeadline(facts, at);
      if (deadline === null) return;
      timer = setTimeout(() => {
        timer = null;
        now = Date.now();
        // A timer that fired a moment early is set again for what is left.
        arm(now);
      }, Math.max(0, deadline - at));
    };
    arm(current);
    return () => {
      if (timer) clearTimeout(timer);
    };
  });

  // What is drawn. While the strip closes it keeps its last words.
  let shown = $state<BotSyncView | null>(untrack(() => (view.visible ? view : null)));
  let open = $state(untrack(() => view.visible));
  let slot = $state<HTMLElement | null>(null);
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  $effect(() => {
    const next = view;
    if (next.visible) {
      const wasShown = untrack(() => shown !== null && open);
      shown = next;
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (wasShown) return;
      // Appearing in an open conversation: draw it closed, then let it open.
      const mine = ++generation;
      void tick().then(() => {
        if (mine !== generation) return;
        void slot?.offsetHeight;
        open = true;
      });
      return;
    }
    if (untrack(() => shown) === null || closeTimer) return;
    generation += 1;
    open = false;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      shown = null;
    }, CLOSE_MS);
  });

  onDestroy(() => {
    generation += 1;
    if (closeTimer) clearTimeout(closeTimer);
  });
</script>

{#if shown}
  <div class="bot-sync-slot" data-open={open ? "true" : "false"} bind:this={slot}>
    <div class="bot-sync-clip">
      <div
        class="bot-sync"
        data-testid="bot-sync-widget"
        data-state={shown.state}
        role="group"
        aria-label="File sync"
      >
        <span class="bot-sync-icon" data-testid="bot-sync-icon" aria-hidden="true">
          {#if shown.state === "done"}
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 11L3.5 8l1-1 2 2 5-5 1 1z" fill="currentColor" /></svg>
          {:else if shown.state === "failed"}
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <path d="M8 4.5v4.2M8 11.3v.2" /><circle cx="8" cy="8" r="6.2" />
            </svg>
          {:else}
            <!-- A still glyph in every state. -->
            <svg
              class="bot-sync-glyph"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M13.2 6.2A5.5 5.5 0 0 0 3.4 5M2.8 9.8A5.5 5.5 0 0 0 12.6 11" />
              <path d="M13.4 2.8v3.4H10M2.6 13.2V9.8H6" />
            </svg>
          {/if}
        </span>
        <!-- Only the words are announced. The bar is not. -->
        <div class="bot-sync-words" role="status" aria-live="polite">
          <span class="bot-sync-title" data-testid="bot-sync-title">{shown.title}</span>
          {#if shown.detail}
            <span class="bot-sync-detail" data-testid="bot-sync-detail">{shown.detail}</span>
          {/if}
        </div>
        {#if shown.amount}
          <span class="bot-sync-amount" data-testid="bot-sync-amount" title={shown.counts ?? undefined}>{shown.amount}</span>
        {/if}
        {#if shown.state !== "failed"}
          <div
            class="bot-sync-track"
            data-testid="bot-sync-progress"
            role="progressbar"
            aria-label={shown.title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={shown.progress ?? undefined}
            aria-valuetext={shown.counts ?? undefined}
          >
            <span class="bot-sync-fill" data-testid="bot-sync-fill" style:--fill={shown.fill / 100}></span>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* The slot opens and closes by height and fades, so the thread under it glides. */
  .bot-sync-slot {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows 0.24s ease,
      opacity 0.28s ease;
  }
  .bot-sync-slot[data-open="true"] {
    grid-template-rows: 1fr;
    opacity: 1;
  }
  .bot-sync-clip {
    min-height: 0;
    overflow: hidden;
  }
  /*
   * The strip. Every colour is a theme token, so it follows the light and
   * the dark theme: the accent (the chat shell's violet ink) tinted faintly
   * over the pane, the ink and muted ink for the words, and the muted grey
   * ink (--t3) for the bar over the faint rule (--line) for its track.
   */
  .bot-sync {
    --bs-accent: var(--accent, var(--vio-ink, #854dee));
    --bs-ok: var(--ok-ink, #248a3d);
    --bs-warn: var(--warn-ink, #b45309);
    --bs-tone: var(--bs-accent);
    --bs-bar: var(--t3, color-mix(in srgb, currentColor 34%, transparent));
    --bs-bar-track: var(--line, color-mix(in srgb, currentColor 8%, transparent));
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    min-height: 32px;
    /* The words start at the strip's left edge, not at the centred message
       column, and the percent sits at the right edge. The bar runs edge to edge. */
    padding: 7px 16px 8px;
    text-align: left;
    font-family: var(--font-ui, inherit);
    font-size: 13px;
    line-height: 1.3;
    color: var(--t1, inherit);
    background: color-mix(in srgb, var(--bs-tone) 9%, var(--ground, transparent));
  }
  .bot-sync[data-state="done"] {
    --bs-tone: var(--bs-ok);
  }
  .bot-sync[data-state="failed"] {
    --bs-tone: var(--bs-warn);
  }
  .bot-sync-icon {
    flex: 0 0 auto;
    display: inline-flex;
    color: var(--bs-tone);
  }
  /* Title and sentence on one line. The sentence gives way first when the
     pane is narrow, so the title and the percent always stay whole. */
  .bot-sync-words {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    justify-content: flex-start;
    gap: 10px;
    white-space: nowrap;
  }
  .bot-sync-title {
    flex: 0 0 auto;
    font-weight: 600;
  }
  .bot-sync-detail {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    color: var(--t2, inherit);
  }
  .bot-sync-amount {
    flex: 0 0 auto;
    min-width: 32px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    color: var(--t2, inherit);
  }
  /* The bar: a two pixel line along the strip's bottom edge, full width, in
     the muted grey ink so it stays low profile in every state. */
  .bot-sync-track {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    overflow: hidden;
    background: var(--bs-bar-track);
  }
  .bot-sync-fill {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--bs-bar);
    /* The fill ratio is --fill (0..1), drawn with scaleX so the easing runs
       on the compositor and the page is never laid out again for it. The
       track clips the bar. Same pattern as ProjectRow's progress fill. */
    transform: scaleX(var(--fill, 0));
    transform-origin: left center;
    transition: transform 0.6s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .bot-sync-slot,
    .bot-sync-fill {
      transition: none;
    }
  }
</style>
