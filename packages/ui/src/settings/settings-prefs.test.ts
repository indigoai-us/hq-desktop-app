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
    expect(parseSettingsPrefs({ uiSize: "large" }).uiSize).toBe("large");
    expect(parseSettingsPrefs(null).showSidebarScopeLabels).toBe(true);
    expect(parseSettingsPrefs({ showSidebarScopeLabels: false }).showSidebarScopeLabels).toBe(
      false,
    );
  });

  it("round-trips a patch through storage", () => {
    const storage = memoryStorage();
    const next = writeSettingsPrefs(
      { uiSize: "compact" },
      storage,
    );
    expect(next.uiSize).toBe("compact");
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
  });

  // Regression: window opacity used to live here too (default 80) while the
  // window was driven by the host's Appearance record (default 65 → 35%).
  // Two stores, two defaults — the slider showed one value, the window used
  // another. Opacity now lives only in the Appearance record.
  it("does not keep a second copy of window opacity", () => {
    const parsed = parseSettingsPrefs({ windowOpacity: 90 });
    expect("windowOpacity" in parsed).toBe(false);
    expect("windowOpacity" in DEFAULT_SETTINGS_PREFS).toBe(false);
  });

  it("tolerates an empty getSettings-shaped payload without throwing", () => {
    expect(() => parseSettingsPrefs({})).not.toThrow();
    const parsed = parseSettingsPrefs({});
    expect(parsed).toEqual(DEFAULT_SETTINGS_PREFS);
  });
});
