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
   * The fix is geometry instead of typography, and the caret is now the
   * Phosphor Regular CaretDown from the shared icon registry (`chevron-down`),
   * so it matches every other icon in the app. Phosphor draws that caret's ink
   * across y 88→184 of its 256 box, so its ink centre is 136, not the box
   * centre 128. The viewBox is shifted down by 8 (`0 8 256 256`) so the ink
   * sits exactly on the box centre again: measured against the real 12px pill
   * in a browser, the caret's ink centre wants to land on the label's ink
   * centre, and plain box-centring does exactly that. Keep the ink symmetric
   * about the viewBox centre. The rotation for a closed disclosure turns about
   * the same centre, so the right-pointing caret stays centred too.
   *
   * `display: block` takes the SVG off the text baseline; inline SVGs sit on
   * it by default, which would reintroduce the original low hang.
   */
  import { LINE_ICONS } from "./button/rail-icons.js";

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
  viewBox="0 8 256 256"
  aria-hidden="true"
  data-testid="caret"
  data-rail-icon="chevron-down"
  style="color: {tone}; --caret-size: {size};"
>
  <!-- Phosphor Regular CaretDown, verbatim from the registry. -->
  <path d={LINE_ICONS["chevron-down"]} fill="currentColor" />
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
