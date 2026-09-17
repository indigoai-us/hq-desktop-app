import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS_PREFS,
  parseSettingsPrefs,
  readSettingsPrefs,
  writeSettingsPrefs,
} from "./settings-prefs.js";

function memoryStorage(seed: Record<string, string> = {}) {
  const store = { ...seed };
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

describe("settings prefs", () => {
  it("fills defaults for junk payloads", () => {
    expect(parseSettingsPrefs(null).showInDock).toBe(true);
    // The floor is the shipped default (transparency 65 → opacity 35), not 50:
    // a 50 floor could not represent the default the app actually ships with.
    expect(parseSettingsPrefs({ windowOpacity: 20 }).windowOpacity).toBe(35);
    expect(parseSettingsPrefs({ windowOpacity: 35 }).windowOpacity).toBe(35);
    expect(parseSettingsPrefs({ windowOpacity: 140 }).windowOpacity).toBe(100);
    expect(parseSettingsPrefs({ uiSize: "large" }).uiSize).toBe("large");
    expect(parseSettingsPrefs(null).showSidebarScopeLabels).toBe(true);
    expect(parseSettingsPrefs({ showSidebarScopeLabels: false }).showSidebarScopeLabels).toBe(
      false,
    );
  });

  it("round-trips a patch through storage", () => {
    const storage = memoryStorage();
    const next = writeSettingsPrefs(
      { windowOpacity: 77, uiSize: "compact" },
      storage,
    );
    expect(next.windowOpacity).toBe(77);
    expect(readSettingsPrefs(storage).uiSize).toBe("compact");
    expect(readSettingsPrefs(storage).showInDock).toBe(
      DEFAULT_SETTINGS_PREFS.showInDock,
    );
    expect(readSettingsPrefs(storage).showSidebarScopeLabels).toBe(true);
    writeSettingsPrefs({ showSidebarScopeLabels: false }, storage);
    expect(readSettingsPrefs(storage).showSidebarScopeLabels).toBe(false);
  });

  it("does not retain legacy host-control fields in local presentation preferences", () => {
    const parsed = parseSettingsPrefs({
      launchAtLogin: false,
      autoUpdates: false,
      recordingCompanyId: "co_indigo",
    });
    expect(parsed.showInDock).toBe(true);
    expect(parsed.uiSize).toBe("default");
    expect(parsed.windowOpacity).toBe(80);
  });

  it("tolerates an empty getSettings-shaped payload without throwing", () => {
    expect(() => parseSettingsPrefs({})).not.toThrow();
    const parsed = parseSettingsPrefs({});
    expect(parsed).toEqual(DEFAULT_SETTINGS_PREFS);
  });
});
