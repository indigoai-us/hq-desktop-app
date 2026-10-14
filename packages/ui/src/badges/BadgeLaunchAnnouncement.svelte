<script lang="ts">
  /**
   * hq-accomplishment-badges US-016: the launch announcement. Over the whole
   * window, once (badge-launch.ts decides when): it introduces
   * accomplishments and deals the person's badges into a hand of cards.
   *
   * The motion carries one idea: these cards are yours. They are dealt face
   * down from below and turn over as they land, the best one last and in the
   * middle; the light behind the hand takes the colour of the highest tier.
   * Someone with no badges yet is dealt three cards that stay face down, with
   * the badges they are closest to under them. Reduced motion shows the
   * settled hand at once.
   *
   * It shares the card modal's mechanics (BadgeCardModal.svelte): dark in
   * both app themes, drawn at the app shell, the rest of the app inert and
   * its shortcuts held, Tab kept inside, Escape or the close button closes
   * it, and focus goes back afterwards.
   */
  import RailIcon from "../common/button/RailIcon.svelte";
  import { suspendShortcuts } from "../common/keyboard-shortcuts.js";
  import { portal } from "../chat/portal.js";
  import { inertOutside, restoreFocus, trapTab } from "../chat/messaging/card-modal.js";
  import BadgeCard from "./BadgeCard.svelte";
  import BadgeMark from "./BadgeMark.svelte";
  import CardBackLogo from "./CardBackLogo.svelte";
  import { BADGE_BY_ID, TIER_NAME, type ResolvedBadge } from "./badge-catalog.js";
  import { prefersReducedMotion } from "./badge-card.js";
  import type { BadgeProgress } from "./badge-source.js";
  import { fanSlots, handTier, launchHand, launchLead, nextUp, progressLine } from "./badge-launch.js";

  interface Props {
    /** The person's earned badges. */
    badges: readonly ResolvedBadge[];
    /** Progress toward badges not earned yet, for the empty hand. */
    progress?: readonly BadgeProgress[];
    /** "See your badges": open the Badges page. */
    onopenbadges: () => void;
    /** Closed without opening the Badges page. */
    onclose: () => void;
  }

  let { badges, progress = [], onopenbadges, onclose }: Props = $props();

  /** Base delay before the first card is dealt, and the gap between cards. */
  const DEAL_START_MS = 420;
  const DEAL_STEP_MS = 120;
  const DEAL_MS = 760;
  const EXIT_MS = 220;

  const hand = $derived(launchHand(badges));
  const empty = $derived(hand.shown.length === 0);
  /** Three face-down cards stand in for the badges still to come. */
  const count = $derived(empty ? 3 : hand.shown.length);
  const slots = $derived(fanSlots(count));
  /** Outer cards first, the middle (best) card last. */
  function dealOrder(i: number): number {
    const mid = (count - 1) / 2;
    const ranks = slots.map((_, j) => j).sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid) || a - b);
    return ranks.indexOf(i);
  }
  const lastLandMs = $derived(DEAL_START_MS + (count - 1) * DEAL_STEP_MS + DEAL_MS);
  const tier = $derived(handTier(hand.shown));
  const tierKey = $derived(tier === null ? "none" : tier === "L" ? "L" : String(tier));
  const upNext = $derived(empty ? nextUp(progress) : []);

  const reduced = prefersReducedMotion();
  /** The hand has landed: the cards follow the pointer from here. */
  let settled = $state(reduced);
  let leaving = $state(false);
  let panelEl = $state<HTMLDivElement | null>(null);
  let primaryEl = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    if (reduced) return;
    const t = setTimeout(() => (settled = true), lastLandMs);
    return () => clearTimeout(t);
  });

  function leave(then: () => void): void {
    if (leaving) return;
    if (reduced) {
      then();
      return;
    }
    leaving = true;
    setTimeout(then, EXIT_MS);
  }

  function layer(node: HTMLElement) {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    const ported = portal(node);
    const releaseInert = inertOutside(node);
    const releaseShortcuts = suspendShortcuts();
    // The one thing to do here is the primary action, so it starts focused.
    queueMicrotask(() => primaryEl?.focus({ preventScroll: true }));
    return {
      destroy() {
        releaseShortcuts();
        releaseInert();
        ported.destroy?.();
        restoreFocus(opener);
      },
    };
  }

  $effect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        leave(onclose);
        return;
      }
      trapTab(event, panelEl);
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });

  function badgeLabel(b: ResolvedBadge): string {
    const single = b.def.levels.startsWith("Single") || b.def.levels.startsWith("Limited");
    return single ? b.def.name : `${b.def.name}, ${TIER_NAME[b.tier]}`;
  }
