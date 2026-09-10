<script lang="ts">
  /**
   * The one dropdown/disclosure caret in the app.
   *
   * WHY this exists: every caret used to be the text character U+2304 DOWN
   * ARROWHEAD (`⌄`) in a `<span>`. That glyph draws its ink low inside its em
   * box, so a flex row's `align-items: center` centred the glyph's LINE BOX
   * while the visible arrow hung below the label's optical centre. No flex
   * tweak can fix that — the offset lives inside the glyph — and a negative
   * margin would only have papered over it at one font size. Six controls had
   * independently inherited the same defect.
   *
   * The fix was a hand-drawn SVG whose ink was centred inside a 0 0 10 10
   * viewBox. That is now Phosphor's CaretDown, on the designer's call and
   * matching the V2 concept, which draws its carets the same way:
   * `<CaretDown size={10} weight="bold" />` inside an inline-flex box that
   * centres it. Phosphor's ink sits a hair below its own box centre — about
   * 3% of the box, so under half a pixel at these sizes — and the centring
   * wrapper below absorbs it. The failure mode being avoided is the text
   * glyph, not the icon set.
   */
  import CaretDown from "phosphor-svelte/lib/CaretDown";

  interface Props {
    /**
     * Disclosure state. `false` rotates the caret to point right, for
     * collapsed sections. Menus that do not flip on open leave this alone.
     */
    open?: boolean;
    /**
     * Colour, as a semantic token reference (e.g. `var(--t3)`). Hosts differ:
     * chat surfaces use `--t3`, v4 surfaces use `--v4-text-3`. Defaults to
     * inheriting the parent's colour.
     */
    tone?: string;
    /** Edge length. Keep it in `em` so it tracks the label's font scale. */
    size?: string;
  }

  let { open = true, tone = "currentColor", size = "0.85em" }: Props =
    $props();
</script>

<span
  class="caret"
  class:closed={!open}
  aria-hidden="true"
  data-testid="caret"
  style="color: {tone}; --caret-size: {size};"
>
  <CaretDown size="var(--caret-size, 0.85em)" weight="bold" />
</span>

<style>
  .caret {
    flex: 0 0 auto;
    /* Off the text baseline, and centring the icon box within it — see the
       component comment. */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--caret-size, 0.85em);
    height: var(--caret-size, 0.85em);
    transition: transform 120ms ease;
  }

  /* Collapsed disclosure: point right. */
  .caret.closed {
    transform: rotate(-90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .caret {
      transition: none;
    }
  }
</style>
