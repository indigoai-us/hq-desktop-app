// @vitest-environment happy-dom

/**
 * console-rail US-010 — avatar menu, placeholders, company settings, sign out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";
import { PresenceStore } from "@hq/core";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { bindPresenceStore } from "../chat/presence-store.svelte.js";
import type { Workspace } from "../chat/workspaces.js";

function webAdapter(): PlatformAdapter {
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
    appShell: {
      notificationPermissionState: async () => ok("default"),
    },
    settings: {
      getSettings: async () => ok({}),
    },
    library: {
      getRoot: async () => ok({ workers: [], skills: [] }),
      getCompany: async () => ok({ workers: [], skills: [] }),
      getWorkerDetail: async () => ok({}),
      getSkillDetail: async () => ok({}),
    },
  } as unknown as PlatformAdapter;
}

function company(): Workspace {
  return {
    slug: "indigo",
    displayName: "Indigo",
    kind: "company",
    state: "synced",
    cloudUid: "co_indigo",
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "owner",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
  };
}

const memoryStorage = installMemoryLocalStorage();
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let unbind: (() => void) | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  unbind?.();
  unbind = null;
  host?.remove();
  memoryStorage.clear();
  vi.unstubAllGlobals();
});

async function mountShell(onsignout?: () => void): Promise<void> {
  const store = new PresenceStore();
  store.applyMqtt("hq/co_indigo/presence/prs_test", {
    status: "online",
    actorUid: "prs_test",
    actorType: "human",
    at: "2026-10-01T00:00:00.000Z",
  });
  unbind = bindPresenceStore(store);
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      companies: [company()],
      self: {
        uid: "prs_test",
        displayName: "Stefan Johnson",
        email: "stefan@example.com",
      },
      coreFixtures: false,
      onsignout,
    },
  });
  await tick();
  await tick();
}

async function settle(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

describe("DesktopApp account menu (US-010)", () => {
  it("shows a live dot, hides the sidepane account footer, and opens cached pages", async () => {
    await mountShell();
    expect(host.querySelector('[data-testid="chat-user-card"]')).toBeNull();
    const you = host.querySelector<HTMLButtonElement>('[data-testid="rail-you"]');
    expect(you?.getAttribute("aria-label")).toContain("Stefan");
    expect(host.querySelector('[data-testid="rail-you-live"]')).not.toBeNull();

    you?.click();
    await settle();
    const menu = host.querySelector('[data-testid="account-menu"]');
    expect(menu?.textContent).toContain("Working in Indigo");
    expect(menu?.textContent).toContain("owner");

    host.querySelector<HTMLButtonElement>('[data-testid="account-profile"]')?.click();
    await settle();
    const profile = host.querySelector('[data-testid="account-host"]');
    expect(profile?.getAttribute("data-story")).toBe("US-035");
    expect(profile?.getAttribute("data-page")).toBe("profile");
    expect(host.querySelector('[data-testid="account-menu"]')).toBeNull();

    you?.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="account-role"]')?.click();
    await settle();
    const settings =
      host.querySelector('[data-testid="company-settings-host"]') ??
      host.querySelector('[data-testid="rail-placeholder"]');
    expect(settings).not.toBeNull();
    const story = settings?.getAttribute("data-story");
    if (story) expect(story).toBe("US-030");
  });

  it("confirms sign out and asks the host to end the session", async () => {
    const onsignout = vi.fn(async () => {});
    vi.stubGlobal("confirm", vi.fn(() => true));
    await mountShell(onsignout);
    host.querySelector<HTMLButtonElement>('[data-testid="rail-you"]')?.click();
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="account-sign-out"]')?.click();
    await tick();
    expect(confirm).toHaveBeenCalled();
    expect(onsignout).toHaveBeenCalledOnce();
  });

  it("leaves the session in place when sign out is cancelled", async () => {
    const onsignout = vi.fn(async () => {});
    vi.stubGlobal("confirm", vi.fn(() => false));
    await mountShell(onsignout);
    host.querySelector<HTMLButtonElement>('[data-testid="rail-you"]')?.click();
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="account-sign-out"]')?.click();
    await tick();
    expect(onsignout).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="app-rail"]')).not.toBeNull();
  });
});
