<script lang="ts">
  /**
   * The tier mark at the bottom right of a profile picture (owner pick
   * 2026-10-12, option B "icon in a ring"): the top badge's Phosphor icon in
   * the tier's colour inside a ring of the same stroke weight, the HQ
   * gradient for Legendary. Without a badge it falls back to a spark. It
   * shows only on pictures of 32px and up, the size of a chat message's. It
   * sits on the picture's edge, cut out from the surface behind it
   * (`--tier-cutout`, set by the host to its own background).
   *
   * With `badge`, a short hover opens a one-line card: the same mark at the
   * same size, the badge's name and its level. The card is moved to <body>
   * so a scrolling list or a popover never clips it.
   *
   * Place it inside a `position: relative` picture box.
   */
  import type { BadgeTier, ResolvedBadge } from "./badge-catalog.js";
  import { TIER_NAME } from "./badge-catalog.js";
  import { BADGE_GLYPH_SCALE, BADGE_RING_URL, badgeGlyphUrl } from "./badge-glyph.js";
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
    /** Open the hover card for `badge`. Off where the host has its own card (your side-nav picture). */
    card?: boolean;
  }

  let { tier, avatar, badge = null, anySize = false, card: withCard = true }: Props = $props();
  const px = $derived(tierMarkPx(avatar));
  const tierKey = $derived(tier === "L" ? "L" : String(tier));
  /** A four-point spark, for a mark that has no badge to show. */
  const SPARK = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 1.5c.5 5.6 4.9 10 10.5 10.5-5.6.5-10 4.9-10.5 10.5C11.5 16.9 7.1 12.5 1.5 12 7.1 11.5 11.5 7.1 12 1.5Z"/></svg>')}")`;
  const glyph = $derived(badge ? badgeGlyphUrl(badge.def.icon) : SPARK);
  const hasCard = $derived(Boolean(badge) && withCard);

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
    if (!hasCard) return;
    clear();
    timer = setTimeout(show, DELAY);
  }

  function show(): void {
    timer = null;
    if (!mark) return;
    const r = mark.getBoundingClientRect();
    // Below the mark, or above it near the bottom of the window.
    const above = r.bottom + GAP + 32 > window.innerHeight;
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

{#snippet ring(testid: string)}<span class="tm-glyph" data-testid={testid} data-icon={badge?.def.icon ?? "spark"}></span>{/snippet}
{#if anySize || avatar >= TIER_MARK_MIN_AVATAR}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="tm on-picture t{tierKey}"
  class:has-card={hasCard}
  style:--tm="{px}px"
  style:--glyph={glyph}
  style:--ring={BADGE_RING_URL}
  style:--ic={BADGE_GLYPH_SCALE}
  aria-hidden="true"
  data-testid="tier-mark"
  data-tier={tierKey}
  bind:this={mark}
  onpointerenter={enter}
  onpointerleave={hide}
  onpointerdown={hide}
>{@render ring("tier-mark-glyph")}</span>
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
    <span class="tm tmc-mark t{tierKey}" style:--tm="{px}px" style:--glyph={glyph} style:--ring={BADGE_RING_URL} style:--ic={BADGE_GLYPH_SCALE} aria-hidden="true">{@render ring("tier-mark-card-glyph")}</span>
    <span class="tmc-copy">
      <span class="tmc-name">{badge.def.name}</span>
      <span class="tmc-sub">{TIER_NAME[tierKey]}</span>
    </span>
  </div>
{/if}

<style>
  /* Flat tier colours: the badge rings in dark, deepened in light to hold
     contrast on white, the same metals as the drawn badge marks
     (TIER_RING_LIGHT, owner pick 2026-10-15). The app is light unless the
     system or a forced theme says dark (home/tokens.css). */
  .tm, .tmc {
    --bronze: #8a4522; --silver: #4f566b; --gold: #8f6400;
    --legendary: linear-gradient(135deg, #3b22d0 0%, #9a4ad6 40%, #ec6f86 75%, #fca58a 100%);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .tm,
    :global(:root:not([data-force-theme="light"])) .tmc { --bronze: #c7804f; --silver: #aab0c6; --gold: #e3ad2c; }
  }
  :global(:root[data-force-theme="dark"]) .tm,
  :global(:root[data-force-theme="dark"]) .tmc { --bronze: #c7804f; --silver: #aab0c6; --gold: #e3ad2c; }

  /* The ring and the icon share one stroke weight (owner review
     2026-10-12): both are vector masks over the tier colour (badge-glyph.ts),
     so Legendary's gradient fills them too and a sub-pixel ring stays even. */
  .tm {
    position: relative; display: grid; place-items: center; flex: 0 0 auto;
    box-sizing: border-box; width: var(--tm); height: var(--tm); border-radius: 50%;
  }
  .tm::before {
    content: ""; position: absolute; inset: 0;
    background: var(--tc);
    -webkit-mask: var(--ring) center / 100% 100% no-repeat;
    mask: var(--ring) center / 100% 100% no-repeat;
  }
  .tm-glyph {
    width: calc(var(--tm) * var(--ic)); height: calc(var(--tm) * var(--ic));
    background: var(--tc);
    -webkit-mask: var(--glyph) center / contain no-repeat;
    mask: var(--glyph) center / contain no-repeat;
  }
  .t1 { --tc: var(--bronze); }
  .t2 { --tc: var(--silver); }
  .t3 { --tc: var(--gold); }
  .tL { --tc: var(--legendary); }

  /* On the picture: on its edge, filled with and cut out from the surface behind. */
  .tm.on-picture {
    position: absolute; right: calc(var(--tm) * -0.12); bottom: calc(var(--tm) * -0.12); z-index: 1;
    background: var(--tier-cutout, var(--v4-ground, #fff));
    box-shadow: 0 0 0 max(1.5px, calc(var(--tm) * 0.12)) var(--tier-cutout, var(--v4-ground, #fff));
    pointer-events: none;
  }
  /* Only a mark with a card takes the pointer. */
  .tm.on-picture.has-card { pointer-events: auto; }

  /* The app's hover-card style (ProfileBadges .hc): solid, bordered. One
     compact line: the mark at the picture's size, the name, the level
     (owner pick 2026-10-12). */
  .tmc {
    position: fixed; z-index: 10002; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px;
    box-sizing: border-box; max-width: 280px; padding: 6px 10px 6px 7px;
    border: 1px solid var(--panel-border, var(--line2)); border-radius: 7px;
    background: var(--overlay-bg, var(--v4-popover, var(--v4-surface-solid)));
    box-shadow: var(--panel-shadow, 0 4px 12px rgba(0, 0, 0, 0.22));
    color: var(--v4-text-1); font: 400 12px/1.35 var(--font-ui, var(--font-sans));
    text-align: left; pointer-events: none;
    animation: tmc-in 120ms ease-out;
  }
  .tmc.above { transform: translate(-50%, -100%); }
  .tmc-copy { display: flex; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; }
  .tmc-name { font-weight: 500; color: var(--v4-text-1); overflow: hidden; text-overflow: ellipsis; }
  .tmc-sub { color: var(--v4-text-3); }
  @keyframes tmc-in { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .tmc { animation: none; } }
</style>
