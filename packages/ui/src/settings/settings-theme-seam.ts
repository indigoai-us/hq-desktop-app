/**
 * Appearance seam for the V2 shell — drives SettingsPage's prototype
 * Appearance section (theme radios) via `data-force-theme`.
 */
import type {
  AppearancePreferences,
  AppearanceSeam,
} from "./appearance-seam.js";
import { applyColorTheme, readStoredTheme } from "./shell-settings-model.js";

export function createShellAppearanceSeam(): AppearanceSeam {
  const read = (): AppearancePreferences => ({
    colorTheme: readStoredTheme(),
  });
  return {
    read,
    request(patch) {
      const current = read();
      const next: AppearancePreferences = {
        colorTheme: patch.colorTheme ?? current.colorTheme,
      };
      applyColorTheme(next.colorTheme);
      return next;
    },
  };
}
