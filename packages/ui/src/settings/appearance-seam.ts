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

/**
 * The ONE storage record for Appearance (theme + window transparency).
 *
 * The desktop host (`apps/sync/src/lib/appearancePreferences.ts`) owns it when
 * installed; without a host (web) packages/ui reads and writes the same key.
 * Nothing else may persist a copy of these values — a second store is how the
 * Settings slider came to show one number while the window applied another.
 */
export const APPEARANCE_STORAGE_KEY = "hq-sync.appearance.v1";
/** Schema marker for records written since the 100%-opaque default. */
export const APPEARANCE_RECORD_VERSION = 2;

/** Fresh installs are fully solid: transparency 0 == opacity 100%. */
export const DEFAULT_WINDOW_TRANSPARENCY = 0;
/**
 * The default every build before v0.10.354 shipped. The app wrote it into the
 * store on any Appearance request (a theme change carried it along), so a
 * legacy record holding exactly this value is an app default, not a choice.
 */
export const LEGACY_DEFAULT_WINDOW_TRANSPARENCY = 65;

/**
 * Floor of the user-facing opacity slider. Fixed, not derived from the
 * default: it keeps every legacy value (down to the old 35% default) in range.
 */
export const MIN_SLIDER_WINDOW_OPACITY = 35;
export const MAX_SLIDER_WINDOW_OPACITY = 100;
export const MIN_WINDOW_OPACITY = MIN_SLIDER_WINDOW_OPACITY;
export const MAX_WINDOW_OPACITY = 100;
export const MIN_WINDOW_TRANSPARENCY = 0;
/**
 * Transparency and slider share one range, so the value the host applies is
 * always a value the slider can show.
 */
export const MAX_WINDOW_TRANSPARENCY =
  MAX_WINDOW_OPACITY - MIN_SLIDER_WINDOW_OPACITY;

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

/** Stored record: the preference plus whether the user chose the transparency. */
export interface StoredAppearance extends AppearancePreferences {
  /** True only once the user moved the opacity control. */
  windowTransparencySet: boolean;
}

export const DEFAULT_STORED_APPEARANCE: StoredAppearance = {
  colorTheme: "system",
  windowTransparency: DEFAULT_WINDOW_TRANSPARENCY,
  windowTransparencySet: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the stored record, upgrading legacy (pre-v2) records.
 *
 * Upgrade rule for a legacy transparency:
 * - missing / malformed, or exactly the legacy default (65) — the app wrote it,
 *   the user never chose it: reset to the new 100%-opaque default;
 * - any other value — only the slider could have produced it: keep it and
 *   mark it chosen.
 * `migrated` tells the caller to write the upgraded record back once.
 */
export function parseStoredAppearance(raw: string | null | undefined): {
  record: StoredAppearance;
  migrated: boolean;
} {
  if (!raw) return { record: { ...DEFAULT_STORED_APPEARANCE }, migrated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: { ...DEFAULT_STORED_APPEARANCE }, migrated: false };
  }
  if (!isRecord(parsed)) {
    return { record: { ...DEFAULT_STORED_APPEARANCE }, migrated: false };
  }
  const colorTheme = normalizeColorTheme(parsed.colorTheme);
  if (parsed.v === APPEARANCE_RECORD_VERSION) {
    const set = parsed.windowTransparencySet === true;
    return {
      record: {
        colorTheme,
        windowTransparency: set
          ? normalizeWindowTransparency(parsed.windowTransparency)
          : DEFAULT_WINDOW_TRANSPARENCY,
        windowTransparencySet: set,
      },
      migrated: false,
    };
  }
  const legacy =
    typeof parsed.windowTransparency === "number"
      ? parsed.windowTransparency
      : Number(parsed.windowTransparency ?? Number.NaN);
  const chosen =
    Number.isFinite(legacy) &&
    Math.round(legacy) !== LEGACY_DEFAULT_WINDOW_TRANSPARENCY;
  return {
    record: {
      colorTheme,
      windowTransparency: chosen
        ? normalizeWindowTransparency(legacy)
        : DEFAULT_WINDOW_TRANSPARENCY,
      windowTransparencySet: chosen,
    },
    migrated: true,
  };
}

export function serializeStoredAppearance(record: StoredAppearance): string {
  return JSON.stringify({
    v: APPEARANCE_RECORD_VERSION,
    colorTheme: normalizeColorTheme(record.colorTheme),
    windowTransparency: normalizeWindowTransparency(record.windowTransparency),
    windowTransparencySet: record.windowTransparencySet === true,
  });
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
