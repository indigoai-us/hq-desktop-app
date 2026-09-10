<script lang="ts">
  import Buildings from "phosphor-svelte/lib/Buildings";
  /**
   * A company's identity mark: its website favicon when hq-pro has resolved
   * one, otherwise a building glyph.
   *
   * Why a building rather than the generic `#`: a company channel is not the
   * same kind of thing as a project or personal channel, and `#` said nothing
   * about which company you were looking at. The favicon is the strongest
   * available signal; the building is the honest placeholder until a website is
   * set (setting one is optional, so the glyph is a permanent first-class
   * state, not a loading spinner).
   *
   * `iconUrl` must be the server's presigned assets-host URL. `companyIconSrc`
   * rejects anything else — including hq-pro's durable `brand.faviconUrl` API
   * path — because the packaged CSP would refuse to paint it, and we do not
   * widen `img-src` for this.
   */
  import { companyIconSrc } from "../avatars/csp-image-src.js";

  interface Props {
    /** Presigned company icon from the server, if any. */
    iconUrl?: string | null;
    /** Rendered edge in px. 16 in the rail, 20-24 in headers/switcher/cmd-K. */
    size?: number;
    /** Company name — used for the image alt only when not decorative. */
    label?: string | null;
    /**
     * True when an adjacent text label already names the company, so the mark
     * is decorative and must be hidden from assistive tech.
     */
    decorative?: boolean;
  }

  let {
    iconUrl = null,
    size = 16,
    label = null,
    decorative = true,
  }: Props = $props();

  const safeSrc = $derived(companyIconSrc(iconUrl));

  // A resolved icon can still 404 (object expired/removed) or fail to decode.
  // Swap back to the building rather than leaving a broken image. Keyed on the
  // url so a NEW icon gets a fresh chance instead of inheriting the failure.
  let brokenSrc = $state<string | null>(null);
  const showImage = $derived(Boolean(safeSrc) && brokenSrc !== safeSrc);

  const alt = $derived(decorative ? "" : (label?.trim() || "Company"));

  /**
   * The glyph draws smaller than its box. A favicon is a filled plate that
   * fills the 16px square edge to edge; line art at the same nominal size has
   * ink reaching every corner, so it out-weighed the 16px avatar circle beside
   * it in the rail. The concept sets its own rail hash to 13 in a 16px box —
   * same 0.8 ratio.
   */
  const glyphSize = $derived(Math.round(size * 0.8));
</script>

<span
  class="company-icon"
  style={`--company-icon-size:${size}px`}
  data-testid="company-icon"
  data-company-icon={showImage ? "image" : "glyph"}
  aria-hidden={decorative ? "true" : undefined}
>
  {#if showImage}
    <img
      class="company-icon-img"
      src={safeSrc}
      {alt}
      loading="lazy"
      decoding="async"
      onerror={() => (brokenSrc = safeSrc)}
    />
  {:else}
    <!-- Matches the house stroke dialect: 16-unit viewBox, 1.5px stroke,
         currentColor, round joins. Same office mark as the Settings
         "companies" nav icon so the two never disagree. -->
    <Buildings
      class="company-icon-glyph"
      size={glyphSize}
      role={decorative ? "presentation" : "img"}
      aria-label={decorative ? undefined : label}
    />
  {/if}
</span>

<style>
  .company-icon {
    display: inline-grid;
    place-items: center;
    width: var(--company-icon-size, 16px);
    height: var(--company-icon-size, 16px);
    flex: 0 0 var(--company-icon-size, 16px);
    color: var(--t3, var(--muted-2, currentColor));
    line-height: 0;
  }
  .company-icon-img {
    display: block;
    width: 100%;
    height: 100%;
    /* 4px rounding, softened at small sizes so a 16px mark does not read as
       a circle. */
    border-radius: 4px;
    object-fit: cover;
    /* A favicon on a white plate next to dark chrome needs no extra frame,
       but a hairline keeps a transparent PNG from floating. */
    box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent);
  }
</style>
