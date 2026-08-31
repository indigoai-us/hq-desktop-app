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

function approvedHost(hostname: string): boolean {
  return (
    EXACT_HOSTS.has(hostname) ||
    SUFFIX_HOSTS.some((suffix) => hostname.endsWith(suffix))
  );
}

/** Return a normalized approved HTTPS URL, or throw an actionable error. */
export function approvedExternalUrl(raw: string): string {
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
