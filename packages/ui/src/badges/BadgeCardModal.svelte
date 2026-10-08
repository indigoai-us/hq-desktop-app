<script lang="ts">
  /**
   * A badge card on its own: the card in the middle of a dark stage, tilting
   * toward the pointer with its foil. Opened by "View card" on a badge, from
   * the Cards binder, and (with `reveal`) from the "You earned" notice.
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
   */
  import RailIcon from "../common/button/RailIcon.svelte";
  import { suspendShortcuts } from "../common/keyboard-shortcuts.js";
  import { portal } from "../chat/portal.js";
  import { focusIntoDialog, inertOutside, restoreFocus, trapTab } from "../chat/messaging/card-modal.js";
  import BadgeCard from "./BadgeCard.svelte";
  import { TIER_NAME, type ResolvedBadge } from "./badge-catalog.js";
  import { REVEAL_FLIP_MS, REVEAL_GLOW_MS, prefersReducedMotion } from "./badge-card.js";

  interface Props {
    open: boolean;
    badge: ResolvedBadge;
    /** Whose card it is, shown under it when it is someone else's. */
    owner?: string | null;
    /** Stage the Gold / Legendary entrance. */
    reveal?: boolean;
    onclose: () => void;
    /** Where focus goes on close. Default: what had focus when it opened. */
    returnFocus?: HTMLElement | null;
  }

  let { open, badge, owner = null, reveal = false, onclose, returnFocus = null }: Props = $props();

  type Phase = "glow" | "flip" | "done";
  let phase = $state<Phase>("done");
  let panelEl = $state<HTMLDivElement | null>(null);
  let returnFocusNow: HTMLElement | null = null;
  $effect.pre(() => {
    returnFocusNow = returnFocus;
  });

  const tierKey = $derived(badge.tier === "L" ? "L" : String(badge.tier));

  // The staged entrance runs once per opening.
  $effect(() => {
    if (!open) return;
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
    const ported = portal(node);
    const releaseInert = inertOutside(node);
    const releaseShortcuts = suspendShortcuts();
    focusIntoDialog(node.querySelector<HTMLElement>('[role="dialog"]'));
    return {
      destroy() {
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
        onclose();
        return;
      }
      trapTab(event, panelEl);
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });

  function onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) onclose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="bc-layer" data-testid="badge-card-modal" data-phase={phase} data-reveal={reveal ? "true" : "false"} use:layer onclick={onBackdrop}>
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
      <button type="button" class="bc-close" data-testid="badge-card-close" aria-label="Close" onclick={() => onclose()}>
        <RailIcon name="x" size={14} />
      </button>
      {#if reveal}<span class="bc-glow" aria-hidden="true"></span>{/if}
      <div class="bc-card">
        <div class="bc-flip">
          <BadgeCard {badge} interactive={phase === "done"} />
          {#if reveal}
            <div class="bc-back" aria-hidden="true">
              <span class="bc-back-frame"></span>
              <svg class="bc-back-logo" viewBox="0 0 577 330"><path d="M176.594 7.54293H243.149V318.135H176.594V185.024H66.5555V318.135H0V7.54293H66.5555V118.469H176.594V7.54293Z"/><path d="M529.768 329.671L496.49 296.837C484.806 304.824 471.938 311.036 457.888 315.473C443.985 319.91 429.343 322.128 413.961 322.128C392.959 322.128 373.214 317.987 354.727 309.705C336.239 301.274 319.97 289.738 305.919 275.096C291.869 260.306 280.85 243.223 272.863 223.848C264.877 204.325 260.883 183.397 260.883 161.064C260.883 138.879 264.877 118.099 272.863 98.7239C280.85 79.201 291.869 62.0445 305.919 47.2544C319.97 32.4642 336.239 20.928 354.727 12.6455C373.214 4.21517 392.959 0 413.961 0C435.111 0 454.93 4.21517 473.417 12.6455C491.905 20.928 508.174 32.4642 522.225 47.2544C536.275 62.0445 547.22 79.201 555.059 98.7239C563.045 118.099 567.039 138.879 567.039 161.064C567.039 177.185 564.82 192.641 560.383 207.431C556.094 222.073 550.178 235.754 542.635 248.474L576.8 282.639L529.768 329.671ZM413.961 255.573C420.025 255.573 425.867 254.907 431.487 253.576C437.255 252.245 442.802 250.396 448.126 248.03L429.491 229.394L476.523 182.362L492.94 198.779C495.454 193.011 497.303 186.947 498.486 180.587C499.818 174.227 500.483 167.72 500.483 161.064C500.483 148.049 498.191 135.847 493.606 124.459C489.169 113.07 482.957 103.087 474.97 94.5087C466.984 85.7826 457.74 78.9791 447.239 74.0984C436.886 69.0698 425.793 66.5554 413.961 66.5554C402.129 66.5554 390.962 69.0698 380.461 74.0984C370.108 78.9791 360.939 85.7826 352.952 94.5087C344.965 103.087 338.679 113.07 334.094 124.459C329.657 135.847 327.439 148.049 327.439 161.064C327.439 174.079 329.657 186.355 334.094 197.892C338.679 209.28 344.965 219.337 352.952 228.063C360.939 236.642 370.108 243.371 380.461 248.252C390.962 253.133 402.129 255.573 413.961 255.573Z"/></svg>
            </div>
          {/if}
        </div>
      </div>
      {#if owner}<p class="bc-owner" data-testid="badge-card-owner">Earned by {owner}</p>{/if}
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
  .bc-flip { position: relative; transform-style: preserve-3d; }
  .bc-flip > :global(.badge-card) { backface-visibility: hidden; -webkit-backface-visibility: hidden; }
  .bc-owner { margin: 0; color: rgba(250, 250, 250, 0.56); }

  /* The card's back, for the reveal. */
  .bc-back {
    position: absolute; inset: 0; display: grid; place-items: center;
    border-radius: 4.3% / 3.07%; overflow: hidden;
    background:
      repeating-radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.035) 0 1px, rgba(255, 255, 255, 0) 1px 7px),
      #17161A;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
    transform: rotateY(180deg);
    backface-visibility: hidden; -webkit-backface-visibility: hidden;
  }
  .bc-back-frame { position: absolute; inset: 2.9%; border-radius: 3.2% / 2.3%; border: 1px solid var(--edge); }
  .bc-back-logo { width: 26%; fill: rgba(244, 239, 232, 0.5); }
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
  @keyframes bc-glow-in { from { opacity: 0; transform: scale(0.7); } to { opacity: 0.9; transform: scale(1); } }
  @keyframes bc-glow-settle { from { opacity: 0.9; } to { opacity: 0.35; } }
  @keyframes bc-turn {
    from { transform: rotateY(180deg) scale(0.94); }
    60% { transform: rotateY(20deg) scale(1.02); }
    to { transform: rotateY(0deg) scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bc-layer { animation: none; }
    .bc-glow, .bc-flip { animation: none !important; transform: none !important; }
  }
</style>
