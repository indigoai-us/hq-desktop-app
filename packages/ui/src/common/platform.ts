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
