/**
 * Local presentation preferences for the embedded V2 shell.
 *
 * These values affect only visual treatment in this WebView (density), or
 * briefly bridge host-backed Dock state while it hydrates. Window opacity and
 * theme are NOT here: they live in the one Appearance store
 * (`appearance-store.ts`). A legacy `windowOpacity` field in old records is
 * ignored.
 * All host-affecting settings live in native menubar.json via SettingsApi.
 */

export type SettingsUiSize = "compact" | "default" | "large";

export interface ShellSettingsPrefs {
  showInDock: boolean;
  uiSize: SettingsUiSize;
  /** Company names on channels/agents and emails on people, in the conversation rail. */
  showSidebarScopeLabels: boolean;
}

export const SETTINGS_PREFS_KEY = "hq-work-settings-prefs";

export const DEFAULT_SETTINGS_PREFS: ShellSettingsPrefs = {
  showInDock: true,
  uiSize: "default",
  showSidebarScopeLabels: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUiSize(value: unknown): SettingsUiSize {
  return value === "compact" || value === "large" || value === "default"
    ? value
    : DEFAULT_SETTINGS_PREFS.uiSize;
}

export function parseSettingsPrefs(raw: unknown): ShellSettingsPrefs {
  const rec = isRecord(raw) ? raw : {};
  return {
    showInDock:
      typeof rec.showInDock === "boolean"
        ? rec.showInDock
        : DEFAULT_SETTINGS_PREFS.showInDock,
    uiSize: parseUiSize(rec.uiSize),
    showSidebarScopeLabels:
      typeof rec.showSidebarScopeLabels === "boolean"
        ? rec.showSidebarScopeLabels
        : DEFAULT_SETTINGS_PREFS.showSidebarScopeLabels,
  };
}

/**
 * Default storage for the prefs helpers.
 *
 * Prefer the DOM's `window.localStorage` over the bare global: Node 26 defines
 * a built-in `globalThis.localStorage` that is undefined unless the runtime was
 * started with `--localstorage-file`, and it shadows the DOM global. Reading
 * the bare global there silently resolves to `undefined`, so stored preferences
 * (UI size) never apply. In a real webview both names are the
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
