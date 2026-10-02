// @vitest-environment happy-dom

/**
 * QA-077: every shortcut Settings advertises is bound by the shell with the
 * same chord and triggers its action. ⌘⇧A opens Atlas for the active company
 * (first rail company on Home, toast with none); ⌘N is bound exactly once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { listShortcuts, parseKeys } from "../common/keyboard-shortcuts.js";
import { DEFAULT_SHORTCUTS } from "../account/account-pages.js";
import { CREATE_MENU_ITEMS } from "../chat/create-menu.js";
import {
  ADVERTISED_SHORTCUTS,
  NEW_CHAT_KEYS,
  atlasShortcutTarget,
} from "./advertised-shortcuts.js";
import { dismissToast, toastItems } from "./toast-stack.svelte.js";
import type { Workspace } from "../chat/workspaces.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const COMPANIES = [
  { slug: "acme", displayName: "Acme", kind: "company", cloudUid: "cmp_acme" },
  { slug: "beta", displayName: "Beta", kind: "company", cloudUid: "cmp_beta" },
] as unknown as Workspace[];

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
      fetchDmThread: async () => ok(null),
    },
    meetings: {
      listAccounts: async () => ok([]),
      permissionsState: async () => ok(null),
    },
    appShell: { notificationPermissionState: async () => ok("default") },
    settings: { getSettings: async () => ok({}) },
  } as unknown as PlatformAdapter;
}

const memoryStorage = installMemoryLocalStorage();
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountShell(companies: Workspace[] = COMPANIES): Promise<void> {
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
      companies,
    },
  });
  await settle();
}

/** Fire a registry chord ("Mod+Shift+A") the way WebKit reports it. */
async function press(keys: string): Promise<KeyboardEvent> {
  const parsed = parseKeys(keys);
  const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
  const mod = parsed.mod;
  const key = parsed.key;
  const code = /^[a-z]$/.test(key)
    ? `Key${key.toUpperCase()}`
    : /^\d$/.test(key)
      ? `Digit${key}`
      : key === ","
        ? "Comma"
        : undefined;
  const event = new KeyboardEvent("keydown", {
    key: parsed.shift && key.length === 1 ? key.toUpperCase() : key,
    code,
    metaKey: (mod && mac) || parsed.meta,
    ctrlKey: (mod && !mac) || parsed.ctrl,
    shiftKey: parsed.shift,
    altKey: parsed.alt,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  await settle();
  return event;
}

/** "home", or "company:<label>" for the active company tile. */
function currentRail(): string | null {
  const active = host.querySelector('[data-testid="app-rail"] [aria-current="page"]');
  if (!active) return null;
  const id = active.getAttribute("data-rail-id");
  return id === "company" ? `company:${active.getAttribute("aria-label")}` : id;
}

/** Present and not under a `display: none` ancestor (the hidden chat slot). */
function shown(testId: string): boolean {
  let el: HTMLElement | null = host.ownerDocument.querySelector(`[data-testid="${testId}"]`);
  if (!el) return false;
  for (; el; el = el.parentElement) if (el.style.display === "none") return false;
  return true;
}

function clickCompany(label: string): void {
  host
    .querySelector<HTMLButtonElement>(`[data-testid="rail-company"][aria-label="${label}"]`)!
    .click();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  for (const toast of toastItems()) dismissToast(toast.id);
});

describe("advertised shortcut table (QA-077)", () => {
  it("is the Settings list", () => {
    expect(DEFAULT_SHORTCUTS.map((row) => row.id)).toEqual(
      ADVERTISED_SHORTCUTS.map((row) => row.id),
    );
    expect(DEFAULT_SHORTCUTS.find((row) => row.id === "atlas")?.keys).toBe("⌘⇧A");
  });

  it("picks the active company, else the first rail company, else none", () => {
    expect(atlasShortcutTarget("cmp_b", ["cmp_a"])).toEqual({ kind: "company", companyUid: "cmp_b" });
    expect(atlasShortcutTarget(null, ["cmp_a", "cmp_b"])).toEqual({ kind: "company", companyUid: "cmp_a" });
    expect(atlasShortcutTarget(null, [])).toEqual({ kind: "none" });
  });
});

describe("shell bindings for advertised shortcuts (QA-077)", () => {
  it("registers every advertised row with the advertised chord", async () => {
    await mountShell();
    const bound = listShortcuts();
    for (const row of ADVERTISED_SHORTCUTS) {
      if (!row.bindingId) continue;
      const binding = bound.find((b) => b.id === row.bindingId);
      expect(binding, row.id).toBeTruthy();
      expect(binding!.keys, row.id).toBe(row.keys);
    }
  });

  it("binds ⌘N exactly once, and the create dialog keeps its own chord", async () => {
    await mountShell();
    const bound = listShortcuts();
    expect(bound.filter((b) => b.keys === "Mod+N").map((b) => b.id)).toEqual(["create.message"]);
    expect(bound.find((b) => b.id === "chat.new")?.keys).toBe(NEW_CHAT_KEYS);
  });

  it("each advertised shell chord is consumed from Home", async () => {
    for (const row of ADVERTISED_SHORTCUTS) {
      if (!row.bindingId) continue;
      await mountShell();
      const event = await press(row.keys);
      expect(event.defaultPrevented, row.id).toBe(true);
      await unmount(component!);
      component = null;
      host.remove();
    }
  });

  it("⌘N opens the New message sheet", async () => {
    await mountShell();
    await press("Mod+N");
    await vi.waitFor(() => expect(shown("new-message-sheet")).toBe(true));
  });

  it("⌘N opens a visible New message sheet on a company page", async () => {
    await mountShell();
    clickCompany("Acme");
    await settle();
    await press("Mod+N");
    await vi.waitFor(() => expect(shown("new-message-sheet")).toBe(true));
    expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("⌘N, ⇧⌘N and ⌥⌘N are each bound once, with the Create menu chords", async () => {
    await mountShell();
    const bound = listShortcuts();
    for (const item of CREATE_MENU_ITEMS) {
      expect(bound.filter((b) => b.keys === item.keys).length, item.id).toBe(1);
    }
  });

  it("⇧⌘N opens New channel from a page without the Messages list", async () => {
    await mountShell();
    host.querySelector<HTMLButtonElement>('[data-testid="rail-telemetry"]')?.click();
    await settle();
    await press("Mod+Shift+N");
    await vi.waitFor(() =>
      expect(shown("new-channel-sheet")).toBe(true),
    );
  });

  it("⌘1 returns Home from a company page", async () => {
    await mountShell();
    await press("Mod+Shift+A");
    expect(currentRail()).toBe("company:Acme");
    await press("Mod+1");
    expect(currentRail()).toBe("home");
  });

  it("⌘⇧A on Home opens Atlas for the first rail company", async () => {
    await mountShell();
    expect(currentRail()).toBe("home");
    await press("Mod+Shift+A");
    expect(currentRail()).toBe("company:Acme");
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="atlas-landing"]')).not.toBeNull(),
    );
  });

  it("⌘⇧A on a company page opens Atlas for that company", async () => {
    await mountShell();
    clickCompany("Beta");
    await settle();
    await press("Mod+Shift+A");
    expect(currentRail()).toBe("company:Beta");
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="atlas-landing"]')).not.toBeNull(),
    );
  });

  it("⌘⇧A with no company shows a one-line toast", async () => {
    await mountShell([]);
    await press("Mod+Shift+A");
    expect(toastItems().map((t) => t.title)).toContain("Open a company first");
    expect(currentRail()).toBe("home");
  });
});
