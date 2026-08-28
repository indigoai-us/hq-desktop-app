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
    expect(parseSettingsPrefs(null).launchAtLogin).toBe(true);
    expect(parseSettingsPrefs({ quietHours: true }).quietHours).toBe(true);
    expect(parseSettingsPrefs({ quietHours: true }).sounds).toBe(false);
  });

  it("round-trips a patch through storage", () => {
    const storage = memoryStorage();
    const next = writeSettingsPrefs(
      { quietHours: true, defaultCompanyId: "co_indigo" },
      storage,
    );
    expect(next.quietHours).toBe(true);
    expect(readSettingsPrefs(storage).defaultCompanyId).toBe("co_indigo");
    expect(readSettingsPrefs(storage).launchAtLogin).toBe(
      DEFAULT_SETTINGS_PREFS.launchAtLogin,
    );
  });

  it("merges companySync instead of replacing it", () => {
    const storage = memoryStorage();
    writeSettingsPrefs({ companySync: { a: true } }, storage);
    const next = writeSettingsPrefs({ companySync: { b: false } }, storage);
    expect(next.companySync).toEqual({ a: true, b: false });
  });

  it("fills Daybook prototype toggles from defaults", () => {
    const parsed = parseSettingsPrefs({ launchAtLogin: false });
    expect(parsed.launchAtLogin).toBe(false);
    expect(parsed.showInDock).toBe(true);
    expect(parsed.menubarAccess).toBe(true);
    expect(parsed.notifyShare).toBe(true);
    expect(parsed.autoSync).toBe(true);
    expect(parsed.uiSize).toBe("default");
    expect(parsed.windowOpacity).toBe(80);
    expect(parsed.meetingPlatforms.Zoom).toBe(true);
    expect(parsed.meetingPlatforms.Teams).toBe(false);
  });

  it("tolerates an empty getSettings-shaped payload without throwing", () => {
    expect(() => parseSettingsPrefs({})).not.toThrow();
    const parsed = parseSettingsPrefs({});
    expect(parsed.meetingDetection).toBe(
      DEFAULT_SETTINGS_PREFS.meetingDetection,
    );
    expect(parsed.recordingCompanyId).toBeNull();
    expect(parsed.meetingPlatforms).toEqual(
      DEFAULT_SETTINGS_PREFS.meetingPlatforms,
    );
  });

  it("persists watched platforms and restores them on relaunch", () => {
    const storage = memoryStorage();
    writeSettingsPrefs(
      {
        meetingDetection: false,
        meetingPlatforms: {
          Zoom: false,
          "Google Meet": true,
          Teams: true,
        },
      },
      storage,
    );
    const restored = readSettingsPrefs(storage);
    expect(restored.meetingDetection).toBe(false);
    expect(restored.meetingPlatforms).toEqual({
      Zoom: false,
      "Google Meet": true,
      Teams: true,
    });
  });

  it("persists recordingCompanyId and restores it on relaunch", () => {
    const storage = memoryStorage();
    writeSettingsPrefs({ recordingCompanyId: "co_indigo" }, storage);
    expect(readSettingsPrefs(storage).recordingCompanyId).toBe("co_indigo");
  });
});
