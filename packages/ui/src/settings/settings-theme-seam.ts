/**
 * Appearance seam for the V2 shell — drives SettingsPage's prototype
 * Appearance section (theme radios + window opacity slider).
 *
 * Theme goes through `data-force-theme`. Window transparency goes through
 * `applyWindowOpacity`, which asks the desktop host (if installed) to apply +
 * persist it and otherwise writes the surface-alpha vars directly. The value
 * is also stored in the shared settings prefs so it survives a restart on
 * hosts without an appearance installer, and so both Settings screens agree.
 */
import {
  APPEARANCE_CHANGE_EVENT,
  normalizeWindowTransparency,
  windowOpacityFromTransparency,
  type AppearancePreferences,
  type AppearanceSeam,
} from "./appearance-seam.js";
import {
  applyWindowOpacity,
  currentColorTheme,
  readHostWindowOpacity,
  requestColorTheme,
  THEME_STORAGE_KEY,
} from "./shell-settings-model.js";
import { readSettingsPrefs, writeSettingsPrefs } from "./settings-prefs.js";

type SeamStorage = Pick<Storage, "getItem" | "setItem">;

export interface ShellAppearanceSeamOptions {
  root?: HTMLElement | null;
  target?: EventTarget | null;
  storage?: SeamStorage | null;
}

export function createShellAppearanceSeam(
  options: ShellAppearanceSeamOptions = {},
): AppearanceSeam {
  const root =
    options.root === undefined
      ? (globalThis.document?.documentElement ?? null)
      : options.root;
  const target =
    options.target === undefined
      ? typeof window === "undefined"
        ? null
        : window
      : options.target;
  const storage = options.storage;

  const readOpacity = (): number =>
    readHostWindowOpacity(root) ?? readSettingsPrefs(storage).windowOpacity;

  const read = (): AppearancePreferences => ({
    colorTheme: currentColorTheme(root),
    windowTransparency: normalizeWindowTransparency(100 - readOpacity()),
  });

  return {
    read,
    request(patch) {
      const current = read();
      const colorTheme = patch.colorTheme ?? current.colorTheme;
      if (patch.colorTheme !== undefined) {
        requestColorTheme(colorTheme, root, target);
      }
      let windowTransparency = current.windowTransparency;
      if (patch.windowTransparency !== undefined) {
        const opacity = applyWindowOpacity(
          windowOpacityFromTransparency(patch.windowTransparency),
          root,
          target,
        );
        writeSettingsPrefs({ windowOpacity: opacity }, storage);
        windowTransparency = 100 - opacity;
      }
      return { colorTheme, windowTransparency };
    },
    subscribe(cb) {
      if (!target) return () => {};
      const onChange = (): void => cb(read());
      target.addEventListener(APPEARANCE_CHANGE_EVENT, onChange);
      return () => target.removeEventListener(APPEARANCE_CHANGE_EVENT, onChange);
    },
  };
}

/**
 * Boot-time theme restore. Re-applies only a theme the user explicitly saved.
 * With nothing stored, the existing `data-force-theme` (set by the harness or
 * an earlier boot step) or the OS appearance is left alone. The old boot path
 * called `applyColorTheme(readStoredTheme())`, and `readStoredTheme` defaults
 * to "dark", so light mode was forced back to dark on every launch.
 *
 * A saved theme is also handed to the desktop appearance host, so the native
 * window theme and the host's shared preference agree with it. Installs that
 * chose a theme before Settings routed through the host have it only under
 * THEME_STORAGE_KEY; this carries it over on the next launch.
 */
export function restoreStoredColorTheme(
  root: HTMLElement | null = globalThis.document?.documentElement ?? null,
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | null
    | undefined = globalThis.localStorage,
  target: EventTarget | null = typeof window === "undefined" ? null : window,
): void {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch (error) {
    console.warn("[theme] stored theme unreadable; keeping current", error);
    return;
  }
  if (stored !== "light" && stored !== "dark" && stored !== "system") return;
  // Already in force (the host restored the same choice): no round-trip.
  if (root && stored === currentColorTheme(root)) return;
  requestColorTheme(stored, root, target, storage);
}
