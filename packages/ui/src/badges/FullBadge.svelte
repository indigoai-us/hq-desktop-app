<script lang="ts">
  /**
   * The full-size, detailed ASCII Color badge. The art data loads on first use;
   * until then (or if a tier has no exported art) the small mark stands in.
   */
  import BadgeMark from "./BadgeMark.svelte";
  import { BADGE_FONT } from "./badge-mark.js";
  import { drawFullBadge, fullBadgePx } from "./full-badge.js";
  import type { BadgeDef, BadgeTier } from "./badge-catalog.js";
  import type { AsciiArt } from "./full-ascii-data.js";
  import { badgeTheme, watchBadgeTheme } from "./badge-theme.js";

  interface Props {
    badge: BadgeDef;
    tier: BadgeTier;
    label: string;
  }

  let { badge, tier, label }: Props = $props();
  let theme = $state(badgeTheme());
  let art = $state<AsciiArt | null | undefined>(undefined);
  let canvas = $state<HTMLCanvasElement | null>(null);
  /** Large enough to read the characters: 270px in the 340px pane. */
  const SCALE = 5;
  const px = fullBadgePx(SCALE);

  $effect(() => watchBadgeTheme((next) => (theme = next)));

  $effect(() => {
    const key = `${badge.id}:${tier}`;
    const fallback = `${badge.id}:${badge.tier}`;
    const light = theme === "light";
    let alive = true;
    // Light mode keeps the same character grid and swaps in the light colours.
    void Promise.all([
      import("./full-ascii-data.js"),
      light ? import("./full-ascii-data-light.js") : Promise.resolve(null),
    ]).then(
      ([{ FULL_ASCII }, lightData]) => {
        if (!alive) return;
        const id = FULL_ASCII[key] ? key : fallback;
        const base = FULL_ASCII[id];
        const colors = lightData?.FULL_ASCII_LIGHT[id];
        art = base ? (colors ? { ...base, ...colors } : base) : null;
      },
      () => {
        if (alive) art = null;
      },
    );
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    const cv = canvas;
    const a = art;
    if (!cv || !a) return;
    let alive = true;
    const draw = () => {
      if (alive) drawFullBadge(cv, a, { scale: SCALE, theme });
    };
    draw();
    document.fonts?.load(`${theme === "light" ? 700 : 500} 10px ${BADGE_FONT}`).then(draw, () => {});
    return () => {
      alive = false;
    };
  });
</script>

{#if art === null}
  <BadgeMark {badge} {tier} size="small" {label} />
{:else}
  <span class="full" role="img" aria-label={label} style:width="{px}px" style:height="{px}px">
    {#if art}<canvas bind:this={canvas} width={px} height={px} aria-hidden="true" data-full-badge={badge.id}></canvas>{/if}
  </span>
{/if}

<style>
  .full { display: block; flex: none; line-height: 0; }
  canvas { display: block; }
</style>
