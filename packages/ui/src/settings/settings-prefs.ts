/**
 * Local Settings preferences for the V2 shell.
 *
 * Host-backed stores (Tauri get_settings) are not on this desktop yet.
 * Persist the prototype toggles locally so they survive reloads, and let
 * the host overlay them onto real seams when those exist.
 */

export type SettingsUiSize = "compact" | "default" | "large";

export interface ShellSettingsPrefs {
  launchAtLogin: boolean;
  showInDock: boolean;
  menubarAccess: boolean;
  desktopWidget: boolean;
  notifyComplete: boolean;
  notifySync: boolean;
  notifyShare: boolean;
  notifyDm: boolean;
  quietHours: boolean;
  sounds: boolean;
  syncOnLaunch: boolean;
  autoSync: boolean;
  instantSync: boolean;
  syncPersonalVault: boolean;
  meetingDetection: boolean;
  meetingPlatforms: Record<string, boolean>;
  recordingCompanyId: string | null;
  autoUpdates: boolean;
  windowOpacity: number;
  uiSize: SettingsUiSize;
  defaultCompanyId: string | null;
  companySync: Record<string, boolean>;
}

export const SETTINGS_PREFS_KEY = "hq-work-settings-prefs";

export const DEFAULT_MEETING_PLATFORMS: Record<string, boolean> = {
  Zoom: true,
  "Google Meet": true,
  Teams: false,
};

export const DEFAULT_SETTINGS_PREFS: ShellSettingsPrefs = {
  launchAtLogin: true,
  showInDock: true,
  menubarAccess: true,
  desktopWidget: true,
  notifyComplete: true,
  notifySync: true,
  notifyShare: true,
  notifyDm: true,
  quietHours: false,
  sounds: false,
  syncOnLaunch: true,
  autoSync: true,
  instantSync: true,
  syncPersonalVault: true,
  meetingDetection: true,
  meetingPlatforms: { ...DEFAULT_MEETING_PLATFORMS },
  recordingCompanyId: null,
  autoUpdates: true,
  windowOpacity: 80,
  uiSize: "default",
  defaultCompanyId: null,
  companySync: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolPref(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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
  return Math.min(100, Math.max(50, Math.round(value)));
}

function parseMeetingPlatforms(value: unknown): Record<string, boolean> {
  const next = { ...DEFAULT_MEETING_PLATFORMS };
  if (!isRecord(value)) return next;
  for (const key of Object.keys(next)) {
    const raw = value[key];
    if (typeof raw === "boolean") next[key] = raw;
  }
  return next;
}

export function parseSettingsPrefs(raw: unknown): ShellSettingsPrefs {
  const rec = isRecord(raw) ? raw : {};
  const companySync: Record<string, boolean> = {};
  if (isRecord(rec.companySync)) {
    for (const [key, value] of Object.entries(rec.companySync)) {
      if (typeof value === "boolean") companySync[key] = value;
    }
  }
  return {
    launchAtLogin: boolPref(
      rec.launchAtLogin,
      DEFAULT_SETTINGS_PREFS.launchAtLogin,
    ),
    showInDock: boolPref(rec.showInDock, DEFAULT_SETTINGS_PREFS.showInDock),
    menubarAccess: boolPref(
      rec.menubarAccess,
      DEFAULT_SETTINGS_PREFS.menubarAccess,
    ),
    desktopWidget: boolPref(
      rec.desktopWidget,
      DEFAULT_SETTINGS_PREFS.desktopWidget,
    ),
    notifyComplete: boolPref(
      rec.notifyComplete,
      DEFAULT_SETTINGS_PREFS.notifyComplete,
    ),
    notifySync: boolPref(rec.notifySync, DEFAULT_SETTINGS_PREFS.notifySync),
    notifyShare: boolPref(rec.notifyShare, DEFAULT_SETTINGS_PREFS.notifyShare),
    notifyDm: boolPref(rec.notifyDm, DEFAULT_SETTINGS_PREFS.notifyDm),
    quietHours: boolPref(rec.quietHours, DEFAULT_SETTINGS_PREFS.quietHours),
    sounds: boolPref(rec.sounds, DEFAULT_SETTINGS_PREFS.sounds),
    syncOnLaunch: boolPref(
      rec.syncOnLaunch,
      DEFAULT_SETTINGS_PREFS.syncOnLaunch,
    ),
    autoSync: boolPref(rec.autoSync, DEFAULT_SETTINGS_PREFS.autoSync),
    instantSync: boolPref(rec.instantSync, DEFAULT_SETTINGS_PREFS.instantSync),
    syncPersonalVault: boolPref(
      rec.syncPersonalVault,
      DEFAULT_SETTINGS_PREFS.syncPersonalVault,
    ),
    meetingDetection: boolPref(
      rec.meetingDetection,
      DEFAULT_SETTINGS_PREFS.meetingDetection,
    ),
    meetingPlatforms: parseMeetingPlatforms(rec.meetingPlatforms),
    recordingCompanyId:
      typeof rec.recordingCompanyId === "string" &&
      rec.recordingCompanyId.trim()
        ? rec.recordingCompanyId.trim()
        : null,
    autoUpdates: boolPref(rec.autoUpdates, DEFAULT_SETTINGS_PREFS.autoUpdates),
    windowOpacity: parseOpacity(rec.windowOpacity),
    uiSize: parseUiSize(rec.uiSize),
    defaultCompanyId:
      typeof rec.defaultCompanyId === "string" && rec.defaultCompanyId.trim()
        ? rec.defaultCompanyId.trim()
        : null,
    companySync,
  };
}

export function readSettingsPrefs(
  storage:
    Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage,
): ShellSettingsPrefs {
  try {
    const raw = storage?.getItem(SETTINGS_PREFS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS_PREFS, companySync: {} };
    return parseSettingsPrefs(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_SETTINGS_PREFS, companySync: {} };
  }
}

export function writeSettingsPrefs(
  patch: Partial<ShellSettingsPrefs>,
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | null
    | undefined = globalThis.localStorage,
): ShellSettingsPrefs {
  const current = readSettingsPrefs(storage);
  const next: ShellSettingsPrefs = {
    ...current,
    ...patch,
    companySync: { ...current.companySync, ...(patch.companySync ?? {}) },
  };
  try {
    storage?.setItem(SETTINGS_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}
