/**
 * Local presentation preferences for the embedded V2 shell.
 *
 * These values affect only visual treatment in this WebView (opacity and
 * density), or briefly bridge host-backed Dock state while it hydrates.
 * All host-affecting settings live in native menubar.json via SettingsApi.
 */

import {
  DEFAULT_WINDOW_TRANSPARENCY,
  MAX_WINDOW_OPACITY,
  MAX_SLIDER_WINDOW_OPACITY,
  MIN_SLIDER_WINDOW_OPACITY,
} from "./appearance-seam.js";

export type SettingsUiSize = "compact" | "default" | "large";

export interface ShellSettingsPrefs {
  showInDock: boolean;
  windowOpacity: number;
  uiSize: SettingsUiSize;
  /** Company names on channels/agents and emails on people, in the conversation rail. */
  showSidebarScopeLabels: boolean;
  /**
   * Rail pin order for this device. `null` means first run has not seeded
   * yet (default company + next most recently used). An empty array is an
   * explicit "nothing pinned".
   */
  pinnedCompanyIds: string[] | null;
  /** Most recently opened company first. Used only to seed pins. */
  companyRecentIds: string[];
}

export const SETTINGS_PREFS_KEY = "hq-work-settings-prefs";

export const DEFAULT_SETTINGS_PREFS: ShellSettingsPrefs = {
  showInDock: true,
  windowOpacity: MAX_WINDOW_OPACITY - DEFAULT_WINDOW_TRANSPARENCY,
  uiSize: "default",
  showSidebarScopeLabels: true,
  pinnedCompanyIds: null,
  companyRecentIds: [],
};

function parseIdList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUiSize(value: unknown): SettingsUiSize {
  return value === "compact" || value === "large" || value === "default"
    ? value
    : DEFAULT_SETTINGS_PREFS.uiSize;
}

function parseOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS_PREFS.windowOpacity;
  }
  // Preserve the existing supported opacity range while defaulting to solid.
  return Math.min(
    MAX_SLIDER_WINDOW_OPACITY,
    Math.max(MIN_SLIDER_WINDOW_OPACITY, Math.round(value)),
  );
}

export function parseSettingsPrefs(raw: unknown): ShellSettingsPrefs {
  const rec = isRecord(raw) ? raw : {};
  return {
    showInDock:
      typeof rec.showInDock === "boolean"
        ? rec.showInDock
        : DEFAULT_SETTINGS_PREFS.showInDock,
    windowOpacity: parseOpacity(rec.windowOpacity),
    uiSize: parseUiSize(rec.uiSize),
    showSidebarScopeLabels:
      typeof rec.showSidebarScopeLabels === "boolean"
        ? rec.showSidebarScopeLabels
        : DEFAULT_SETTINGS_PREFS.showSidebarScopeLabels,
    pinnedCompanyIds:
      !Object.prototype.hasOwnProperty.call(rec, "pinnedCompanyIds") ||
      rec.pinnedCompanyIds == null
        ? null
        : parseIdList(rec.pinnedCompanyIds, 6),
    companyRecentIds: parseIdList(rec.companyRecentIds, 12),
  };
}

/**
 * Default storage for the prefs helpers.
 *
 * Prefer the DOM's `window.localStorage` over the bare global: Node 26 defines
 * a built-in `globalThis.localStorage` that is undefined unless the runtime was
 * started with `--localstorage-file`, and it shadows the DOM global. Reading
 * the bare global there silently resolves to `undefined`, so stored preferences
 * (UI size, window opacity) never apply. In a real webview both names are the
 * same object, so this changes nothing at runtime.
 */
function defaultStorage(): Storage | undefined {
  return (
    (globalThis as { window?: { localStorage?: Storage } }).window?.localStorage ??
    (globalThis.localStorage as Storage | undefined)
  );
}

export function readSettingsPrefs(
  storage: Pick<Storage, "getItem"> | null | undefined = defaultStorage(),
): ShellSettingsPrefs {
  try {
    const raw = storage?.getItem(SETTINGS_PREFS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS_PREFS };
    return parseSettingsPrefs(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_SETTINGS_PREFS };
  }
}

export function writeSettingsPrefs(
  patch: Partial<ShellSettingsPrefs>,
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | null
    | undefined = defaultStorage(),
): ShellSettingsPrefs {
  const current = readSettingsPrefs(storage);
  const next: ShellSettingsPrefs = {
    ...current,
    ...patch,
  };
  try {
    storage?.setItem(SETTINGS_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}

/**
 * Interface size is a device-wide preference, like the colour theme. It used
 * to live in the prefs blob, which the shell writes through tenant-scoped
 * storage — so a size chosen while a company was open was invisible from Home
 * (a different tenant scope) and Settings fell back to Default (QA-074).
 */
export const UI_SIZE_STORAGE_KEY = "hq-work-ui-size";

export function readStoredUiSize(
  storage: Pick<Storage, "getItem"> | null | undefined = defaultStorage(),
  legacy?: Pick<Storage, "getItem"> | null,
): SettingsUiSize {
  try {
    const raw = storage?.getItem(UI_SIZE_STORAGE_KEY);
    if (raw === "compact" || raw === "default" || raw === "large") return raw;
  } catch {
    /* private mode */
  }
  // Before the device key existed the size lived in the (tenant) prefs blob.
  return legacy ? readSettingsPrefs(legacy).uiSize : DEFAULT_SETTINGS_PREFS.uiSize;
}

export function writeStoredUiSize(
  size: SettingsUiSize,
  storage: Pick<Storage, "setItem"> | null | undefined = defaultStorage(),
): SettingsUiSize {
  const next = parseUiSize(size);
  try {
    storage?.setItem(UI_SIZE_STORAGE_KEY, next);
  } catch {
    /* private mode */
  }
  return next;
}
