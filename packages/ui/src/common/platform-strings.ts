/**
 * OS-specific words for settings and onboarding copy, in one place.
 *
 * The native OS probe (`readHostProbe`) can land late or not at all in the
 * embedded settings window, and the old inline checks treated "unknown" as
 * Windows, so a Mac showed "Show in taskbar" / "Alt+Tab". Here the probe wins
 * when it is specific and the user-agent is the fallback, so a Mac always
 * reads Mac wording.
 */

import { readHostProbe, type HostProbe } from "@hq/platform";

import { isMacUserAgent } from "./platform";

export type HostOs = "mac" | "windows" | "linux";

export interface PlatformStrings {
  computer: string;
  dockToggle: string;
  dockToggleHint: string;
  trayRow: string;
  fileManager: string;
  revealInFileManager: string;
}

const STRINGS: Record<HostOs, PlatformStrings> = {
  mac: {
    computer: "Mac",
    dockToggle: "Show in Dock",
    dockToggleHint: "Keep HQ in the Dock and the app switcher (Cmd+Tab)",
    trayRow: "Menu bar quick access",
    fileManager: "Finder",
    revealInFileManager: "Reveal in Finder",
  },
  windows: {
    computer: "PC",
    dockToggle: "Show in taskbar",
    dockToggleHint: "Keep HQ in the taskbar and Alt+Tab switcher",
    trayRow: "System tray quick access",
    fileManager: "file manager",
    revealInFileManager: "Reveal in file manager",
  },
  linux: {
    computer: "computer",
    dockToggle: "Show in the app switcher",
    dockToggleHint: "Keep HQ in the app switcher",
    trayRow: "System tray quick access",
    fileManager: "file manager",
    revealInFileManager: "Reveal in file manager",
  },
};

/** Resolve the host OS from the native probe, falling back to the user-agent. */
export function resolveHostOs(
  probe: HostProbe = readHostProbe(),
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): HostOs {
  if (probe.osPlatform === "macos") return "mac";
  if (probe.osPlatform === "windows") return "windows";
  if (probe.osPlatform === "linux") return "linux";
  if (isMacUserAgent(userAgent)) return "mac";
  if (/Windows/i.test(userAgent)) return "windows";
  return "linux";
}

export function platformStrings(os: HostOs = resolveHostOs()): PlatformStrings {
  return STRINGS[os];
}
