<script lang="ts">
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
    <svg
      class="company-icon-glyph"
      viewBox="0 0 16 16"
      fill="none"
      role={decorative ? "presentation" : "img"}
      aria-label={decorative ? undefined : alt}
    >
      <path
        d="M2.5 13.5V6.5L8 3l5.5 3.5v7H2.5Z"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <path
        d="M6.5 13.5v-4h3v4"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
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
  .company-icon-glyph {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
