/**
 * Wallpaper art for the #setup welcome hero.
 *
 * Both pieces come from the Indigo brand wallpaper library (the Midjourney
 * "HQ" set at companies/indigo/data/assets/brand/wallpapers), downscaled to
 * 1600px and re-encoded as WebP so each stays well under 400 KB. They are
 * bundled — the packaged CSP (`img-src 'self' data: asset: blob:`) blocks
 * remote images, so a hosted URL would render as a blank panel.
 *
 * `dark` (aurora: starry indigo sky, coral moon) is the default; `light`
 * (chrome monoliths on a mirror sea) is a touch brighter so the panel does not
 * read as a black hole on a light shell. Both sit behind white text under the
 * component's scrim, which is why the swap is purely aesthetic.
 */

// Vite resolves each import to a hashed asset URL string at build time.
import auroraUrl from "./assets/setup-welcome/hero-aurora.webp";
import monolithsUrl from "./assets/setup-welcome/hero-monoliths.webp";

export const SETUP_HERO_ART = {
  dark: auroraUrl,
  light: monolithsUrl,
} as const;

export type SetupHeroArtTheme = keyof typeof SETUP_HERO_ART;
