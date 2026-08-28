/**
 * V2 Cloud Connected/Off state (hq-desktop-v2 US-001 / US-016).
 *
 * "Cloud Off" pauses sync on THIS device. The flag is persisted in the host's
 * settings store (`cloudPaused`, via the injected settings io) — the SAME
 * store the native sync gates read, so every sync path obeys the switch, not
 * just the surface that renders it.
 *
 * localStorage is kept only as (a) the legacy pre-settings store, migrated
 * into settings on first read, and (b) a synchronous mirror so the titlebar
 * can render without waiting for the settings round-trip. It is never the
 * source of truth for whether sync runs.
 *
 * Ported to the platform seam: instead of the desktop `get_settings` command,
 * the caller supplies a `CloudSettingsIo` (built on `@hq/platform`'s
 * `adapter.settings.getSettings()` plus the host's settings writer). All
 * mutating/reading entry points take that io explicitly so the module stays
 * platform-pure and unit-testable.
 */

export const CLOUD_PAUSED_STORAGE_KEY = "hq-sync.desktop.cloud-paused.v1";

/** Window event fired whenever the paused flag changes (detail: boolean). */
export const CLOUD_PAUSED_CHANGED_EVENT = "hq:cloud-paused-changed";

type IoResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: "unavailable" | "error";
      code?: string;
      message?: string;
    };

/** AdapterResult-shaped settings seam (matches `@hq/platform` contracts). */
export interface CloudSettingsIo {
  getSettings(): Promise<
    IoResult<{ cloudPaused?: boolean | null } & Record<string, unknown>>
  >;
  updateSettings(patch: Record<string, unknown>): Promise<IoResult<void>>;
}

/** Minimal storage surface so tests can inject a memory store. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CloudMirrorEnv {
  storage?: StorageLike | null;
  dispatch?: (paused: boolean) => void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function defaultDispatch(paused: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(CLOUD_PAUSED_CHANGED_EVENT, { detail: paused }),
  );
}

/** Pure parse so the storage contract is unit-testable. */
export function parseCloudPaused(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Pure resolution of the settings-backed flag against the legacy localStorage
 * value (unit-testable): an explicit boolean in settings wins; when settings
 * has never stored the flag, the legacy value applies and — when paused —
 * must be migrated into settings so the native gates see it.
 */
export function resolveCloudPaused(
  settingsValue: unknown,
  legacyRaw: string | null,
): { paused: boolean; migrateLegacy: boolean } {
  if (typeof settingsValue === "boolean") {
    return { paused: settingsValue, migrateLegacy: false };
  }
  const legacy = parseCloudPaused(legacyRaw);
  return { paused: legacy, migrateLegacy: legacy };
}

/** Synchronous read of the localStorage MIRROR (render-fast, not authoritative). */
export function readCloudPaused(env: CloudMirrorEnv = {}): boolean {
  try {
    const storage = env.storage !== undefined ? env.storage : defaultStorage();
    return parseCloudPaused(storage?.getItem(CLOUD_PAUSED_STORAGE_KEY) ?? null);
  } catch {
    // Storage unavailable → never paused (sync keeps working).
    return false;
  }
}

function mirrorCloudPaused(paused: boolean, env: CloudMirrorEnv): void {
  try {
    const storage = env.storage !== undefined ? env.storage : defaultStorage();
    if (paused) storage?.setItem(CLOUD_PAUSED_STORAGE_KEY, "1");
    else storage?.removeItem(CLOUD_PAUSED_STORAGE_KEY);
  } catch {
    // Best-effort mirror; the settings store still applies.
  }
  (env.dispatch ?? defaultDispatch)(paused);
}

/**
 * Authoritative async read: host settings via the io, migrating a legacy
 * localStorage pause into settings on first sight so the native sync gates
 * honor a pause set before this write-through existed.
 */
export async function loadCloudPaused(
  io: CloudSettingsIo,
  env: CloudMirrorEnv = {},
): Promise<boolean> {
  const res = await io.getSettings().catch(() => null);
  if (!res || !res.ok) {
    // Settings unreachable/unavailable → fall back to the mirror; no migration.
    return readCloudPaused(env);
  }
  const settingsValue: unknown = res.value?.cloudPaused;
  let legacyRaw: string | null = null;
  try {
    const storage = env.storage !== undefined ? env.storage : defaultStorage();
    legacyRaw = storage?.getItem(CLOUD_PAUSED_STORAGE_KEY) ?? null;
  } catch {
    legacyRaw = null;
  }
  const { paused, migrateLegacy } = resolveCloudPaused(
    settingsValue,
    legacyRaw,
  );
  if (migrateLegacy) {
    await io.updateSettings({ cloudPaused: paused }).catch(() => undefined);
  }
  mirrorCloudPaused(paused, env);
  return paused;
}

/**
 * Write-through toggle: persist to the host settings store (the store the
 * native gates read) and update the localStorage mirror + change event.
 */
export async function setCloudPaused(
  io: CloudSettingsIo,
  paused: boolean,
  env: CloudMirrorEnv = {},
): Promise<void> {
  mirrorCloudPaused(paused, env);
  const res = await io.updateSettings({ cloudPaused: paused });
  if (!res.ok) {
    throw new Error(res.message ?? `cloud-paused save failed (${res.reason})`);
  }
}
