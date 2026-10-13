<script lang="ts">
  /**
   * The marks at the start of a "You earned" notice: each badge's icon in a
   * ring of its tier's colour, the mark the profile pictures carry
   * (TierMark.svelte, badge-glyph.ts). One badge shows one mark; several
   * overlap in a short row, up to `max`, then "+N".
   */
  import type { ResolvedBadge } from "./badge-catalog.js";
  import { BADGE_GLYPH_SCALE, BADGE_RING_URL, badgeGlyphUrl } from "./badge-glyph.js";

  interface Props {
    badges: readonly ResolvedBadge[];
    /** Marks shown before the rest fold into "+N". */
    max?: number;
    /** One mark's size in px. */
    size?: number;
  }

  let { badges, max = 4, size = 30 }: Props = $props();

  const shown = $derived(badges.slice(0, max));
  const more = $derived(Math.max(0, badges.length - max));
</script>

<span
  class="bnm"
  class:row={badges.length > 1}
  style:--bnm="{size}px"
  style:--ring={BADGE_RING_URL}
  style:--ic={BADGE_GLYPH_SCALE}
  data-testid="badge-notice-marks"
  aria-hidden="true"
>
  {#each shown as badge (badge.def.id)}
    <span class="m t{badge.tier}" data-testid="badge-notice-mark" data-badge-id={badge.def.id} style:--glyph={badgeGlyphUrl(badge.def.icon)}>
      <span class="g"></span>
    </span>
  {/each}
  {#if more > 0}<span class="more" data-testid="badge-notice-more">+{more}</span>{/if}
</span>

<style>
  /* Tier colours as on the profile pictures' marks (TierMark.svelte). */
  .bnm {
    --bronze: #b0683a; --silver: #8a91a6; --gold: #c99312;
    --legendary: linear-gradient(135deg, #3b22d0 0%, #9a4ad6 40%, #ec6f86 75%, #fca58a 100%);
    display: inline-flex; align-items: center;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .bnm { --bronze: #c7804f; --silver: #aab0c6; --gold: #e3ad2c; }
  }
  :global(:root[data-force-theme="dark"]) .bnm { --bronze: #c7804f; --silver: #aab0c6; --gold: #e3ad2c; }

  .m {
    position: relative; display: grid; place-items: center; flex: none;
    width: var(--bnm); height: var(--bnm); border-radius: 50%;
    /* The notice's own surface behind each mark, so overlapping marks read as separate coins. */
    background: var(--overlay-bg, var(--v4-surface-solid, #fff));
  }
  .row .m + .m { margin-left: calc(var(--bnm) * -0.28); }
  .m::before {
    content: ""; position: absolute; inset: 0;
    background: var(--tc);
    -webkit-mask: var(--ring) center / 100% 100% no-repeat;
    mask: var(--ring) center / 100% 100% no-repeat;
  }
  .g {
    width: calc(var(--bnm) * var(--ic)); height: calc(var(--bnm) * var(--ic));
    background: var(--tc);
    -webkit-mask: var(--glyph) center / contain no-repeat;
    mask: var(--glyph) center / contain no-repeat;
  }
  .t1 { --tc: var(--bronze); }
  .t2 { --tc: var(--silver); }
  .t3 { --tc: var(--gold); }
  .tL { --tc: var(--legendary); }
  .more {
    margin-left: 6px;
    font: 500 11px/1 var(--font-mono, "Geist Mono", monospace);
    color: var(--v4-text-2);
    font-variant-numeric: tabular-nums;
  }
</style>
