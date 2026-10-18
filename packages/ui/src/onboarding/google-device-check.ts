/**
 * US-013. While HQ waits on a Google browser sign-in, one plain line prepares
 * the person for Google's own new-device check. Claude Code's browser login
 * is that Google sign-in. Microsoft, Codex (ChatGPT) and Grok are not.
 * Nothing here changes Google's pages.
 */
export const GOOGLE_DEVICE_CHECK_COPY =
  "Google may ask you to confirm it's you on your phone. That is Google's own check.";

/** The line stays hidden until the browser wait has lasted this long. */
export const GOOGLE_DEVICE_CHECK_AFTER_MS = 10_000;

export function isGoogleBrowserSignIn(input: {
  provider?: "Google" | "Microsoft" | null;
  runtime?: string | null;
}): boolean {
  if (input.provider === "Google") return true;
  if (input.provider != null) return false;
  return input.runtime === "claude";
}

export function showGoogleDeviceCheck(input: {
  google: boolean;
  waitingOnBrowser: boolean;
  elapsedMs: number;
}): boolean {
  return input.google && input.waitingOnBrowser && input.elapsedMs >= GOOGLE_DEVICE_CHECK_AFTER_MS;
}

/** Starts the 10 second wait. The returned function cancels it. */
export function armGoogleDeviceCheck(onShow: () => void, delayMs = GOOGLE_DEVICE_CHECK_AFTER_MS): () => void {
  const timer = setTimeout(onShow, delayMs);
  return () => clearTimeout(timer);
}
