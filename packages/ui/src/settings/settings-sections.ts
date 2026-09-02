/**
 * Settings section index — extracted from the desktop-alt shell `route.ts`
 * (US-020 single-pane Settings). The shell route stays host-owned; this file
 * carries only the section vocabulary + path formatting the Settings page
 * itself needs.
 */

export type SettingsTab =
  | "sync"
  | "notifications"
  | "widget"
  | "updates"
  | "general"
  | "appearance"
  | "meetings";

export const DEFAULT_SETTINGS_TAB: SettingsTab = "sync";

/** Settings section index — the in-page single-pane list (US-020), also the ⌘K entries. */
export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsTab;
  label: string;
  note?: string;
}> = [
  { id: "sync", label: "Sync" },
  { id: "notifications", label: "Notifications" },
  { id: "widget", label: "Notifications widget" },
  { id: "updates", label: "Updates" },
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "meetings", label: "Meetings" },
];

export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/** Strip Windows verbatim prefixes for display; storage keeps them intact. */
export function normalizeNativePath(path: string): string {
  const trimmed = path.trim();
  const windowsUncPrefix = "\\\\?\\UNC\\";
  const windowsVerbatimPrefix = "\\\\?\\";
  if (trimmed.toUpperCase().startsWith(windowsUncPrefix.toUpperCase())) {
    return "\\\\" + trimmed.slice(windowsUncPrefix.length);
  }
  if (trimmed.startsWith(windowsVerbatimPrefix)) {
    return trimmed.slice(windowsVerbatimPrefix.length);
  }
  return trimmed;
}

export function formatHqFolderMeta(path: string | null | undefined): string {
  const trimmed = path ? normalizeNativePath(path) : "";
  if (!trimmed) return "HQ folder";
  return trimmed.replace(/^\/Users\/[^/]+/, "~");
}
