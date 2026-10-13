/**
 * The Settings Cloud switch (usage-only-pricing US-016).
 *
 * The host owns the setting (`cloudPaused` in the desktop settings file, so it
 * survives restarts and app updates). This module adds what the UI needs on
 * top: the copy, a last-known value for cache-first painting, and one window
 * event so the title bar and Settings agree the moment the switch moves.
 */

import type { PlatformAdapter } from "@hq/platform";

/** Window event fired after the switch changes. `detail.cloudEnabled`. */
export const CLOUD_SWITCH_EVENT = "hq:cloud-switch-changed";

/** Last-known switch value for first paint. Machine-wide, not per company. */
export const CLOUD_SWITCH_CACHE_KEY = "hq.cloud-switch.v1";

export const CLOUD_SWITCH_COPY = {
  label: "Cloud",
  onDescription:
    "Sync your companies and personal files with HQ cloud on this computer.",
  offTitle: "Cloud is off",
  offBody:
    "HQ Desktop and the HQ background sync service stop all uploads and downloads for your companies and your personal files on this computer. Sign-in, messages, and deploys still work.",
  cliCaveat: "An hq sync command you or a skill runs in a terminal still syncs.",
  turnOnHint: "To sync again, turn Cloud on above.",
  perSyncNote: "These apply when Cloud is on.",
} as const;

function storage(): Storage | null {
  try {
    return (
      (globalThis as { window?: { localStorage?: Storage } }).window
        ?.localStorage ?? null
    );
  } catch {
    return null;
  }
}

/** Cached value, or null when nothing was ever recorded on this computer. */
export function readCachedCloudEnabled(): boolean | null {
  const raw = storage()?.getItem(CLOUD_SWITCH_CACHE_KEY);
  if (raw === "on") return true;
  if (raw === "off") return false;
  return null;
}

export function writeCachedCloudEnabled(enabled: boolean): void {
  try {
    storage()?.setItem(CLOUD_SWITCH_CACHE_KEY, enabled ? "on" : "off");
  } catch {
    // A full or blocked store only costs the cache-first paint.
  }
}

/** `cloudPaused` from a raw settings payload; null when absent or malformed. */
export function cloudEnabledFromSettings(raw: unknown): boolean | null {
  if (!raw || typeof raw !== "object") return null;
  const paused = (raw as Record<string, unknown>).cloudPaused;
  return typeof paused === "boolean" ? !paused : null;
}

/**
 * Read the switch from the host. Returns null when the host has no switch or
 * the read failed, so callers keep whatever they painted from cache.
 */
export async function loadCloudEnabled(
  adapter: PlatformAdapter | null | undefined,
): Promise<boolean | null> {
  if (!adapter?.isAvailable("canSync") || !adapter.sync.getCloudEnabled) {
    return null;
  }
  const res = await adapter.sync.getCloudEnabled();
  if (!res.ok || typeof res.value !== "boolean") return null;
  writeCachedCloudEnabled(res.value);
  return res.value;
}

/** Tell other surfaces in this window that the switch moved. */
export function announceCloudSwitch(enabled: boolean): void {
  writeCachedCloudEnabled(enabled);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(CLOUD_SWITCH_EVENT, { detail: { cloudEnabled: enabled } }),
  );
}

/** Subscribe to switch changes; returns the unsubscribe. */
export function onCloudSwitchChanged(
  handler: (enabled: boolean) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ cloudEnabled?: unknown }>).detail;
    if (typeof detail?.cloudEnabled === "boolean") handler(detail.cloudEnabled);
  };
  window.addEventListener(CLOUD_SWITCH_EVENT, listener);
  return () => window.removeEventListener(CLOUD_SWITCH_EVENT, listener);
}
