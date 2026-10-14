import { describe, expect, it } from "vitest";

import { platformStrings, resolveHostOs } from "./platform-strings";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
const noProbe = { tauri: true, osPlatform: null };

describe("resolveHostOs", () => {
  it("prefers the native probe", () => {
    expect(resolveHostOs({ tauri: true, osPlatform: "windows" }, MAC_UA)).toBe("windows");
    expect(resolveHostOs({ tauri: true, osPlatform: "macos" }, WIN_UA)).toBe("mac");
  });

  it("falls back to the user-agent when the probe has not landed", () => {
    expect(resolveHostOs(noProbe, MAC_UA)).toBe("mac");
    expect(resolveHostOs(noProbe, WIN_UA)).toBe("windows");
    expect(resolveHostOs(noProbe, LINUX_UA)).toBe("linux");
  });
});

describe("platformStrings", () => {
  it("uses Dock wording on macOS", () => {
    const s = platformStrings("mac");
    expect(s.dockToggle).toBe("Show in Dock");
    expect(s.dockToggleHint).toBe("Keep HQ in the Dock and the app switcher (Cmd+Tab)");
    expect(s.trayRow).toBe("Menu bar quick access");
    expect(s.fileManager).toBe("Finder");
    expect(Object.values(s).join(" ")).not.toMatch(/taskbar|Alt\+Tab|tray/i);
  });

  it("uses taskbar wording on Windows", () => {
    const s = platformStrings("windows");
    expect(s.dockToggle).toBe("Show in taskbar");
    expect(s.dockToggleHint).toBe("Keep HQ in the taskbar and Alt+Tab switcher");
    expect(s.fileManager).toBe("file manager");
  });

  it("uses neutral wording on Linux", () => {
    const s = platformStrings("linux");
    expect(s.dockToggle).toBe("Show in the app switcher");
    expect(Object.values(s).join(" ")).not.toMatch(/Dock|taskbar|Finder|Cmd|Alt\+Tab/);
  });
});
