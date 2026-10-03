<script lang="ts">
  /**
   * The logo box of an integration card and of the modal it opens.
   *
   * The two-letter badge is drawn first. An image then tries the sources the
   * app built from the domain (integration-cards-model.ts, `appLogoSources`),
   * in order, falling through on error, and takes the badge's place only once
   * it has loaded. The box is one fixed size, so nothing moves either way,
   * and nothing waits on the network: a card is complete with its badge.
   *
   * The image is decorative; the name next to it says what it is. Every
   * source is the app's own URL, never one the bot supplied.
   */
  import { untrack } from "svelte";
  import type { ConnectionCardLogo } from "./connection-card-model.js";

  interface Props {
    logo: ConnectionCardLogo;
    /** The box, in px. The image inside is 8px smaller. */
    size?: number;
  }

  let { logo, size = 28 }: Props = $props();

  let index = $state(0);
  let loaded = $state(false);

  // A new logo (the card changed app) starts the chain again.
  $effect(() => {
    void logo.sources;
    untrack(() => {
      index = 0;
      loaded = false;
    });
  });

  const src = $derived(logo.sources[index] ?? null);
  const inner = $derived(Math.max(8, size - 8));

  function failed(): void {
    loaded = false;
    index += 1;
  }
</script>

<span
  class="connection-card-logo"
  data-testid="connection-card-logo"
  data-loaded={loaded ? "true" : "false"}
  aria-hidden="true"
  style:width={`${size}px`}
  style:height={`${size}px`}
>
  <span class="connection-card-logo-badge" data-testid="connection-card-logo-badge">{logo.monogram}</span>
  {#if src}
    <img
      class="connection-card-logo-img"
      data-testid="connection-card-logo-img"
      {src}
      alt=""
      loading="lazy"
      decoding="async"
      width={inner}
      height={inner}
      referrerpolicy="no-referrer"
      onload={() => (loaded = true)}
      onerror={failed}
    />
  {/if}
</span>

<style>
  /* A dark box on the glass, like the console's logo box. Fixed size: the
     badge and the image share the same spot and swap with no layout shift. */
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
    overflow: hidden;
  }
  .connection-card-logo-badge {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: rgba(250, 250, 250, 0.82);
    line-height: 1;
    user-select: none;
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
  .connection-card-logo[data-loaded="true"] .connection-card-logo-badge {
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
