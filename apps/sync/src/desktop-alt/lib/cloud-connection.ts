/**
 * V2 Cloud Connected/Off state (hq-desktop-v2 US-001).
 *
 * "Cloud Off" pauses sync on THIS device: DesktopApp consults the flag before
 * starting a sync and the titlebar switch flips its label. The flag is a local
 * per-device preference persisted in localStorage — it deliberately does not
 * touch the per-workspace sync-mode vault writes (those stay per-company).
 * Overview's Needs-you surface consumes the same flag in a later story.
 */

export const CLOUD_PAUSED_STORAGE_KEY = 'hq-sync.desktop.cloud-paused.v1';

/** Window event fired whenever the paused flag changes (detail: boolean). */
export const CLOUD_PAUSED_CHANGED_EVENT = 'hq:cloud-paused-changed';

/** Pure parse so the storage contract is unit-testable. */
export function parseCloudPaused(raw: string | null): boolean {
  return raw === '1' || raw === 'true';
}

export function readCloudPaused(): boolean {
  try {
    return parseCloudPaused(window.localStorage.getItem(CLOUD_PAUSED_STORAGE_KEY));
  } catch {
    // Storage unavailable → never paused (sync keeps working).
    return false;
  }
}

export function writeCloudPaused(paused: boolean): void {
  try {
    if (paused) window.localStorage.setItem(CLOUD_PAUSED_STORAGE_KEY, '1');
    else window.localStorage.removeItem(CLOUD_PAUSED_STORAGE_KEY);
  } catch {
    // Best-effort persistence; the in-session state still applies.
  }
  window.dispatchEvent(new CustomEvent(CLOUD_PAUSED_CHANGED_EVENT, { detail: paused }));
}
