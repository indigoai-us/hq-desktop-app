/**
 * Messages "+" create menu (US-017).
 *
 * New company is intentionally absent: it lives only in the More companies
 * popover. Shortcuts: ⌘N, ⇧⌘N, ⌥⌘N.
 */

export type CreateMenuAction = "message" | "channel" | "agent";

export interface CreateMenuItem {
  id: CreateMenuAction;
  label: string;
  keys: string;
}

export const CREATE_MENU_ITEMS: readonly CreateMenuItem[] = [
  { id: "message", label: "New message", keys: "Mod+N" },
  { id: "channel", label: "New channel", keys: "Mod+Shift+N" },
  { id: "agent", label: "New agent", keys: "Mod+Alt+N" },
];

export function createMenuHasCompany(): boolean {
  return CREATE_MENU_ITEMS.some((item) => item.label.toLowerCase().includes("company"));
}
