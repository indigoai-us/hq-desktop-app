<script lang="ts">
  /**
   * The tier mark at the bottom right of a profile picture (owner pick
   * 2026-10-09, option B): a flat dot in the tier's colour with a small
   * white spark, the HQ gradient for Legendary. It shows only on pictures
   * of 32px and up, the size of a chat message's. It sits on the picture's
   * edge, cut out from the surface behind it (`--tier-cutout`, set by the
   * host to its own background).
   *
   * With `badge`, a short hover opens a card with that badge's micro mark,
   * its name and its level. The card is moved to <body> so a scrolling list or a
   * popover never clips it.
   *
   * Place it inside a `position: relative` picture box.
   */
  import type { BadgeTier, ResolvedBadge } from "./badge-catalog.js";
  import { TIER_NAME } from "./badge-catalog.js";
  import BadgeMark from "./BadgeMark.svelte";
  import { TIER_MARK_MIN_AVATAR, tierMarkPx } from "./badge-tier.js";

  interface Props {
    tier: BadgeTier;
    /** The picture's size in px. */
    avatar: number;
    /** The badge behind the mark, for its hover card. */
    badge?: ResolvedBadge | null;
    /**
     * Show it on a picture under 32px too. Only your own picture in the
     * side nav does (owner review 2026-10-09); elsewhere small pictures
     * leave it off.
     */
    anySize?: boolean;
  }

  let { tier, avatar, badge = null, anySize = false }: Props = $props();
  const px = $derived(tierMarkPx(avatar));
  const tierKey = $derived(tier === "L" ? "L" : String(tier));

  /** The same dwell as the other badge hover cards (hover-card-delay.test.ts). */
  const DELAY = 600;
  const GAP = 6;
  /** Keep the card this far inside the window. */
  const EDGE = 8;

  let mark = $state<HTMLSpanElement | null>(null);
  let card = $state<HTMLDivElement | null>(null);
  let open = $state(false);
  let pos = $state({ x: 0, y: 0, above: false });
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function enter(): void {
    if (!badge) return;
    clear();
    timer = setTimeout(show, DELAY);
  }

  function show(): void {
    timer = null;
    if (!mark) return;
    const r = mark.getBoundingClientRect();
    // Below the mark, or above it near the bottom of the window.
    const above = r.bottom + GAP + 56 > window.innerHeight;
    pos = { x: r.left + r.width / 2, y: above ? r.top - GAP : r.bottom + GAP, above };
    open = true;
  }

  function hide(): void {
    clear();
    open = false;
  }

  // Keep it inside the window once its width is known.
  $effect(() => {
    if (!open || !card) return;
    const w = card.getBoundingClientRect().width;
    const x = Math.min(Math.max(pos.x, EDGE + w / 2), window.innerWidth - EDGE - w / 2);
    if (x !== pos.x) pos = { ...pos, x };
  });

  // A scroll moves the picture away from the card.
  $effect(() => {
    if (!open) return;
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  });

  $effect(() => () => clear());

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

{#if anySize || avatar >= TIER_MARK_MIN_AVATAR}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="tm t{tierKey}"
  class:has-card={Boolean(badge)}
  style="--tm: {px}px"
  aria-hidden="true"
  data-testid="tier-mark"
  data-tier={tierKey}
  bind:this={mark}
  onpointerenter={enter}
  onpointerleave={hide}
  onpointerdown={hide}
>
  <svg viewBox="0 0 24 24" data-testid="tier-mark-spark"><path d="M12 1.5c.5 5.6 4.9 10 10.5 10.5-5.6.5-10 4.9-10.5 10.5C11.5 16.9 7.1 12.5 1.5 12 7.1 11.5 11.5 7.1 12 1.5Z" /></svg>
</span>
{/if}<!--
  No whitespace between the mark and its card: hosts centre their initials
  on a grid, where a stray space becomes a second row and lifts them.
-->{#if open && badge}
  <div
    class="tmc"
    class:above={pos.above}
    role="tooltip"
    data-testid="tier-mark-card"
    style="left: {pos.x}px; top: {pos.y}px"
    bind:this={card}
    use:portal
  >
    <span class="tmc-mark" aria-hidden="true"><BadgeMark badge={badge.def} tier={badge.tier} size="micro" /></span>
    <span class="tmc-copy">
      <span class="tmc-name">{badge.def.name}</span>
      <span class="tmc-sub">{TIER_NAME[tierKey]} badge · highest earned</span>
    </span>
  </div>
{/if}

<style>
  /* Flat tier colours: the badge rings in dark, deepened in light to hold
     contrast on white. The app is light unless the system or a forced
     theme says dark (home/tokens.css). */
  .tm, .tmc {
    --bronze: #b0683a; --silver: #8a91a6; --gold: #c99312;
    --legendary: linear-gradient(135deg, #3b22d0 0%, #9a4ad6 40%, #ec6f86 75%, #fca58a 100%);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .tm,
    :global(:root:not([data-force-theme="light"])) .tmc { --bronze: #c7804f; --silver: #aab0c6; --gold: #e3ad2c; }
  }
  :global(:root[data-force-theme="dark"]) .tm,
  :global(:root[data-force-theme="dark"]) .tmc { --bronze: #c7804f; --silver: #aab0c6; --gold: #e3ad2c; }

  .tm {
    position: absolute; right: calc(var(--tm) * -0.12); bottom: calc(var(--tm) * -0.12); z-index: 1;
    display: grid; place-items: center;
    width: var(--tm); height: var(--tm); border-radius: 50%;
    box-shadow: 0 0 0 max(1.5px, calc(var(--tm) * 0.12)) var(--tier-cutout, var(--v4-ground, #fff));
    pointer-events: none;
  }
  /* Only a mark with a card takes the pointer. */
  .tm.has-card { pointer-events: auto; }
  .t1 { background: var(--bronze); }
  .t2 { background: var(--silver); }
  .t3 { background: var(--gold); }
  .tL { background: var(--legendary); }
  svg { width: 62%; height: 62%; fill: #fff; }

  /* The app's hover-card style (ProfileBadges .hc): solid, bordered. */
  .tmc {
    position: fixed; z-index: 10002; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px;
    box-sizing: border-box; max-width: 280px; padding: 8px 12px 8px 8px;
    border: 1px solid var(--panel-border, var(--line2)); border-radius: 7px;
    background: var(--overlay-bg, var(--v4-popover, var(--v4-surface-solid)));
    box-shadow: var(--panel-shadow, 0 4px 12px rgba(0, 0, 0, 0.22));
    color: var(--v4-text-1); font: 400 12px/1.35 var(--font-ui, var(--font-sans));
    text-align: left; pointer-events: none;
    animation: tmc-in 120ms ease-out;
  }
  .tmc.above { transform: translate(-50%, -100%); }
  .tmc-mark { flex: 0 0 auto; line-height: 0; }
  /* The micro mark drawn at 54px, shown at 36px: the height of the two
     lines beside it (owner review 2026-10-09). The canvas carries device
     pixels, so it stays sharp scaled down. */
  .tmc-mark :global(canvas) { width: 36px !important; height: 36px !important; }
  .tmc-copy { display: flex; flex-direction: column; min-width: 0; }
  .tmc-name { font-weight: 500; color: var(--v4-text-1); }
  .tmc-sub { color: var(--v4-text-3); white-space: nowrap; }
  @keyframes tmc-in { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .tmc { animation: none; } }
</style>
