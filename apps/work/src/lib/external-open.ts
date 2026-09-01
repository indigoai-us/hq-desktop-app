/**
 * Browser handoffs from Work's untrusted channel content.
 *
 * Keep this host list aligned with Sync's desktop-alt/external-open.ts. The
 * special macOS settings scheme accepted by Sync is deliberately absent here:
 * this seam only opens URLs supplied by channel content.
 */
import { tauriInvoke } from "./tauri-invoke.js";

const EXACT_HOSTS = new Set([
  "hq.computer",
  "calendar.google.com",
  "accounts.google.com",
  "meet.google.com",
  "teams.microsoft.com",
  "zoom.us",
  "webex.com",
]);

const SUFFIX_HOSTS = [".zoom.us", ".webex.com"] as const;

function approvedHost(hostname: string): boolean {
  return (
    EXACT_HOSTS.has(hostname) ||
    SUFFIX_HOSTS.some((suffix) => hostname.endsWith(suffix))
  );
}

/** Return a normalized HTTPS URL approved for an external Work handoff. */
export function approvedWorkExternalUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !approvedHost(parsed.hostname.toLowerCase())
  ) {
    return null;
  }
  return parsed.toString();
}

/**
 * Open an approved handoff in the platform's external browser. Tauri keeps
 * using its native shell boundary; hosted web preserves window protections.
 */
export function openWorkExternalUrl(
  raw: string,
  runtime: "desktop" | "web",
): void {
  const url = approvedWorkExternalUrl(raw);
  if (!url) return;
  if (runtime === "desktop") {
    void tauriInvoke("plugin:shell|open", { path: url, with: null }).catch(
      () => {},
    );
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
