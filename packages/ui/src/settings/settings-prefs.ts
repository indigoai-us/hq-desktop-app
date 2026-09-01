/**
 * Local presentation preferences for the embedded V2 shell.
 *
 * These values affect only visual treatment in this WebView (opacity and
 * density), or briefly bridge host-backed Dock/widget state while it hydrates.
 * All host-affecting settings live in native menubar.json via SettingsApi.
 */

export type SettingsUiSize = "compact" | "default" | "large";

export interface ShellSettingsPrefs {
  showInDock: boolean;
  desktopWidget: boolean;
  windowOpacity: number;
  uiSize: SettingsUiSize;
}

export const SETTINGS_PREFS_KEY = "hq-work-settings-prefs";

export const DEFAULT_SETTINGS_PREFS: ShellSettingsPrefs = {
  showInDock: true,
  desktopWidget: true,
  windowOpacity: 80,
  uiSize: "default",
};

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
  return Math.min(100, Math.max(50, Math.round(value)));
}

export function parseSettingsPrefs(raw: unknown): ShellSettingsPrefs {
  const rec = isRecord(raw) ? raw : {};
  return {
    showInDock:
      typeof rec.showInDock === "boolean"
        ? rec.showInDock
        : DEFAULT_SETTINGS_PREFS.showInDock,
    desktopWidget:
      typeof rec.desktopWidget === "boolean"
        ? rec.desktopWidget
        : DEFAULT_SETTINGS_PREFS.desktopWidget,
    windowOpacity: parseOpacity(rec.windowOpacity),
    uiSize: parseUiSize(rec.uiSize),
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
