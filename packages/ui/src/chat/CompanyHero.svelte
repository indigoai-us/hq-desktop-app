<script lang="ts">
  /**
   * Company channel wallpaper hero (US-017 / US-008). Bundled brand
   * wallpapers only — the desktop CSP blocks remote images.
   */
  import { SETUP_HERO_ART } from "./setup-welcome-art.js";

  interface Props {
    title: string;
    wallpaper?: string | null;
  }

  let { title, wallpaper = "aurora" }: Props = $props();

  const src = $derived(
    wallpaper === "monoliths" || wallpaper === "easel"
      ? SETUP_HERO_ART.light
      : SETUP_HERO_ART.dark,
  );

</script>

<div class="company-hero" data-testid="company-hero" data-wallpaper={wallpaper ?? "aurora"}>
  <img class="company-hero-art" src={src} alt="" />
  <div class="company-hero-scrim" aria-hidden="true"></div>
  <div class="company-hero-copy">
    <!-- The eyebrow names what the card IS. It used to name the wallpaper art
         behind it ("Aurora", "Chrome monoliths"), which labelled the picture
         rather than the company under it. -->
    <div class="company-hero-k">Company</div>
    <h2 class="company-hero-title">{title}</h2>
  </div>
</div>

<style>
  .company-hero {
    position: relative;
    min-height: 140px;
    margin: 0 0 12px;
    overflow: hidden;
    border-radius: 10px;
  }

  .company-hero-art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .company-hero-scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      180deg,
      rgb(0 0 0 / 0.15) 0%,
      rgb(0 0 0 / 0.55) 100%
    );
  }

  /* Same block as the welcome channel's hero (`.hero-copy`): the copy sits on
     the FLOOR of the art, not floating near its top edge, on the same 24/20/20
     padding and 8px gap. */
  .company-hero-copy {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: var(--space-2, 8px);
    min-height: 140px;
    padding: var(--space-6, 24px) var(--space-5, 20px) var(--space-5, 20px);
  }

  /* `.eyebrow` */
  .company-hero-k {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.62);
  }

  /* `.hero-title` */
  .company-hero-title {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.012em;
    color: #fff;
  }
</style>
