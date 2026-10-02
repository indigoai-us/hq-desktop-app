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
  applyColorTheme,
  applyWindowOpacity,
  readHostWindowOpacity,
  readStoredTheme,
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
    colorTheme: readStoredTheme(),
    windowTransparency: normalizeWindowTransparency(100 - readOpacity()),
  });

  return {
    read,
    request(patch) {
      const current = read();
      const colorTheme = patch.colorTheme ?? current.colorTheme;
      if (patch.colorTheme !== undefined) applyColorTheme(colorTheme);
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
