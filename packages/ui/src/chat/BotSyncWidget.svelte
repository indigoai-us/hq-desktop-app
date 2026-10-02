<script lang="ts">
  /**
   * The sync widget: a slim bar pinned at the bottom of a cloud bot's direct
   * message, above the suggested replies and the message box, while the
   * bot's copy of the company's files is being brought up to date.
   *
   * It is drawn from plain facts (bot-sync-model.ts), so anything that knows
   * about a sync can show it: the first download after a bot is created, a
   * later sync the server reports, a sync the app asked for. With no facts,
   * or once a finished sync has been shown for a few seconds, it is not there.
   *
   * The host pins it under the thread, so it stays in view while the person
   * scrolls. It takes its own room and never covers a message. Its height
   * opens and closes gently, so the thread above it does not jump.
   *
   * The look is the connection cards' at bar size: a strip of the same
   * wallpaper, a dark scrim, a glass panel holding the words. Like the cards
   * it is dark in both app themes, so no color here is a theme variable.
   */
  import { onDestroy, tick, untrack } from "svelte";
  import nodeConstellation from "./create-bot/assets/new-bot-wallpapers/node-constellation.jpg";
  import { botSyncNeedsClock, botSyncView, type BotSyncFacts, type BotSyncView } from "./bot-sync-model.js";

  interface Props {
    facts: BotSyncFacts | null;
    /** The bot's display name, written into the copy. */
    botName?: string | null;
  }

  let { facts, botName = null }: Props = $props();

  /** How often an estimated bar moves, and how soon "up to date" is noticed gone. */
  const CLOCK_MS = 1_000;
  /** The height transition below, plus a little. The bar leaves the page after it. */
  const CLOSE_MS = 280;

  let now = $state(Date.now());
  const view = $derived(botSyncView(facts, { botName, now }));

  // The clock runs only while time itself changes the bar. New facts are
  // always read at the present moment, however long the clock has been still.
  $effect(() => {
    const current = Date.now();
    now = current;
    if (!botSyncNeedsClock(facts, current)) return;
    const timer = setInterval(() => {
      now = Date.now();
      // "Up to date" has been shown long enough: nothing moves any more.
      if (!botSyncNeedsClock(facts, now)) clearInterval(timer);
    }, CLOCK_MS);
    return () => clearInterval(timer);
  });

  // What is drawn. While the bar closes it keeps its last words.
  let shown = $state<BotSyncView | null>(untrack(() => (view.visible ? view : null)));
  let open = $state(untrack(() => view.visible));
  let slot = $state<HTMLElement | null>(null);
  // A finished bar has fewer words than a syncing or a failed one. It keeps
  // the height the bar had before, so the thread above it does not move.
  let glass = $state<HTMLElement | null>(null);
  let lastHeight = $state(0);
  const heldHeight = $derived(shown?.state === "done" && lastHeight > 0 ? `${lastHeight}px` : null);
  $effect(() => {
    const el = glass;
    if (!el || !shown || shown.state === "done") return;
    const measure = (): void => {
      if (el.offsetHeight > 0) lastHeight = el.offsetHeight;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
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
        <span class="bot-sync-art" aria-hidden="true" style:background-image={`url("${nodeConstellation}")`}></span>
        <div class="bot-sync-glass" bind:this={glass} style:min-height={heldHeight}>
          <span class="bot-sync-icon" aria-hidden="true">
            {#if shown.state === "done"}
              <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 11L3.5 8l1-1 2 2 5-5 1 1z" fill="currentColor" /></svg>
            {:else if shown.state === "failed"}
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <path d="M8 4.5v4.2M8 11.3v.2" /><circle cx="8" cy="8" r="6.2" />
              </svg>
            {:else}
              <svg class="bot-sync-spin" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13.2 6.2A5.5 5.5 0 0 0 3.4 5M2.8 9.8A5.5 5.5 0 0 0 12.6 11" />
                <path d="M13.4 2.8v3.4H10M2.6 13.2V9.8H6" />
              </svg>
            {/if}
          </span>
          <div class="bot-sync-body">
            <!-- Only the words are announced. The bar moves every second and is not. -->
            <div class="bot-sync-words" role="status" aria-live="polite">
              <span class="bot-sync-title" data-testid="bot-sync-title">{shown.title}</span>
              {#if shown.detail}
                <span class="bot-sync-detail" data-testid="bot-sync-detail">{shown.detail}</span>
              {/if}
            </div>
            {#if shown.state !== "failed"}
              <div class="bot-sync-meter">
                <div
                  class="bot-sync-track"
                  class:is-unknown={shown.progress === null}
                  data-testid="bot-sync-progress"
                  role="progressbar"
                  aria-label={shown.title}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={shown.progress ?? undefined}
                  aria-valuetext={shown.counts ?? undefined}
                >
                  <span class="bot-sync-fill" style:width={`${shown.progress ?? 100}%`}></span>
                </div>
                {#if shown.amount}
                  <span class="bot-sync-amount" data-testid="bot-sync-amount" title={shown.counts ?? undefined}>{shown.amount}</span>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* The slot opens and closes by height, so the rows around it glide. */
  .bot-sync-slot {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows 0.24s ease,
      opacity 0.2s ease;
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
   * Wallpaper, scrim, glass: the connection cards' layers at bar size. Dark
   * in the light and the dark app theme alike. Words sit on the glass; the
   * inks are the cards' and stay above 4.5:1 on it. Change the scrim, the
   * glass or an ink together with ConnectionCard.svelte, never one alone.
   */
  .bot-sync {
    --bs-ink: #fafafa;
    --bs-muted: rgba(250, 250, 250, 0.76);
    --bs-accent: #c4a5ff;
    --bs-ok: #4ade80;
    --bs-warn: #fcd34d;
    position: relative;
    isolation: isolate;
    overflow: hidden;
    box-sizing: border-box;
    /* As wide as the host's column (the message box), with air under it. Its
       own width decides the tighter layout below, whatever the window is. */
    container-type: inline-size;
    margin: 0 0 8px;
    padding: 2px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
    font-family: var(--font-ui, inherit);
    font-size: 13px;
    color: var(--bs-ink);
    background: #09090b;
    color-scheme: dark;
  }
  .bot-sync[data-state="done"] {
    border-color: color-mix(in srgb, var(--bs-ok) 60%, transparent);
  }
  .bot-sync[data-state="failed"] {
    border-color: color-mix(in srgb, var(--bs-warn) 55%, transparent);
  }
  .bot-sync-art {
    position: absolute;
    z-index: -1;
    inset: 0;
    background-position: center 62%;
    background-size: cover;
    background-repeat: no-repeat;
  }
  .bot-sync-art::after {
    content: "";
    position: absolute;
    inset: 0;
    background: rgba(9, 9, 11, 0.24);
  }
  .bot-sync-glass {
    display: flex;
    align-items: center;
    gap: 9px;
    box-sizing: border-box;
    padding: 7px 10px 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 5px;
    background: rgba(17, 17, 19, 0.72);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
  }
  .bot-sync-icon {
    flex: 0 0 auto;
    align-self: flex-start;
    display: inline-flex;
    margin-top: 2px;
    color: var(--bs-accent);
  }
  .bot-sync[data-state="done"] .bot-sync-icon {
    color: var(--bs-ok);
  }
  .bot-sync[data-state="failed"] .bot-sync-icon {
    color: var(--bs-warn);
  }
  .bot-sync-spin {
    animation: bot-sync-spin 2.4s linear infinite;
  }
  @keyframes bot-sync-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .bot-sync-body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--bs-gap, 4px);
  }
  /* Title and line share a row when there is room, and wrap when there is not. */
  .bot-sync-words {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 1px 10px;
    line-height: 1.4;
  }
  .bot-sync-title {
    font-weight: 600;
  }
  .bot-sync-detail {
    font-size: 12px;
    color: var(--bs-muted);
  }
  /* One height with or without the percent, so a first real number moves nothing. */
  .bot-sync-meter {
    display: flex;
    align-items: center;
    gap: 9px;
    height: var(--bs-meter, 12px);
  }
  /* A failed bar has no meter. It keeps the meter's room, half above and half
     below its words, so it is exactly as tall as a syncing bar. */
  .bot-sync[data-state="failed"] .bot-sync-body {
    padding-block: calc((var(--bs-meter, 12px) + var(--bs-gap, 4px)) / 2);
  }
  .bot-sync-track {
    position: relative;
    flex: 1 1 auto;
    height: 4px;
    overflow: hidden;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.16);
  }
  .bot-sync-fill {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--bs-accent);
    transition: width 0.6s ease;
  }
  .bot-sync[data-state="done"] .bot-sync-fill {
    background: var(--bs-ok);
  }
  /* No honest number: a soft band travels the track, and no width is claimed. */
  .bot-sync-track.is-unknown .bot-sync-fill {
    width: 34% !important;
    opacity: 0.8;
    animation: bot-sync-travel 1.8s ease-in-out infinite;
  }
  @keyframes bot-sync-travel {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(310%);
    }
  }
  .bot-sync-amount {
    flex: 0 0 auto;
    min-width: 30px;
    font-size: 11px;
    line-height: var(--bs-meter, 12px);
    font-variant-numeric: tabular-nums;
    text-align: right;
    color: var(--bs-muted);
  }
  /* A narrow bar wraps its words onto more lines: it gives up some air to
     stay slim. */
  @container (max-width: 480px) {
    .bot-sync-glass {
      --bs-meter: 10px;
      --bs-gap: 3px;
      padding: 5px 9px 6px;
    }
    .bot-sync-words {
      row-gap: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bot-sync-slot,
    .bot-sync-fill {
      transition: none;
    }
    .bot-sync-spin {
      animation: none;
    }
    /* A still, full, faint track instead of a moving band. */
    .bot-sync-track.is-unknown .bot-sync-fill {
      width: 100% !important;
      opacity: 0.35;
      animation: none;
      transform: none;
    }
  }
</style>
