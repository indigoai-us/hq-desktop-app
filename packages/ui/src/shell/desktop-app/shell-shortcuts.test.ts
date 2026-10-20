import { describe, expect, it, vi, type Mock } from "vitest";

import { CREATE_MENU_ITEMS } from "../../chat/create-menu.js";
import { advertisedShortcut } from "../advertised-shortcuts.js";
import { RAIL_SHORTCUT_COUNT } from "../app-rail.js";
import {
  buildShellShortcuts,
  createMenuKeys,
  type ShellShortcutActions,
} from "./shell-shortcuts.js";

function actions(): { [K in keyof ShellShortcutActions]: Mock<ShellShortcutActions[K]> } {
  return {
    togglePalette: vi.fn<() => void>(),
    openSettings: vi.fn<() => void>(),
    openAtlas: vi.fn<() => void>(),
    toggleCheatSheet: vi.fn<() => void>(),
    closeCheatSheet: vi.fn<() => boolean>(() => true),
    selectRailIndex: vi.fn<(index: number) => void>(),
    stepConversation: vi.fn<(delta: 1 | -1) => void>(),
    openNewMessage: vi.fn<() => void>(),
    openNewChannel: vi.fn<() => void>(),
    openNewAgent: vi.fn<() => void>(),
    openNewChat: vi.fn<() => void>(),
    openHistory: vi.fn<() => void>(),
    openSearch: vi.fn<() => void>(),
  };
}

describe("createMenuKeys", () => {
  it("reads the create menu's keys", () => {
    for (const item of CREATE_MENU_ITEMS) expect(createMenuKeys(item.id)).toBe(item.keys);
  });
});

describe("buildShellShortcuts", () => {
  it("keeps the binding ids stable (they are native View-menu payload ids)", () => {
    const ids = buildShellShortcuts(actions()).map((binding) => binding.id);
    expect(ids).toEqual([
      "palette.toggle",
      "view.settings",
      "view.atlas",
      "help.shortcuts",
      "help.close",
      ...Array.from({ length: RAIL_SHORTCUT_COUNT }, (_, index) => `view.rail.${index + 1}`),
      "conversation.next",
      "conversation.previous",
      "create.message",
      "create.channel",
      "create.agent",
      "chat.new",
      "search.messages",
      "search.conversations",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the advertised and create-menu keys", () => {
    const byId = new Map(buildShellShortcuts(actions()).map((binding) => [binding.id, binding]));
    for (const id of ["palette.toggle", "view.settings", "view.atlas", "create.message", "chat.new"]) {
      expect(byId.get(id)?.keys).toBe(advertisedShortcut(id).keys);
      expect(byId.get(id)?.label).toBe(advertisedShortcut(id).label);
    }
    expect(byId.get("create.channel")?.keys).toBe(createMenuKeys("channel"));
    expect(byId.get("create.agent")?.keys).toBe(createMenuKeys("agent"));
    expect(byId.get("view.rail.1")).toMatchObject({ keys: "Mod+1", label: "Home" });
    expect(byId.get("view.rail.2")).toMatchObject({ keys: "Mod+2", label: "Meetings" });
    expect(byId.get("view.rail.3")?.label).toBe("Rail item 3");
  });

  it("lets only the cheat-sheet keys fire from an input", () => {
    const inInput = buildShellShortcuts(actions())
      .filter((binding) => binding.allowInInput)
      .map((binding) => binding.id);
    expect(inInput).toEqual(["help.shortcuts", "help.close"]);
  });

  it("routes each binding to its action", () => {
    const a = actions();
    const byId = new Map(buildShellShortcuts(a).map((binding) => [binding.id, binding]));
    const run = (id: string) => byId.get(id)!.run(null);
    const routes: Array<[string, keyof ShellShortcutActions]> = [
      ["palette.toggle", "togglePalette"],
      ["view.settings", "openSettings"],
      ["view.atlas", "openAtlas"],
      ["help.shortcuts", "toggleCheatSheet"],
      ["create.message", "openNewMessage"],
      ["create.channel", "openNewChannel"],
      ["create.agent", "openNewAgent"],
      ["chat.new", "openNewChat"],
      ["search.messages", "openHistory"],
      ["search.conversations", "openSearch"],
    ];
    for (const [id, action] of routes) {
      run(id);
      expect(a[action], id).toHaveBeenCalledTimes(1);
    }
    run("view.rail.4");
    expect(a.selectRailIndex).toHaveBeenCalledWith(3);
    run("conversation.next");
    run("conversation.previous");
    expect(a.stepConversation.mock.calls).toEqual([[1], [-1]]);
  });

  it("passes Escape's claim or decline back to the registry", () => {
    const a = actions();
    const close = buildShellShortcuts(a).find((binding) => binding.id === "help.close")!;
    expect(close.run(null)).toBe(true);
    a.closeCheatSheet.mockReturnValue(false);
    expect(close.run(null)).toBe(false);
  });
});
