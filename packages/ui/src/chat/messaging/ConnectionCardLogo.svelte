<script lang="ts">
  /**
   * The logo box of an integration card and of the modal it opens.
   *
   * Two things can be in the box:
   *
   * 1. The app's bundled brand mark (app-brand-marks.ts), drawn at once as an
   *    inline SVG in the brand's colour on a light tile (or a dark tile for a
   *    light brand colour). No network, no image policy.
   * 2. Else the generic app glyph in the muted text colour. Never a badge
   *    made from the app's name: a card with no logo says so plainly instead
   *    of showing a made-up one.
   *
   * There is no `<img>` here. The app's image policy allows one remote
   * origin (the marketplace assets host), and a logo fetched by domain would
   * let a domain a bot writes make the webview call a third party with no
   * click. The box is one fixed size, so nothing moves whichever it is. The
   * logo is decorative; the name next to it says what it is.
   */
  import { markTile } from "./app-brand-marks.js";
  import ConnectionCardIcon from "./ConnectionCardIcon.svelte";
  import type { ConnectionCardLogo } from "./connection-card-model.js";

  interface Props {
    logo: ConnectionCardLogo;
    /** The box, in px. A mark inside is 10px smaller. */
    size?: number;
  }

  let { logo, size = 28 }: Props = $props();

  const mark = $derived(logo.mark);
  /** What the box shows. */
  const mode = $derived(mark ? "mark" : "generic");
  /** The tile behind it: a brand mark picks by its colour; the glyph sits on the glass. */
  const tile = $derived(mark ? markTile(mark.hex) : "glass");
  const markSize = $derived(Math.max(10, size - 10));
  const glyphSize = $derived(Math.max(10, Math.round(size * 0.64)));
</script>

<span
  class="connection-card-logo"
  data-testid="connection-card-logo"
  data-logo={mode}
  data-tile={tile}
  aria-hidden="true"
  style:width={`${size}px`}
  style:height={`${size}px`}
>
  {#if mark}
    <svg
      class="connection-card-logo-mark"
      data-testid="connection-card-logo-mark"
      viewBox="0 0 24 24"
      width={markSize}
      height={markSize}
      fill={`#${mark.hex}`}
      aria-hidden="true"
    >
      <path d={mark.path} />
    </svg>
  {:else}
    <span class="connection-card-logo-generic" data-testid="connection-card-logo-generic">
      <ConnectionCardIcon name="integration" size={glyphSize} />
    </span>
  {/if}
</span>

<style>
  /* One fixed box on the glass. The tile behind the logo depends on what is
     in it; the size never does, so a mark and the glyph swap with no layout
     shift. */
  .connection-card-logo {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    overflow: hidden;
  }
  /* A light tile: a brand mark in a dark colour reads on white wherever the
     glass is. */
  .connection-card-logo[data-tile="light"] {
    border-color: rgba(255, 255, 255, 0.3);
    background: #fff;
  }
  /* A solid dark tile for a brand mark in a light colour. */
  .connection-card-logo[data-tile="dark"] {
    border-color: rgba(255, 255, 255, 0.16);
    background: #16161a;
  }
  .connection-card-logo-mark {
    display: block;
  }
  .connection-card-logo-generic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
</style>
