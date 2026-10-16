<script lang="ts">
  /**
   * A badge card on its own: the card in the middle of a dark stage, tilting
   * toward the pointer with its foil. Opened by "View card" on a badge, from
   * a badge on the Badges page, and (with `reveal`) from the "You earned" notice.
   *
   * Like the card modal (chat/messaging/CardModal.svelte) it is dark in both
   * app themes, so no colour here comes from a theme variable, and it shares
   * that modal's mechanics: it draws at the app shell, the rest of the app is
   * inert and its shortcuts are held while it is open, Tab stays inside,
   * Escape or the close button closes it, and focus goes back to the control
   * that opened it.
   *
   * `reveal` stages the entrance when a badge is earned, at every tier: a soft glow,
   * then the card turns over from its back to its face (about a second), then
   * the normal tilt. Reduced motion skips straight to the face.
   *
   * Clicking the card (or "Flip card") turns it over to its back, the story
   * of how it was earned (BadgeCardBack.svelte), and back again. Reduced
   * motion swaps the sides without the turn.
   *
   * With an `origin` (the badge tile that was tapped) the card grows out
   * of that tile onto the stage, and goes back into it on close; the tile
   * stays empty while its card is out. Reduced motion skips the flight.
   */
  import RailIcon from "../common/button/RailIcon.svelte";
  import { suspendShortcuts } from "../common/keyboard-shortcuts.js";
  import { portal } from "../chat/portal.js";
  import { focusIntoDialog, inertOutside, restoreFocus, trapTab } from "../chat/messaging/card-modal.js";
  import BadgeCard from "./BadgeCard.svelte";
  import BadgeCardBack from "./BadgeCardBack.svelte";
  import CardBackLogo from "./CardBackLogo.svelte";
  import BadgeShareMenu from "./BadgeShareMenu.svelte";
  import { TIER_NAME, isAwarded, type ResolvedBadge } from "./badge-catalog.js";
  import { REVEAL_FLIP_MS, REVEAL_GLOW_MS, prefersReducedMotion } from "./badge-card.js";
  import { canFly, fly } from "./card-flight.js";

  interface Props {
    open: boolean;
    badge: ResolvedBadge;
    /** Whose card it is, shown under it when it is someone else's. None means
      your own: the story on the back speaks to you. */
    owner?: string | null;
    /** Stage the entrance for a badge just earned. */
    reveal?: boolean;
    onclose: () => void;
    /** Where focus goes on close. Default: what had focus when it opened. */
    returnFocus?: HTMLElement | null;
    /** The pocket the card was tapped in: it flies out of it and back. */
    origin?: HTMLElement | null;
    /**
     * Draw inside this element instead of the app shell. The launch
     * announcement passes its own layer: it sits above the shell and makes
     * the shell inert, so a card drawn there would be hidden and unclickable.
     */
    host?: HTMLElement | null;
  }

  let { open, badge, owner = null, reveal = false, onclose, returnFocus = null, origin = null, host = null }: Props = $props();

  /** The card is flying back to its pocket; the stage fades out with it. */
  let closing = $state(false);
  let cardEl = $state<HTMLDivElement | null>(null);

  /** Every way out (close button, Escape, a click on the stage) comes here. */
  function requestClose(): void {
    if (closing) return;
    if (reveal || !canFly(cardEl, origin)) {
      onclose();
      return;
    }
    closing = true;
    void fly(cardEl, origin, "out").then(() => onclose());
  }

  type Phase = "glow" | "flip" | "done";
  let phase = $state<Phase>("done");
  /** Showing the back: the story of how it was earned. */
  let flipped = $state(false);
  /** The Download menu is open; Escape closes it before the stage. */
  let shareOpen = $state(false);
  /** The reveal runs on its own; the card turns over only once it settles. */
  const canFlip = $derived(phase === "done");

  function flip(): void {
    if (canFlip) flipped = !flipped;
  }
  let panelEl = $state<HTMLDivElement | null>(null);
  let returnFocusNow: HTMLElement | null = null;
  $effect.pre(() => {
    returnFocusNow = returnFocus;
  });

  const tierKey = $derived(badge.tier === "L" ? "L" : String(badge.tier));

  // The staged entrance runs once per opening.
  $effect(() => {
    if (!open) return;
    flipped = false;
    shareOpen = false;
    if (!reveal || prefersReducedMotion()) {
      phase = "done";
      return;
    }
    phase = "glow";
    const toFlip = setTimeout(() => (phase = "flip"), REVEAL_GLOW_MS);
    const toDone = setTimeout(() => (phase = "done"), REVEAL_GLOW_MS + REVEAL_FLIP_MS);
    return () => {
      clearTimeout(toFlip);
      clearTimeout(toDone);
    };
  });

  function layer(node: HTMLElement) {
    // <body> is no opener: WebKit leaves focus there after a click, and the
    // reveal opens from a notice that is gone by the time the card closes.
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    // Moved out of its place, so it removes itself on close either way.
    const ported = host ? (host.appendChild(node), { destroy: () => node.remove() }) : portal(node);
    const releaseInert = inertOutside(node);
    const releaseShortcuts = suspendShortcuts();
    focusIntoDialog(node.querySelector<HTMLElement>('[role="dialog"]'));
    // The card leaves its pocket: the pocket stays empty until it is back.
    const pocket = !reveal && canFly(cardEl, origin) ? origin : null;
    if (pocket) {
      pocket.style.visibility = "hidden";
      void fly(cardEl, pocket, "in");
    }
    return {
      destroy() {
        if (pocket) pocket.style.visibility = "";
        releaseShortcuts();
        releaseInert();
        ported.destroy?.();
        restoreFocus(returnFocusNow ?? opener);
      },
    };
  }

  $effect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (shareOpen) {
          shareOpen = false;
          panelEl?.querySelector<HTMLElement>('[data-testid="badge-card-share"]')?.focus();
          return;
        }
        requestClose();
        return;
      }
      trapTab(event, panelEl);
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });

  function onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) requestClose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="bc-layer" class:flown={Boolean(origin) && !reveal} class:closing data-testid="badge-card-modal" data-phase={phase} data-reveal={reveal ? "true" : "false"} use:layer onclick={onBackdrop}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={panelEl}
      class="bc-stage t{tierKey}"
      role="dialog"
      aria-modal="true"
      aria-label="{badge.def.name} card, {TIER_NAME[badge.tier]}"
      tabindex="-1"
      onclick={onBackdrop}
    >
      <button type="button" class="bc-close" data-testid="badge-card-close" aria-label="Close" onclick={requestClose}>
        <RailIcon name="x" size={14} />
      </button>
      {#if reveal}<span class="bc-glow" aria-hidden="true"></span>{/if}
      <!-- The card turns over on click; "Flip card" below is the same action for
           the keyboard and screen readers. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="bc-card" bind:this={cardEl} class:can-flip={canFlip} data-testid="badge-card-flipper" onclick={flip}>
        <div class="bc-flip" class:flipped data-flipped={flipped ? "true" : "false"}>
          <div class="bc-face" aria-hidden={flipped ? "true" : undefined}>
            <BadgeCard {badge} interactive={canFlip && !flipped} />
          </div>
          <div class="bc-back" aria-hidden={flipped ? undefined : "true"}>
            {#if reveal && phase !== "done"}
              <span class="bc-back-frame"></span>
              <CardBackLogo class="bc-back-logo" />
            {:else}
              <BadgeCardBack {badge} {owner} interactive={canFlip && flipped} />
            {/if}
          </div>
        </div>
      </div>
      <div class="bc-foot">
        {#if owner}<p class="bc-owner" data-testid="badge-card-owner">{isAwarded(badge.def) ? "Awarded to" : "Earned by"} {owner}</p>{/if}
        <div class="bc-actions">
          <button type="button" class="bc-flip-btn" data-testid="badge-card-flip" aria-pressed={flipped} disabled={!canFlip} onclick={flip}>
            <RailIcon name="arrows-clockwise" size={14} />Flip card
          </button>
          <BadgeShareMenu {badge} {owner} bind:open={shareOpen} disabled={!canFlip} />
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Dark stage in both app themes (the card-modal precedent): no theme variables. */
  .bc-layer {
    position: fixed; inset: 0; z-index: 9000;
    display: grid; place-items: center;
    background: rgba(9, 9, 11, 0.92);
    color: #fafafa; color-scheme: dark;
    overscroll-behavior: contain;
    animation: bc-fade 180ms ease-out both;
  }
  /* A card flying out of its pocket: the stage dims in step with the flight,
     and the controls arrive once the card has landed. */
  .bc-layer.flown { animation: bc-dim-in 320ms ease-out both; }
  .bc-layer.flown .bc-foot,
  .bc-layer.flown .bc-close { animation: bc-fade 200ms ease-out 260ms both; }
  .bc-layer.closing { animation: bc-dim-out 280ms ease-in both; pointer-events: none; }
  .bc-layer.closing .bc-foot,
  .bc-layer.closing .bc-close { animation: bc-fade-out 120ms ease-in both; }
  .bc-stage {
    position: relative; width: 100%; height: 100%;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
    background: radial-gradient(ellipse 60% 55% at 50% 48%, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0) 70%);
    outline: none;
    font: 400 13px/1.45 "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .bc-close {
    position: absolute; top: 16px; right: 16px;
    display: grid; place-items: center; width: 30px; height: 30px; padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 50%;
    background: rgba(9, 9, 11, 0.6); color: rgba(250, 250, 250, 0.76); cursor: pointer;
  }
  .bc-close:hover { border-color: rgba(255, 255, 255, 0.4); color: #fafafa; }
  .bc-close:focus-visible { outline: 2px solid rgba(250, 250, 250, 0.7); outline-offset: 2px; }
  .bc-card {
    position: relative; z-index: 1;
    width: min(300px, calc((100vh - 150px) * 5 / 7), calc(100vw - 96px));
    perspective: 1400px;
    /* The card's own shadow on the stage. */
    filter: drop-shadow(0 24px 40px rgba(0, 0, 0, 0.55));
  }
  .bc-card.can-flip { cursor: pointer; }
  .bc-flip { position: relative; transform-style: preserve-3d; transition: transform 640ms cubic-bezier(0.45, 0, 0.2, 1); }
  .bc-flip.flipped { transform: rotateY(180deg); }
  .bc-face { backface-visibility: hidden; -webkit-backface-visibility: hidden; }
  /* WebKit still paints a side's composited insides (the foil canvas, the
     tilt layer) when that side faces away, so the face showed mirrored for a
     moment as the card turned. Each side also hides itself as the card passes
     edge-on: with this easing the turn reaches 90 degrees at 236ms of 640ms. */
  [data-phase="done"] .bc-face { transition: visibility 0s linear 236ms; }
  [data-phase="done"] .bc-flip.flipped .bc-face { visibility: hidden; }
  [data-phase="done"] .bc-back { visibility: hidden; transition: visibility 0s linear 236ms; }
  [data-phase="done"] .bc-flip.flipped .bc-back { visibility: visible; }
  .bc-foot { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .bc-actions { display: flex; align-items: center; gap: 12px; }
  .bc-owner { margin: 0; color: rgba(250, 250, 250, 0.56); }
  /* A quiet text button under the card; it dims on hover, no underline. */
  .bc-flip-btn {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px;
    border: 0; border-radius: 6px; background: none;
    color: rgba(250, 250, 250, 0.72); font: inherit; cursor: pointer;
  }
  .bc-flip-btn:hover:not(:disabled) { color: rgba(250, 250, 250, 0.5); }
  .bc-flip-btn:disabled { opacity: 0.4; cursor: default; }
  .bc-flip-btn:focus-visible { outline: 2px solid rgba(250, 250, 250, 0.7); outline-offset: 2px; }

  /* The card's back, for the reveal. */
  .bc-back {
    position: absolute; inset: 0; display: grid; place-items: center; container-type: inline-size;
    border-radius: 4.3% / 3.07%; overflow: hidden;
    background:
      repeating-radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.035) 0 1px, rgba(255, 255, 255, 0) 1px 7px),
      #17161A;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
    transform: rotateY(180deg);
    backface-visibility: hidden; -webkit-backface-visibility: hidden;
  }
  .bc-back-frame { position: absolute; inset: 2.9%; border-radius: 3.2% / 2.3%; border: 1px solid var(--edge); }
  .bc-back :global(.bc-back-logo) { width: 26%; fill: rgba(244, 239, 232, 0.5); }
  .t1 { --edge: #785037; --glow: rgba(199, 128, 79, 0.5); }
  .t2 { --edge: #686b79; --glow: rgba(170, 176, 198, 0.5); }
  .t3 { --edge: #917125; --glow: rgba(227, 173, 44, 0.5); }
  .tL { --edge: rgba(154, 74, 214, 0.8); --glow: rgba(154, 74, 214, 0.55); }

  /* The glow behind the card: comes up first, then settles. */
  .bc-glow {
    position: absolute; left: 50%; top: 50%; width: 560px; height: 560px; margin: -280px 0 0 -280px;
    border-radius: 50%; pointer-events: none;
    background: radial-gradient(circle, var(--glow), rgba(0, 0, 0, 0) 62%);
    opacity: 0.35;
  }
  .tL .bc-glow { background: radial-gradient(circle, rgba(236, 111, 134, 0.38), rgba(106, 53, 214, 0.3) 34%, rgba(0, 0, 0, 0) 64%); }
  [data-phase="glow"] .bc-glow { animation: bc-glow-in 450ms ease-out both; }
  [data-phase="glow"] .bc-flip { transform: rotateY(180deg); }
  [data-phase="flip"] .bc-flip { animation: bc-turn 1000ms cubic-bezier(0.45, 0, 0.2, 1) both; }
  [data-phase="flip"] .bc-glow { animation: bc-glow-settle 1000ms ease-in-out both; }

  @keyframes bc-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes bc-fade-out { from { opacity: 1; } to { opacity: 0; } }
  /* The flight dims only the backdrop: the card itself stays solid. */
  @keyframes bc-dim-in { from { background-color: rgba(9, 9, 11, 0); } to { background-color: rgba(9, 9, 11, 0.92); } }
  @keyframes bc-dim-out { from { background-color: rgba(9, 9, 11, 0.92); } to { background-color: rgba(9, 9, 11, 0); } }
  @keyframes bc-glow-in { from { opacity: 0; transform: scale(0.7); } to { opacity: 0.9; transform: scale(1); } }
  @keyframes bc-glow-settle { from { opacity: 0.9; } to { opacity: 0.35; } }
  @keyframes bc-turn {
    from { transform: rotateY(180deg) scale(0.94); }
    60% { transform: rotateY(20deg) scale(1.02); }
    to { transform: rotateY(0deg) scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bc-layer, .bc-layer.flown, .bc-layer.flown .bc-foot, .bc-layer.flown .bc-close { animation: none; }
    .bc-glow, .bc-flip { animation: none !important; transform: none !important; transition: none; }
    /* No turn: the sides swap in place. */
    .bc-back { transform: none; visibility: hidden; }
    .bc-flip.flipped .bc-back { visibility: visible; }
    .bc-flip.flipped .bc-face { visibility: hidden; }
    [data-phase="done"] .bc-face, [data-phase="done"] .bc-back { transition: none; }
  }
</style>
