<script lang="ts">
  /**
   * One badge's mark, drawn (owner pick 2026-10-15, option C "colour
   * icon"): the badge's Phosphor Duotone icon in the badge's own colours
   * (its line and tint, as in the ASCII Color art), in a solid ring as thick
   * as the icon's line in the tier's colour. A Legendary ring uses the HQ
   * gradient; its icon keeps its own colours. Locked is grey throughout.
   * 54px micro or 108px small; `px` sets any other size (the detail page's
   * large mark).
   */
  import {
    BADGE_DUOTONE,
    MARK_BOX,
    MARK_CENTRE,
    MARK_RING_GRADIENT,
    MARK_RING_R,
    MARK_RING_STROKE,
    markIconTransform,
  } from "./badge-glyph.js";
  import { MARK_TINT_OPACITY, badgeMarkPx, hqStops, markIconColors, markRingColor, type BadgeMarkSize } from "./badge-mark.js";
  import type { BadgeDef, BadgeTier } from "./badge-catalog.js";
  import { badgeTheme, watchBadgeTheme } from "./badge-theme.js";

  interface Props {
    badge: BadgeDef;
    tier?: BadgeTier;
    size?: BadgeMarkSize;
    locked?: boolean;
    label?: string;
    /** Size in px, in place of `size`. */
    px?: number;
  }

  let { badge, tier, size = "micro", locked = false, label, px: custom }: Props = $props();
  /** Gradient ids are document-wide, so each mark names its own. */
  const uid = $props.id();
  let theme = $state(badgeTheme());

  $effect(() => watchBadgeTheme((next) => (theme = next)));

  const px = $derived(custom ?? badgeMarkPx(size));
  const icon = $derived(BADGE_DUOTONE[badge.icon]);
  const flat = $derived(markRingColor(tier ?? badge.tier, locked, theme));
  const stops = $derived(flat ? [] : hqStops(theme));
  const ring = $derived(flat ?? `url(#${uid}-ring)`);
  const ink = $derived(markIconColors(badge.icon, theme, locked));
</script>

<span class="mark" role="img" aria-label={label ?? badge.name}>
  <svg width={px} height={px} viewBox="0 0 {MARK_BOX} {MARK_BOX}" aria-hidden="true" data-badge={badge.id}>
    {#if !flat}
      <defs>
        <linearGradient id="{uid}-ring" gradientUnits="userSpaceOnUse" x1={MARK_RING_GRADIENT[0]} y1={MARK_RING_GRADIENT[0]} x2={MARK_RING_GRADIENT[1]} y2={MARK_RING_GRADIENT[1]}>
          {#each stops as color, i (i)}<stop offset={i / (stops.length - 1)} stop-color={color} />{/each}
        </linearGradient>
      </defs>
    {/if}
    <circle class="ring" cx={MARK_CENTRE} cy={MARK_CENTRE} r={MARK_RING_R} fill="none" stroke={ring} stroke-width={MARK_RING_STROKE} />
    {#if icon}
      <g class="icon" transform={markIconTransform(badge.icon)}>
        <path class="tint" d={icon.tint} fill={ink.tint} opacity={MARK_TINT_OPACITY[theme]} />
        <path class="line" d={icon.line} fill={ink.line} />
      </g>
    {/if}
  </svg>
</span>

<style>
  .mark { display: block; flex: none; line-height: 0; }
  svg { display: block; }
</style>
