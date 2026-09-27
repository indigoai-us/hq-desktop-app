/**
 * Host-platform detection for settings rows that only exist on one OS.
 *
 * The desktop window's capability set doesn't include the Tauri OS plugin, so
 * we read the user-agent — the same signal `desktop-alt/main.ts` already uses
 * for its Windows branch. Kept as a pure function over an explicit user-agent
 * string so it is unit-testable without stubbing globals.
 *
 * This app only ever ships as a macOS / Windows / Linux desktop bundle, so
 * "Macintosh" is an unambiguous signal here; the mobile-Safari ambiguity that
 * forces web apps onto `maxTouchPoints` does not apply.
 */

/** True when the user-agent identifies a macOS host. */
export function isMacUserAgent(userAgent: string): boolean {
  // WKWebView on macOS reports "Macintosh; Intel Mac OS X" on both Intel and
  // Apple Silicon.
  return /Mac OS X|Macintosh/i.test(userAgent);
}

/** True when this window is running on macOS. */
export function isMac(): boolean {
  return (
    typeof navigator !== "undefined" && isMacUserAgent(navigator.userAgent)
  );
}

/** True when the user-agent identifies a Windows host. */
export function isWindowsUserAgent(userAgent: string): boolean {
  return /Windows/i.test(userAgent);
}

/** True when this window is running on Windows. */
export function isWindows(): boolean {
  return (
    typeof navigator !== "undefined" &&
    isWindowsUserAgent(navigator.userAgent)
  );
}

/**
 * The word for "this computer" in copy that used to hardcode "Mac" — HQ ships
 * on macOS, Windows, and Linux, and a Windows user reading "on this Mac" reads
 * as a platform bug, not a typo (fixed for hq-onboarding-windows-copy). Picks
 * the OS name where we can tell, falling back to the generic "computer" on
 * Linux or when the signal is ambiguous — never defaults to "Mac".
 */
export function hostDeviceNoun(userAgent?: string): string {
  const ua = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  if (isMacUserAgent(ua)) return "Mac";
  if (isWindowsUserAgent(ua)) return "PC";
  return "computer";
}
