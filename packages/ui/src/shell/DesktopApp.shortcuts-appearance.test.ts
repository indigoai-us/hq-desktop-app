// @vitest-environment happy-dom

/**
 * Shell-level regressions for the keyboard/appearance work:
 *
 *  - CRITICAL: the opacity apply on mount must be skipped when the desktop
 *    appearance host is installed, or the round-trip resets the user's theme.
 *  - ⌘/ must reach the cheat sheet from the composer (allowInInput).
 *  - Escape must still DECLINE when no cheat sheet is open.
 *  - Company scope moved from ⌘0/⌘1–5 into the command palette; those palette
 *    entries are now the only scope-switching path, so they must not vanish.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { listShortcuts } from "../common/keyboard-shortcuts.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

const ROW: ConversationRow = {
  id: "ch:setup",
  kind: "channel",
  title: "setup",
  channelId: "setup",
  channelScope: "personal",
  companyUid: null,
} as ConversationRow;

const COMPANIES = [
  { slug: "acme", displayName: "Acme", kind: "company", cloudUid: "cmp_acme" },
  { slug: "personal", displayName: "Personal", kind: "personal", cloudUid: "cmp_personal" },
] as unknown as Workspace[];

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      runCardAction: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountApp(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "t@example.com" },
      coreFixtures: false,
      initialRow: ROW,
      companies: COMPANIES,
    },
  });
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const root = () => document.documentElement;

beforeEach(() => {
  delete root().dataset.windowTransparency;
  delete root().dataset.forceTheme;
  localStorage.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  delete root().dataset.windowTransparency;
  delete root().dataset.forceTheme;
  localStorage.clear();
});

describe("appearance host guard on mount", () => {
  it("does not ask the host to re-apply opacity (which would reset the theme)", async () => {
    // Host installed: it wrote its own transparency AND the user's forced Light.
    root().dataset.windowTransparency = "35";
    root().dataset.forceTheme = "light";
    // The shell re-applies its own stored theme on mount; keep them agreeing
    // so the assertion below is about the opacity round-trip, nothing else.
    localStorage.setItem("hq-work-color-theme", "light");
    const requests: unknown[] = [];
    const onRequest = (event: Event) =>
      requests.push((event as CustomEvent).detail);
    window.addEventListener("hq:appearance-request", onRequest);

    mountApp();
    await settle();
    window.removeEventListener("hq:appearance-request", onRequest);

    expect(requests).toEqual([]);
    // The user's forced Light survived the launch.
    expect(root().dataset.forceTheme).toBe("light");
  });

  it("still drives the vars itself when no host is installed", async () => {
    const requests: unknown[] = [];
    const onRequest = (event: Event) =>
      requests.push((event as CustomEvent).detail);
    window.addEventListener("hq:appearance-request", onRequest);

    mountApp();
    await settle();
    window.removeEventListener("hq:appearance-request", onRequest);

    expect(requests.length).toBeGreaterThan(0);
  });
});

describe("shell shortcut reachability", () => {
  it("opens the cheat sheet from an editable field (⌘/ is allowInInput)", async () => {
    mountApp();
    await settle();

    const help = listShortcuts().find((b) => b.id === "help.shortcuts");
    expect(help).toBeTruthy();
    expect(help!.allowInInput).toBe(true);

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "/",
        code: "Slash",
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    expect(
      document.querySelector('[data-testid="shortcut-cheat-sheet"]'),
    ).toBeTruthy();
    textarea.remove();
  });

  it("Escape still declines when nothing is open", async () => {
    mountApp();
    await settle();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(escape);
    // `run` returned false → the registry must leave the event untouched so
    // other overlays keep Escape.
    expect(escape.defaultPrevented).toBe(false);
  });
});

describe("command palette scope rows", () => {
  // `scopeFromHotkey` was deleted and ⌘0/⌘1–5 now switch views; the palette is
  // the ONLY remaining way to change company scope.
  it("offers 'Show all companies' and a row per cloud-backed company", async () => {
    mountApp();
    await settle();

    const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();

    const palette = document.querySelector('[data-testid="command-palette"]');
    expect(palette).toBeTruthy();
    const text = palette!.textContent ?? "";
    expect(text).toContain("Show all companies");
    expect(text).toContain("Show only Acme");
    // Personal is not a scope row.
    expect(text).not.toContain("Show only Personal");
  });
});
