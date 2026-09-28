/**
 * Plain-language name for the computer HQ is running on, so onboarding copy
 * does not tell a Windows user we are checking "your Mac".
 *
 * `resolveHostPlatform` collapses macOS/Windows/Linux into one `desktop` value,
 * which is right for capability flags and wrong for the words a person reads.
 * This tiny helper reads the same probe and picks the noun.
 *
 * Never hallucinate a brand: an unknown or missing probe returns the neutral
 * "computer", so the sentence still reads.
 */

import { readHostProbe, type HostProbe } from "./host-platform.js";

export type HostComputerNoun = "Mac" | "PC" | "computer";

/**
 * The everyday name for the box HQ is on: "Mac" for macOS, "PC" for Windows,
 * "computer" for anything else (Linux, unknown, or a probe that hasn't landed
 * yet).
 */
export function hostComputerNoun(
  probe: HostProbe = readHostProbe(),
): HostComputerNoun {
  switch (probe.osPlatform) {
    case "macos":
      return "Mac";
    case "windows":
      return "PC";
    default:
      return "computer";
  }
}

/**
 * "this Mac" / "this PC" / "this computer" - the demonstrative form used in
 * onboarding sentences ("Setup runs on this ___").
 */
export function thisComputerNoun(
  probe: HostProbe = readHostProbe(),
): string {
  return `this ${hostComputerNoun(probe)}`;
}

/**
 * "your Mac" / "your PC" / "your computer" - the possessive form used when the
 * sentence is about the person's machine ("checking your ___").
 */
export function yourComputerNoun(
  probe: HostProbe = readHostProbe(),
): string {
  return `your ${hostComputerNoun(probe)}`;
}

/**
 * Platform-appropriate label for the "primary modifier + Enter" shortcut a
 * form's submit affordance advertises. "⌘↵" on macOS, "Ctrl+Enter" on Windows
 * and Linux. Kept as a single helper so a wizard's hint never renames the key
 * on the machine it is running on.
 */
export function primaryEnterKeyHint(
  probe: HostProbe = readHostProbe(),
): string {
  return probe.osPlatform === "macos" ? "⌘↵" : "Ctrl+Enter";
}
