/**
 * The design harness's stand-in for the desktop's appearance host.
 *
 * In the shipped window `apps/sync/src/lib/appearancePreferences.ts` owns the
 * theme and the window transparency: it writes the surface-alpha custom
 * properties, marks `<html data-window-transparency>`, answers the shell's
 * `hq:appearance-request` events (Settings → Window opacity sends them) and
 * announces every change with `hq:appearance-change`.
 *
 * A browser tab has no such host, and `packages/ui/src/home/tokens.css` pins
 * every surface to its opaque value while `data-window-transparency` is absent
 * — so without this the window material behind the shell could never show
 * through and translucency could not be judged at all.
 *
 * The arithmetic is the desktop's own (`applyAppearancePreferences` is
 * imported, not copied), so the harness and the app cannot drift. Only the
 * starting value is the harness's: it opens on the PR #772 reference
 * material rather than a fresh install's solid default.
 */
import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  MAX_SLIDER_WINDOW_OPACITY,
  MAX_WINDOW_OPACITY,
  MIN_SLIDER_WINDOW_OPACITY,
  normalizeColorTheme,
  normalizeWindowTransparency,
  type AppearancePreferences,
  type ColorTheme,
} from "@hq/ui/settings/appearance-seam";
import { applyAppearancePreferences } from "../../../../../sync/src/lib/appearancePreferences";

/**
 * Transparency 65 (35% opacity, the slider's floor) is where the token
 * formulas in `home/tokens.css` land exactly on the PR #772 reference alphas
 * (light ground 0.35, dark ground 0.6, clear chrome). A fresh install opens
 * at 0 (fully solid); `?opacity=100` shows that.
 */
export const HARNESS_DEFAULT_TRANSPARENCY = 65;

/** Harness-only memory of the last opacity picked, so reloads keep it. */
export const HARNESS_TRANSPARENCY_STORAGE_KEY = "hq-shell-harness.window-transparency";

type HarnessStorage = Pick<Storage, "getItem" | "setItem">;

/** Clamp to the opacity range the shipped Settings slider offers. */
export function clampHarnessOpacity(opacity: number): number {
  return Math.min(
    MAX_SLIDER_WINDOW_OPACITY,
    Math.max(MIN_SLIDER_WINDOW_OPACITY, Math.round(opacity)),
  );
}

export function transparencyFromOpacity(opacity: number): number {
  return normalizeWindowTransparency(
    MAX_WINDOW_OPACITY - clampHarnessOpacity(opacity),
  );
}

export function opacityFromTransparency(transparency: number): number {
  return MAX_WINDOW_OPACITY - normalizeWindowTransparency(transparency);
}

/**
 * Starting transparency: `?opacity=<35..100>` wins, then the last value
 * picked in the harness, then the reference default.
 */
export function initialHarnessTransparency(
  search: string,
  storage: Pick<Storage, "getItem"> | null | undefined,
): number {
  const fromUrl = new URLSearchParams(search).get("opacity");
  if (fromUrl !== null && fromUrl.trim() !== "" && Number.isFinite(Number(fromUrl))) {
    return transparencyFromOpacity(Number(fromUrl));
  }
  try {
    const stored = storage?.getItem(HARNESS_TRANSPARENCY_STORAGE_KEY);
    if (stored !== null && stored !== undefined && stored.trim() !== "") {
      const value = Number(stored);
      if (Number.isFinite(value)) {
        return transparencyFromOpacity(opacityFromTransparency(value));
      }
    }
  } catch {
    // Storage unavailable: fall through to the reference default.
  }
  return HARNESS_DEFAULT_TRANSPARENCY;
}

export interface HarnessAppearanceOptions {
  root: HTMLElement;
  target: EventTarget;
  initial: AppearancePreferences;
  storage?: HarnessStorage | null;
  /**
   * Persist / apply the theme through the shell's own seam (Settings'
   * `applyColorTheme`), so the theme the harness shows is the one the shell
   * believes it is in.
   */
  applyTheme?: (theme: ColorTheme) => void;
  onchange?: (prefs: AppearancePreferences) => void;
}

export interface HarnessAppearanceHost {
  /** Same path as a Settings change: merges, applies, announces. */
  request(patch: Partial<AppearancePreferences>): AppearancePreferences;
  current(): AppearancePreferences;
  dispose(): void;
}

export function installHarnessAppearance(
  options: HarnessAppearanceOptions,
): HarnessAppearanceHost {
  const { root, target, storage, applyTheme, onchange } = options;
  let current: AppearancePreferences = {
    colorTheme: normalizeColorTheme(options.initial.colorTheme),
    windowTransparency: normalizeWindowTransparency(
      options.initial.windowTransparency,
    ),
  };

  const apply = (next: AppearancePreferences): AppearancePreferences => {
    current = {
      colorTheme: normalizeColorTheme(next.colorTheme),
      windowTransparency: normalizeWindowTransparency(next.windowTransparency),
    };
    applyTheme?.(current.colorTheme);
    // "glass": the real window always has a native material behind it, and
    // the stage below emulates one, so the requested value is honoured as is.
    applyAppearancePreferences(root, current, "glass");
    try {
      storage?.setItem(
        HARNESS_TRANSPARENCY_STORAGE_KEY,
        String(current.windowTransparency),
      );
    } catch {
      // Best effort: the value still applies for this page load.
    }
    onchange?.(current);
    target.dispatchEvent(
      new CustomEvent<AppearancePreferences>(APPEARANCE_CHANGE_EVENT, {
        detail: current,
      }),
    );
    return current;
  };

  const onRequest = (event: Event): void => {
    const detail = (event as CustomEvent<Partial<AppearancePreferences>>).detail;
    apply({ ...current, ...(detail ?? {}) });
  };

  target.addEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
  apply(current);

  return {
    request: (patch) => apply({ ...current, ...patch }),
    current: () => current,
    dispose: () => target.removeEventListener(APPEARANCE_REQUEST_EVENT, onRequest),
  };
}
