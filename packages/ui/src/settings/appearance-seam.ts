/**
 * Appearance + interface-zoom seams for the Settings page.
 *
 * The desktop `lib/appearancePreferences.ts` / `lib/desktopZoom.ts` modules
 * drive native window vibrancy, per-window zoom, and native-theme sync — all
 * host chrome. packages/ui keeps only the pure value contracts and lets the
 * host inject read/request/subscribe implementations. When no seam is
 * provided (web today), the Appearance section renders the standard
 * unavailable state instead of dead controls.
 */

export const MIN_DESKTOP_ZOOM = 0.8;
export const MAX_DESKTOP_ZOOM = 1.6;

export type ColorTheme = "system" | "light" | "dark";

export interface AppearancePreferences {
  colorTheme: ColorTheme;
}

export function normalizeColorTheme(value: unknown): ColorTheme {
  return value === "light" || value === "dark" ? value : "system";
}

/** Host seam driving theme (and, on desktop, the native theme sync). */
export interface AppearanceSeam {
  read(): AppearancePreferences;
  request(patch: Partial<AppearancePreferences>): AppearancePreferences;
  /** Optional change stream (mirrors the desktop appearance-change event). */
  subscribe?(cb: (prefs: AppearancePreferences) => void): () => void;
}

/** Host seam driving the per-window interface zoom. */
export interface ZoomSeam {
  read(): number;
  request(zoom: number): number;
  subscribe?(cb: (zoom: number) => void): () => void;
}
