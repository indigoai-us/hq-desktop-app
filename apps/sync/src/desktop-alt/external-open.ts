/**
 * The embedded Work surface opens browser handoffs only through this boundary.
 * Calendar event data is external input, so forwarding arbitrary schemes to
 * Tauri's shell plugin would turn a calendar row into a local-app launcher.
 */

import { open as tauriOpen } from '@tauri-apps/plugin-shell';

const EXACT_HOSTS = new Set([
  'hq.computer',
  'calendar.google.com',
  'accounts.google.com',
  'meet.google.com',
  'teams.microsoft.com',
  'zoom.us',
  'webex.com',
]);

const SUFFIX_HOSTS = ['.zoom.us', '.webex.com'] as const;

/**
 * macOS System Settings route used solely by the denied-notifications
 * recovery action. Keep this exact string separate from browser URL approval:
 * no caller can use this seam to launch an arbitrary local scheme.
 */
export const MACOS_NOTIFICATIONS_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.notifications';

function approvedHost(hostname: string): boolean {
  return (
    EXACT_HOSTS.has(hostname) ||
    SUFFIX_HOSTS.some((suffix) => hostname.endsWith(suffix))
  );
}

/** Return a normalized approved HTTPS URL, or throw an actionable error. */
export function approvedExternalUrl(raw: string): string {
  if (raw === MACOS_NOTIFICATIONS_SETTINGS_URL) return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('The requested external link is invalid.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !approvedHost(parsed.hostname.toLowerCase())
  ) {
    throw new Error('This external link is not approved for HQ Work.');
  }
  return parsed.toString();
}

/** Open an approved browser handoff through the narrow Tauri shell capability. */
export async function openApprovedExternalUrl(raw: string): Promise<void> {
  await tauriOpen(approvedExternalUrl(raw));
}

/**
 * Chat and shell links: any credential-free http(s)/mailto URL. Host
 * allowlists belong on calendar-derived handoffs (`approvedExternalUrl`).
 */
export function approvedBrowserUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'mailto:'
  ) {
    return null;
  }
  return parsed.toString();
}

/** Open a chat/shell URL in the default browser. Unknown schemes are ignored. */
export async function openBrowserUrl(raw: string): Promise<void> {
  const url = approvedBrowserUrl(raw);
  if (!url) return;
  await tauriOpen(url);
}
