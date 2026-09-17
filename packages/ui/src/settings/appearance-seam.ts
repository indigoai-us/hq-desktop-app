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

/**
 * Window-level DOM contract shared with the desktop host
 * (`apps/sync/src/lib/appearancePreferences.ts`). packages/ui must not import
 * from apps/sync, so the names are duplicated here and must stay in sync:
 * - the host listens for APPEARANCE_REQUEST_EVENT and applies + persists;
 * - the host dispatches APPEARANCE_CHANGE_EVENT after every apply;
 * - the host marks `<html data-window-transparency="0..100">` once installed.
 */
export const APPEARANCE_REQUEST_EVENT = "hq:appearance-request";
export const APPEARANCE_CHANGE_EVENT = "hq:appearance-change";
export const WINDOW_TRANSPARENCY_DATASET_KEY = "windowTransparency";

export const DEFAULT_WINDOW_TRANSPARENCY = 65;
export const MIN_WINDOW_TRANSPARENCY = 0;
export const MAX_WINDOW_TRANSPARENCY = 100;
export const MIN_WINDOW_OPACITY = 0;
export const MAX_WINDOW_OPACITY = 100;

/**
 * Floor of the user-facing opacity slider.
 *
 * It MUST be able to represent the shipped default. `DEFAULT_WINDOW_TRANSPARENCY`
 * is 65, i.e. opacity 35 — a 50 floor made the default unrepresentable, so a
 * fresh install seeded the slider at 50 and the first drag jumped the window.
 * Derived from the default so the two can never drift apart again.
 */
export const MIN_SLIDER_WINDOW_OPACITY =
  MAX_WINDOW_OPACITY - DEFAULT_WINDOW_TRANSPARENCY;
export const MAX_SLIDER_WINDOW_OPACITY = MAX_WINDOW_OPACITY;

export const MIN_DESKTOP_ZOOM = 0.8;
export const MAX_DESKTOP_ZOOM = 1.6;

export type ColorTheme = "system" | "light" | "dark";

export interface AppearancePreferences {
  colorTheme: ColorTheme;
  windowTransparency: number;
}

export function normalizeColorTheme(value: unknown): ColorTheme {
  return value === "light" || value === "dark" ? value : "system";
}

export function normalizeWindowTransparency(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WINDOW_TRANSPARENCY;
  return Math.round(
    Math.min(
      MAX_WINDOW_TRANSPARENCY,
      Math.max(MIN_WINDOW_TRANSPARENCY, numeric),
    ),
  );
}

export function windowOpacityFromTransparency(value: unknown): number {
  return MAX_WINDOW_OPACITY - normalizeWindowTransparency(value);
}

export function windowTransparencyFromOpacity(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  const opacity = Number.isFinite(numeric)
    ? Math.round(
        Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, numeric)),
      )
    : windowOpacityFromTransparency(DEFAULT_WINDOW_TRANSPARENCY);
  return normalizeWindowTransparency(MAX_WINDOW_OPACITY - opacity);
}

/** Host seam driving theme + window transparency (desktop window chrome). */
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
