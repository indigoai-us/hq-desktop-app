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
    expect(parseSettingsPrefs({ windowOpacity: 20 }).windowOpacity).toBe(50);
    expect(parseSettingsPrefs({ uiSize: "large" }).uiSize).toBe("large");
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
