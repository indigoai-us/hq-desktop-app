<script lang="ts">
  /** One badge's small ASCII mark (54px micro or 108px small). */
  import { BADGE_FONT, badgeMarkPx, drawBadgeMark, type BadgeMarkSize } from "./badge-mark.js";
  import type { BadgeDef, BadgeTier } from "./badge-catalog.js";
  import { badgeTheme, watchBadgeTheme } from "./badge-theme.js";

  interface Props {
    badge: BadgeDef;
    tier?: BadgeTier;
    size?: BadgeMarkSize;
    locked?: boolean;
    label?: string;
  }

  let { badge, tier, size = "micro", locked = false, label }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);
  const px = $derived(badgeMarkPx(size));
  let theme = $state(badgeTheme());

  $effect(() => watchBadgeTheme((next) => (theme = next)));

  $effect(() => {
    const cv = canvas;
    if (!cv) return;
    const opts = { size, tier, locked, theme };
    const def = badge;
    let alive = true;
    const draw = () => {
      if (alive) drawBadgeMark(cv, def, opts);
    };
    draw();
    // Redraw once the mono face is ready; the first frame may use the fallback.
    document.fonts?.load(`700 10px ${BADGE_FONT}`).then(draw, () => {});
    return () => {
      alive = false;
    };
  });
</script>

<span class="mark" role="img" aria-label={label ?? badge.name}>
  <canvas
    bind:this={canvas}
    width={px}
    height={px}
    style:width="{px}px"
    style:height="{px}px"
    aria-hidden="true"
    data-badge={badge.id}
  ></canvas>
</span>

<style>
  .mark { display: block; flex: none; line-height: 0; }
  canvas { display: block; }
</style>
