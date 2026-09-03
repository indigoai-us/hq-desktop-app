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
  const label = $derived(
    wallpaper === "easel"
      ? "Artist's easel"
      : wallpaper === "monoliths"
        ? "Chrome monoliths"
        : "Aurora",
  );
</script>

<div class="company-hero" data-testid="company-hero" data-wallpaper={wallpaper ?? "aurora"}>
  <img class="company-hero-art" src={src} alt="" />
  <div class="company-hero-scrim" aria-hidden="true"></div>
  <div class="company-hero-copy">
    <div class="company-hero-k">{label}</div>
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

  .company-hero-copy {
    position: relative;
    z-index: 1;
    padding: 28px 20px 18px;
  }

  .company-hero-k {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.72);
  }

  .company-hero-title {
    margin: 6px 0 0;
    font-size: 24px;
    font-weight: 500;
    color: #fff;
  }
</style>
