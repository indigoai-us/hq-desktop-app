/**
 * The shell's app-wide keyboard bindings. The table (ids, keys, labels,
 * groups) lives here; the shell supplies what each binding does.
 */
import { CREATE_MENU_ITEMS, type CreateMenuAction } from "../../chat/create-menu.js";
import type { ShortcutBinding } from "../../common/keyboard-shortcuts.js";
import { advertisedShortcut } from "../advertised-shortcuts.js";
import { RAIL_SHORTCUT_COUNT } from "../app-rail.js";

/** What each shell shortcut does. Supplied by DesktopApp. */
export interface ShellShortcutActions {
  /** ⌘K: close the cheat sheet and toggle the palette. */
  togglePalette(): void;
  openSettings(): void;
  openAtlas(): void;
  /** ⌘/: close the palette and toggle the cheat sheet. */
  toggleCheatSheet(): void;
  /** Escape: close the cheat sheet if open; false declines the key. */
  closeCheatSheet(): boolean;
  /** ⌘1–⌘9: select the rail item at that position (0-based). */
  selectRailIndex(index: number): void;
  stepConversation(delta: 1 | -1): void;
  openNewMessage(): void;
  openNewChannel(): void;
  openNewAgent(): void;
  openNewChat(): void;
  openHistory(): void;
  openSearch(): void;
}

/** The keys the create menu advertises for an action. */
export function createMenuKeys(action: CreateMenuAction): string {
  return CREATE_MENU_ITEMS.find((item) => item.id === action)!.keys;
}

/**
 * App-wide bindings. Ids double as the native View-menu payload ids
 * (`shortcut:invoke` → `runShortcut(id)`), so keep them stable.
 */
export function buildShellShortcuts(actions: ShellShortcutActions): ShortcutBinding[] {
  return [
    {
      id: "palette.toggle",
      keys: advertisedShortcut("palette.toggle").keys,
      label: advertisedShortcut("palette.toggle").label,
      group: "General",
      run: () => actions.togglePalette(),
    },
    {
      id: "view.settings",
      keys: advertisedShortcut("view.settings").keys,
      label: advertisedShortcut("view.settings").label,
      group: "General",
      run: () => actions.openSettings(),
    },
    {
      id: "view.atlas",
      keys: advertisedShortcut("view.atlas").keys,
      label: advertisedShortcut("view.atlas").label,
      group: "Views",
      run: () => actions.openAtlas(),
    },
    {
      id: "help.shortcuts",
      keys: "Mod+/",
      label: "Keyboard shortcuts",
      group: "General",
      // The composer holds focus for most of a session; the cheat sheet is
      // exactly what someone reaches for while typing, so it must not be
      // gated behind blurring the input first.
      allowInInput: true,
      run: () => actions.toggleCheatSheet(),
    },
    {
      id: "help.close",
      keys: "Escape",
      label: "Close this sheet",
      group: "General",
      allowInInput: true,
      // Escape belongs to whichever overlay is open; only claim it for the
      // cheat sheet, otherwise decline so other components keep it.
      run: () => actions.closeCheatSheet(),
    },
    // ⌘1–⌘9 select the rail item at that position (console-rail US-003).
    ...Array.from({ length: RAIL_SHORTCUT_COUNT }, (_, index) =>
      ({
        id: `view.rail.${index + 1}`,
        keys: `Mod+${index + 1}`,
        label:
          index === 0 ? "Home" : index === 1 ? "Meetings" : `Rail item ${index + 1}`,
        group: "Views",
        run: () => actions.selectRailIndex(index),
      }) satisfies ShortcutBinding,
    ),
    {
      id: "conversation.next",
      keys: "Mod+Shift+]",
      label: "Next conversation",
      group: "Conversations",
      run: () => actions.stepConversation(1),
    },
    {
      id: "conversation.previous",
      keys: "Mod+Shift+[",
      label: "Previous conversation",
      group: "Conversations",
      run: () => actions.stepConversation(-1),
    },
    {
      id: "create.message",
      keys: advertisedShortcut("create.message").keys,
      label: advertisedShortcut("create.message").label,
      group: "Conversations",
      run: () => actions.openNewMessage(),
    },
    {
      id: "create.channel",
      keys: createMenuKeys("channel"),
      label: "New channel",
      group: "Conversations",
      run: () => actions.openNewChannel(),
    },
    {
      id: "create.agent",
      keys: createMenuKeys("agent"),
      label: "New bot",
      group: "Conversations",
      run: () => actions.openNewAgent(),
    },
    {
      // ⌘N opens exactly one thing, the search-first create dialog.
      id: "chat.new",
      keys: advertisedShortcut("chat.new").keys,
      label: advertisedShortcut("chat.new").label,
      group: "Conversations",
      run: () => actions.openNewChat(),
    },
    {
      id: "search.messages",
      keys: "Mod+F",
      label: "Search messages",
      group: "Conversations",
      run: () => actions.openHistory(),
    },
    {
      id: "search.conversations",
      keys: "Mod+Shift+F",
      label: "Jump to conversation",
      group: "Conversations",
      run: () => actions.openSearch(),
    },
  ];
}
