/**
 * Shortcuts advertised in Account Settings (QA-077).
 *
 * This table is the single source for both the Settings "Keyboard shortcuts"
 * list and the shell bindings that back it. `bindingId` names the registry
 * binding DesktopApp registers with exactly these `keys`; a row with
 * `bindingId: null` is a native editing chord the webview handles itself.
 * Adding a row without a matching shell binding fails
 * `advertised-shortcuts.test.ts`.
 */

import { formatShortcut } from "../common/keyboard-shortcuts.js";

export interface AdvertisedShortcut {
  /** Settings row id (persisted in the account cache). */
  id: string;
  /** Registry binding id in DesktopApp, or null for native editing chords. */
  bindingId: string | null;
  label: string;
  /** Registry grammar, e.g. "Mod+Shift+A". */
  keys: string;
}

export const ADVERTISED_SHORTCUTS: readonly AdvertisedShortcut[] = [
  { id: "palette", bindingId: "palette.toggle", label: "Command palette", keys: "Mod+K" },
  { id: "home", bindingId: "view.rail.1", label: "Home", keys: "Mod+1" },
  { id: "atlas", bindingId: "view.atlas", label: "Open Atlas", keys: "Mod+Shift+A" },
  { id: "new-message", bindingId: "create.message", label: "New message", keys: "Mod+N" },
  { id: "settings", bindingId: "view.settings", label: "Settings", keys: "Mod+," },
  { id: "select-all", bindingId: null, label: "Select all in the composer", keys: "Mod+A" },
];

/** The search-first create dialog keeps its own chord, separate from ⌘N. */
export const NEW_CHAT_KEYS = "Mod+Shift+K";

export function advertisedShortcut(bindingId: string): AdvertisedShortcut {
  const row = ADVERTISED_SHORTCUTS.find((entry) => entry.bindingId === bindingId);
  if (!row) throw new Error(`No advertised shortcut for ${bindingId}`);
  return row;
}

/** Settings rows with macOS glyph labels, e.g. "⌘⇧A". */
export function advertisedShortcutRows(
  mac = true,
): { id: string; label: string; keys: string }[] {
  return ADVERTISED_SHORTCUTS.map((row) => ({
    id: row.id,
    label: row.label,
    keys: formatShortcut(row.keys, mac),
  }));
}

export type AtlasShortcutTarget =
  | { kind: "company"; companyUid: string }
  | { kind: "none" };

/**
 * Which company ⌘⇧A opens: the active company when one is open, else the
 * first company on the rail. With no company at all the caller shows a toast.
 */
export function atlasShortcutTarget(
  activeCompanyUid: string | null | undefined,
  railCompanyUids: readonly string[],
): AtlasShortcutTarget {
  const active = activeCompanyUid?.trim();
  if (active) return { kind: "company", companyUid: active };
  const first = railCompanyUids.find((uid) => uid.trim());
  if (first) return { kind: "company", companyUid: first.trim() };
  return { kind: "none" };
}
