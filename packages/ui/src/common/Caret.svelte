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
   * The fix is geometry instead of typography: the ink is centred inside the
   * `0 0 10 10` viewBox — it spans y 3.75→6.25, so its centre is exactly 5.
   * That 0.25-unit detail matters. An earlier attempt drew the arms at y 4 and
   * the apex at 6.5, whose centre is 5.25, and it still read a hair low; a
   * later attempt overcorrected upward for the label's optical centre and read
   * high. Measured against the real 12px pill in a browser, the caret's ink
   * centre wants to land on the label's ink centre, and plain box-centring
   * does exactly that (residual < 0.1px). Keep the ink symmetric about 5.
   *
   * `display: block` takes the SVG off the text baseline; inline SVGs sit on
   * it by default, which would reintroduce the original low hang.
   */
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

<svg
  class="caret"
  class:closed={!open}
  viewBox="0 0 10 10"
  fill="none"
  aria-hidden="true"
  data-testid="caret"
  style="color: {tone}; --caret-size: {size};"
>
  <path
    d="M2.5 3.75 5 6.25 7.5 3.75"
    stroke="currentColor"
    stroke-width="1.3"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>

<style>
  .caret {
    flex: 0 0 auto;
    /* Off the text baseline — see the component comment. */
    display: block;
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