</script>

<div
  class="la-layer t{tierKey}"
  class:reduced
  class:leaving
  class:settled
  data-testid="badge-launch"
  data-state={empty ? "empty" : "earned"}
  style="--land: {lastLandMs}ms"
  use:layer
>
  <div bind:this={panelEl} class="la-stage" role="dialog" aria-modal="true" aria-labelledby="la-title" aria-describedby="la-lead" tabindex="-1">
    <button type="button" class="la-close" data-testid="badge-launch-close" aria-label="Close" onclick={() => leave(onclose)}>
      <RailIcon name="x" size={14} />
    </button>

    <header class="la-head">
      <p class="la-eyebrow">New in HQ</p>
      <h1 class="la-title" id="la-title">Accomplishments</h1>
      <p class="la-lead" id="la-lead">{launchLead(badges.length)}</p>
    </header>

    <div class="la-hand" class:empty aria-hidden="true">
      <span class="la-light"></span>
      {#each slots as slot, i (i)}
        <div
          class="la-slot"
          style="--x: {slot.x}; --y: {slot.y}; --r: {slot.rotate}deg; --z: {slot.z}; --d: {DEAL_START_MS + dealOrder(i) * DEAL_STEP_MS}ms"
        >
          <div class="la-flip" class:face-down={empty}>
            {#if !empty}
              <div class="la-face"><BadgeCard badge={hand.shown[i]} interactive={settled && !leaving} /></div>
            {/if}
            <div class="la-back"><span class="la-back-frame"></span><CardBackLogo class="la-back-logo" /></div>
          </div>
        </div>
      {/each}
    </div>
    {#if hand.more > 0}
      <span class="la-more" data-testid="badge-launch-more">+{hand.more} more</span>
    {/if}

    <!-- The hand is decoration for sighted people; this says the same. -->
    {#if !empty}
      <ul class="la-sr" data-testid="badge-launch-list">
        {#each badges as b (b.def.id)}<li>{badgeLabel(b)}</li>{/each}
      </ul>
    {/if}

    {#if upNext.length}
      <ul class="la-next" data-testid="badge-launch-next">
        {#each upNext as p (p.id)}
          {@const def = BADGE_BY_ID[p.id]}
          {#if def}
            <li>
              <BadgeMark badge={def} tier={def.tier} size="small" locked label={def.name} />
              <span class="la-next-name">{def.name}</span>
              <span class="la-next-count">{progressLine(p)}</span>
            </li>
          {/if}
        {/each}
      </ul>
    {/if}

    <div class="la-actions">
      <button bind:this={primaryEl} type="button" class="la-primary" data-testid="badge-launch-open" onclick={() => leave(onopenbadges)}>
        {empty ? "See all badges" : "See your badges"}
      </button>
      <button type="button" class="la-later" data-testid="badge-launch-later" onclick={() => leave(onclose)}>Not now</button>
    </div>
  </div>
</div>

<style>
  /* The display serif the first-run takeover uses, for the one title here. */
  @font-face {
    font-family: "Launch Fraunces";
    src: url("../chat/create-bot/assets/new-bot-wallpapers/fraunces-variable-latin.woff2") format("woff2");
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
  }
  /* Dark stage in both app themes, like the card modal: no theme variables. */
  .la-layer {
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --ink: oklch(0.97 0.004 75);
    --ink-2: oklch(0.97 0.004 75 / 0.68);
    --ink-3: oklch(0.97 0.004 75 / 0.46);
    position: fixed; inset: 0; z-index: 9100;
    background: oklch(0.15 0.006 285 / 0.985);
    color: var(--ink); color-scheme: dark;
    overscroll-behavior: contain;
    animation: la-fade 320ms ease-out both;
  }
  .la-layer.leaving { animation: la-fade-out 220ms ease-in both; pointer-events: none; }
  .la-layer.leaving .la-stage { transition: transform 220ms ease-in; transform: scale(0.985); }

  .la-stage {
    position: relative; height: 100%;
    display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto auto; justify-items: center;
    padding: clamp(40px, 9vh, 96px) 32px clamp(28px, 6vh, 56px);
    outline: none;
    font: 400 13px/1.45 "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .la-close {
    position: absolute; top: 20px; right: 20px;
    display: grid; place-items: center; width: 30px; height: 30px; padding: 0;
    border: 1px solid oklch(0.97 0.004 75 / 0.14); border-radius: 50%;
    background: none; color: var(--ink-2); cursor: pointer;
    transition: border-color 160ms ease-out, color 160ms ease-out;
    animation: la-fade 240ms ease-out var(--land) both;
  }
  .la-close:hover { border-color: oklch(0.97 0.004 75 / 0.4); color: var(--ink); }

  .la-head { text-align: center; max-width: 60ch; text-wrap: balance; }
  .la-head > * { margin: 0; animation: la-rise 680ms var(--ease-out) both; }
  .la-eyebrow { color: var(--ink-3); font-size: 12px; letter-spacing: 0.04em; animation-delay: 80ms !important; }
  .la-title {
    margin-top: 10px !important;
    font: 400 clamp(40px, 6.4vh, 60px)/1.02 "Launch Fraunces", Fraunces, Georgia, "Times New Roman", serif;
    font-optical-sizing: auto; letter-spacing: -0.015em;
    animation-delay: 160ms !important;
  }
  .la-lead { margin-top: 14px !important; color: var(--ink-2); font-size: 15px; line-height: 1.5; animation-delay: 240ms !important; }

  /* The hand. Each slot is placed by transform only, from the fan layout. */
  /* The hand takes the room between the words and the buttons, and the
     cards size to it (container units), so nothing overlaps in a short window. */
  .la-hand {
    position: relative; align-self: stretch;
    width: 100%; min-height: 150px; margin: clamp(12px, 2vh, 24px) 0 clamp(16px, 3vh, 32px);
    /* Sits a little above the middle of its room, so the gaps above and below read even. */
    padding-bottom: clamp(24px, 6vh, 64px); box-sizing: border-box;
    container-type: size;
    display: grid; place-items: center;
  }
  .la-hand > * { --card-w: min(216px, calc(100cqh * 5 / 7 / 1.24), calc(100cqw / 3.4)); }
  .la-hand.empty > * { --card-w: min(150px, calc(100cqh * 5 / 7 / 1.2), calc(100cqw / 3.4)); }
  .la-light {
    position: absolute; left: 50%; top: 50%;
    width: calc(var(--card-w) * 4.2); aspect-ratio: 1; translate: -50% -50%;
    border-radius: 50%; pointer-events: none;
    background: radial-gradient(circle, var(--glow, transparent), transparent 62%);
    opacity: 0.4;
    animation: la-light 1100ms var(--ease-out) calc(var(--land) - 240ms) both;
  }
  .t1 { --glow: rgba(199, 128, 79, 0.42); }
  .t2 { --glow: rgba(170, 176, 198, 0.4); }
  .t3 { --glow: rgba(227, 173, 44, 0.4); }
  .tL { --glow: rgba(154, 74, 214, 0.48); }
  .tnone { --glow: oklch(0.97 0.004 75 / 0.06); }

  .la-slot {
    grid-area: 1 / 1; z-index: var(--z);
    width: var(--card-w);
    perspective: 1400px;
    transform:
      translate(calc(var(--card-w) * var(--x)), calc(var(--card-w) * 7 / 5 * var(--y)))
      rotate(var(--r));
    filter: drop-shadow(0 22px 36px rgba(0, 0, 0, 0.5));
    animation: la-deal var(--deal, 760ms) var(--ease-out) var(--d) both;
  }
  /* Settled: a card lifts out of the hand under the pointer, to show it moves. */
  .settled .la-slot { transition: translate 260ms var(--ease-out); }
  .settled .la-slot:hover { translate: 0 -14px; z-index: 20; }

  .la-flip { position: relative; transform-style: preserve-3d; animation: la-turn 640ms cubic-bezier(0.45, 0, 0.2, 1) calc(var(--d) + 200ms) both; }
  .la-flip.face-down { animation: none; transform: rotateY(180deg); }
  .la-face { backface-visibility: hidden; -webkit-backface-visibility: hidden; animation: la-show 640ms linear calc(var(--d) + 200ms) both; }
  .la-back {
    position: absolute; inset: 0; display: grid; place-items: center;
    border-radius: 4.3% / 3.07%; overflow: hidden;
    background:
      repeating-radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.035) 0 1px, rgba(255, 255, 255, 0) 1px 7px),
      #17161A;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
    transform: rotateY(180deg);
    backface-visibility: hidden; -webkit-backface-visibility: hidden;
    animation: la-hide 640ms linear calc(var(--d) + 200ms) both;
  }
  .face-down .la-back { animation: none; aspect-ratio: 5 / 7; position: relative; }
  .la-back-frame { position: absolute; inset: 2.9%; border-radius: 3.2% / 2.3%; border: 1px solid oklch(0.97 0.004 75 / 0.12); }
  .la-back :global(.la-back-logo) { width: 26%; fill: rgba(244, 239, 232, 0.42); }

  .la-more {
    padding: 4px 11px; border-radius: 999px;
    background: oklch(0.24 0.006 285); border: 1px solid oklch(0.97 0.004 75 / 0.22);
    color: var(--ink); font-size: 12px;
    animation: la-fade 300ms ease-out var(--land) both;
  }

  .la-next {
    list-style: none; margin: 4px 0 0; padding: 0;
    display: grid; grid-template-columns: auto minmax(120px, auto) auto; gap: 10px 16px; align-items: center;
    animation: la-rise 520ms var(--ease-out) var(--land) both;
  }
  .la-next li { display: contents; }
  .la-next-name { color: var(--ink); }
  .la-next-count { justify-self: end; color: var(--ink-3); font-variant-numeric: tabular-nums; }

  .la-actions {
    display: flex; align-items: center; gap: 14px; margin-top: clamp(20px, 4vh, 36px);
    animation: la-rise 520ms var(--ease-out) calc(var(--land) - 120ms) both;
  }
  .la-primary {
    height: 38px; padding: 0 20px; border: 0; border-radius: 999px;
    background: var(--ink); color: oklch(0.18 0.006 285);
    font: 500 14px/1 "Geist", -apple-system, BlinkMacSystemFont, sans-serif; cursor: pointer;
    transition: background-color 160ms ease-out, transform 120ms ease-out;
  }
  .la-primary:hover { background: oklch(0.9 0.004 75); }
  .la-primary:active { transform: scale(0.97); }
  .la-later {
    height: 38px; padding: 0 12px; border: 0; border-radius: 999px; background: none;
    color: var(--ink-2); font: 400 14px/1 "Geist", -apple-system, BlinkMacSystemFont, sans-serif; cursor: pointer;
    transition: color 160ms ease-out;
  }
  .la-later:hover { color: var(--ink); }
  .la-close:focus-visible, .la-primary:focus-visible, .la-later:focus-visible { outline: 2px solid oklch(0.97 0.004 75 / 0.7); outline-offset: 3px; }

  .la-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; padding: 0; }

  @keyframes la-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes la-fade-out { from { opacity: 1; } to { opacity: 0; } }
  @keyframes la-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
  /* Dealt from below the window, straight, then fanned into place. */
  @keyframes la-deal {
    from { opacity: 0; transform: translate(0, 60vh) rotate(0deg) scale(0.92); }
    18% { opacity: 1; }
    to {
      opacity: 1;
      transform:
        translate(calc(var(--card-w) * var(--x)), calc(var(--card-w) * 7 / 5 * var(--y)))
        rotate(var(--r));
    }
  }
  @keyframes la-turn { from { transform: rotateY(180deg); } to { transform: rotateY(0deg); } }
  /* WebKit paints a composited face through backface-visibility (the foil
     canvas), so each side also hides as the card passes edge-on: with this
     easing the turn reaches 90 degrees at about 37% of its time. */
  @keyframes la-show { 0%, 36.9% { visibility: hidden; } 37%, 100% { visibility: visible; } }
  @keyframes la-hide { 0%, 36.9% { visibility: visible; } 37%, 100% { visibility: hidden; } }
  @keyframes la-light { from { opacity: 0; transform: scale(0.72); } to { opacity: 0.4; transform: none; } }

  @media (prefers-reduced-motion: reduce) {
    .la-layer, .la-layer *, .la-layer :global(*) { animation: none !important; transition: none !important; }
    .la-back { visibility: hidden; }
    .face-down .la-back { visibility: visible; }
  }
  .reduced, .reduced * { animation: none !important; }
  .reduced .la-back { visibility: hidden; }
  .reduced .face-down .la-back { visibility: visible; }
</style>
