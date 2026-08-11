/**
 * V2 Cloud Connected/Off state (hq-desktop-v2 US-001).
 *
 * "Cloud Off" pauses sync on THIS device. The flag is persisted in
 * ~/.hq/menubar.json (`cloudPaused`, via get/save_settings) — the SAME store
 * the Rust sync gates read (`is_cloud_paused` in hq-desktop-core), so every
 * sync path (V2 window Sync, popover Sync Now, watch daemon / auto-sync /
 * instant push) obeys the switch, not just the surface that renders it.
 *
 * localStorage is kept only as (a) the legacy pre-settings store, migrated
 * into settings on first read, and (b) a synchronous mirror so the titlebar
 * can render without waiting for the settings round-trip. It is never the
 * source of truth for whether sync runs.
 */
import { invoke } from '@tauri-apps/api/core';
import { updateSettings } from '../../lib/settings-mutations';

export const CLOUD_PAUSED_STORAGE_KEY = 'hq-sync.desktop.cloud-paused.v1';

/** Window event fired whenever the paused flag changes (detail: boolean). */
export const CLOUD_PAUSED_CHANGED_EVENT = 'hq:cloud-paused-changed';

/** Pure parse so the storage contract is unit-testable. */
export function parseCloudPaused(raw: string | null): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * Pure resolution of the settings-backed flag against the legacy localStorage
 * value (unit-testable): an explicit boolean in settings wins; when settings
 * has never stored the flag, the legacy value applies and — when paused —
 * must be migrated into settings so the Rust gates see it.
 */
export function resolveCloudPaused(
  settingsValue: unknown,
  legacyRaw: string | null,
): { paused: boolean; migrateLegacy: boolean } {
  if (typeof settingsValue === 'boolean') {
    return { paused: settingsValue, migrateLegacy: false };
  }
  const legacy = parseCloudPaused(legacyRaw);
  return { paused: legacy, migrateLegacy: legacy };
}

/** Synchronous read of the localStorage MIRROR (render-fast, not authoritative). */
export function readCloudPaused(): boolean {
  try {
    return parseCloudPaused(window.localStorage.getItem(CLOUD_PAUSED_STORAGE_KEY));
  } catch {
    // Storage unavailable → never paused (sync keeps working).
    return false;
  }
}

function mirrorCloudPaused(paused: boolean): void {
  try {
    if (paused) window.localStorage.setItem(CLOUD_PAUSED_STORAGE_KEY, '1');
    else window.localStorage.removeItem(CLOUD_PAUSED_STORAGE_KEY);
  } catch {
    // Best-effort mirror; the settings store still applies.
  }
  window.dispatchEvent(new CustomEvent(CLOUD_PAUSED_CHANGED_EVENT, { detail: paused }));
}

/**
 * Authoritative async read: menubar.json via get_settings, migrating a legacy
 * localStorage pause into settings on first sight so the Rust sync gates
 * honor a pause set before this write-through existed.
 */
export async function loadCloudPaused(): Promise<boolean> {
  let settingsValue: unknown;
  try {
    const prefs = await invoke<{ cloudPaused?: boolean | null }>('get_settings');
    settingsValue = prefs?.cloudPaused;
  } catch {
    // Settings unreachable → fall back to the mirror; do not migrate.
    return readCloudPaused();
  }
  let legacyRaw: string | null = null;
  try {
    legacyRaw = window.localStorage.getItem(CLOUD_PAUSED_STORAGE_KEY);
  } catch {
    legacyRaw = null;
  }
  const { paused, migrateLegacy } = resolveCloudPaused(settingsValue, legacyRaw);
  if (migrateLegacy) {
    await updateSettings({ cloudPaused: paused }).catch(() => undefined);
  }
  mirrorCloudPaused(paused);
  return paused;
}

/**
 * Write-through toggle: persist to menubar.json (the store the Rust gates
 * read) and update the localStorage mirror + same-window change event.
 */
export async function setCloudPaused(paused: boolean): Promise<void> {
  mirrorCloudPaused(paused);
  await updateSettings({ cloudPaused: paused });
}
