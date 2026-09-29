/**
 * Appearance seam for the V2 shell — drives SettingsPage's prototype
 * Appearance section (theme radios + window opacity slider).
 *
 * A thin adapter over `appearance-store.ts`, the one Appearance state shared
 * with Settings > Appearance and the title-bar Appearance menu.
 */
import {
  APPEARANCE_CHANGE_EVENT,
  windowOpacityFromTransparency,
  type AppearancePreferences,
  type AppearanceSeam,
} from "./appearance-seam.js";
import {
  readAppearanceState,
  setAppearanceColorTheme,
  setAppearanceWindowOpacity,
  type AppearanceState,
} from "./appearance-store.js";

type SeamStorage = Pick<Storage, "getItem" | "setItem">;

export interface ShellAppearanceSeamOptions {
  root?: HTMLElement | null;
  target?: EventTarget | null;
  storage?: SeamStorage | null;
}

function toPreferences(state: AppearanceState): AppearancePreferences {
  return {
    colorTheme: state.colorTheme,
    windowTransparency: 100 - state.windowOpacity,
  };
}

export function createShellAppearanceSeam(
  options: ShellAppearanceSeamOptions = {},
): AppearanceSeam {
  const read = (): AppearancePreferences =>
    toPreferences(readAppearanceState(options));
  return {
    read,
    request(patch) {
      if (patch.colorTheme !== undefined) {
        setAppearanceColorTheme(patch.colorTheme, options);
      }
      if (patch.windowTransparency !== undefined) {
        setAppearanceWindowOpacity(
          windowOpacityFromTransparency(patch.windowTransparency),
          options,
        );
      }
      return read();
    },
    subscribe(cb) {
      const target =
        options.target === undefined
          ? typeof window === "undefined"
            ? null
            : window
          : options.target;
      if (!target) return () => {};
      const onChange = (): void => cb(read());
      target.addEventListener(APPEARANCE_CHANGE_EVENT, onChange);
      return () => target.removeEventListener(APPEARANCE_CHANGE_EVENT, onChange);
    },
  };
}
