<script lang="ts">
  /**
   * The logo box of an integration card and of the modal it opens.
   *
   * Three things can be in the box, in this order of preference:
   *
   * 1. The app's bundled brand mark (app-brand-marks.ts), drawn at once as an
   *    inline SVG in the brand's colour on a light tile (or a dark tile for a
   *    light brand colour). No network, no image policy.
   * 2. Else an image that tries the sources the app built from the domain
   *    (integration-cards-model.ts, `appLogoSources`), in order, falling
   *    through on error, and takes the box only once it has loaded.
   * 3. Else, and while an image is still loading, the generic app glyph in
   *    the muted text colour. Never a badge made from the app's name: a card
   *    with no logo says so plainly instead of showing a made-up one.
   *
   * The box is one fixed size, so nothing moves whichever it is, and nothing
   * waits on the network. The image is decorative; the name next to it says
   * what it is. Every source is the app's own URL, never one the bot supplied.
   */
  import { untrack } from "svelte";
  import { markTile } from "./app-brand-marks.js";
  import ConnectionCardIcon from "./ConnectionCardIcon.svelte";
  import type { ConnectionCardLogo } from "./connection-card-model.js";

  interface Props {
    logo: ConnectionCardLogo;
    /** The box, in px. A mark inside is 10px smaller, an image 8px smaller. */
    size?: number;
  }

  let { logo, size = 28 }: Props = $props();

  let index = $state(0);
  let loaded = $state(false);

  // A new logo (the card changed app) starts the chain again.
  $effect(() => {
    void logo.sources;
    void logo.mark;
    untrack(() => {
      index = 0;
      loaded = false;
    });
  });

  const mark = $derived(logo.mark);
  const src = $derived(mark ? null : (logo.sources[index] ?? null));
  /** What the box shows now. */
  const mode = $derived(mark ? "mark" : loaded ? "image" : "generic");
  /** The tile behind it: a brand mark picks by its colour; an image sits on white; the glyph on the glass. */
  const tile = $derived(mark ? markTile(mark.hex) : loaded ? "light" : "glass");
  const markSize = $derived(Math.max(10, size - 10));
  const imageSize = $derived(Math.max(8, size - 8));
  const glyphSize = $derived(Math.max(10, Math.round(size * 0.64)));

  function failed(): void {
    loaded = false;
    index += 1;
  }
</script>

<span
  class="connection-card-logo"
  data-testid="connection-card-logo"
  data-logo={mode}
  data-tile={tile}
  data-loaded={loaded ? "true" : "false"}
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
    <!-- The glyph stays in the box under the image, hidden once it has loaded, so nothing moves. -->
    <span class="connection-card-logo-generic" data-testid="connection-card-logo-generic">
      <ConnectionCardIcon name="integration" size={glyphSize} />
    </span>
    {#if src}
      <img
        class="connection-card-logo-img"
        data-testid="connection-card-logo-img"
        {src}
        alt=""
        loading="lazy"
        decoding="async"
        width={imageSize}
        height={imageSize}
        referrerpolicy="no-referrer"
        onload={() => (loaded = true)}
        onerror={failed}
      />
    {/if}
  {/if}
</span>

<style>
  /* One fixed box on the glass. The tile behind the logo depends on what is
     in it; the size never does, so a mark, an image and the glyph all swap
     with no layout shift. */
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
  /* A light tile: a brand mark in a dark colour, or a favicon, reads on white
     wherever the glass is. */
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
  .connection-card-logo-img {
    position: absolute;
    inset: 0;
    margin: auto;
    display: block;
    object-fit: contain;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .connection-card-logo[data-loaded="true"] .connection-card-logo-generic {
    visibility: hidden;
  }
  .connection-card-logo[data-loaded="true"] .connection-card-logo-img {
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .connection-card-logo-img {
      transition: none;
    }
  }
</style>
