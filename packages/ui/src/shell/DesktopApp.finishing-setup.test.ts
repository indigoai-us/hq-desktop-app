// @vitest-environment happy-dom

/**
 * install-flow-rethink US-005b: DesktopApp mounts the Finishing setup chip
 * over the titlebar from its `installQueue` host. The chip shows while the
 * background queue is running and renders nothing while it is idle.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { InstallQueueHost } from "./finishing-setup.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
    },
    marketplace: {
      listListings: async () => ok({ listings: [] }),
    },
    meetings: {
      listAccounts: async () => ok([]),
      permissionsState: async () => ok(null),
    },
    identity: {
      whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
      hasFeature: async () => ok(false),
      subscribeFeature: () => () => {},
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

function queueHost(status: unknown): InstallQueueHost {
  return {
    getStatus: vi.fn(async () => status),
    retry: vi.fn(async () => null),
    listen: vi.fn(async () => () => {}),
  };
}

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await tick();
}

async function mountShell(installQueue: InstallQueueHost | null): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test User", email: "test@example.com" },
      coreFixtures: false,
      installQueue,
    },
  });
  await settle();
}

describe("DesktopApp Finishing setup chip mount", () => {
  it("renders the chip next to the titlebar while the install queue is running", async () => {
    const queue = queueHost({
      state: "running",
      current: "GitHub CLI",
      currentId: "gh",
      done: 4,
      total: 11,
      failed: [],
    });
    await mountShell(queue);

    expect(queue.getStatus).toHaveBeenCalled();
    const slot = host.querySelector(".finishing-setup-slot");
    expect(slot).not.toBeNull();
    // The slot sits directly after the titlebar, outside the shell column flow.
    expect(slot?.previousElementSibling?.classList.contains("v4-titlebar")).toBe(true);
    const chip = slot?.querySelector('[data-testid="finishing-setup-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("GitHub CLI");
  });

  it("renders no chip while the install queue is idle", async () => {
    const queue = queueHost({
      state: "idle",
      current: null,
      currentId: null,
      done: 0,
      total: 0,
      failed: [],
    });
    await mountShell(queue);

    expect(queue.getStatus).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
  });

  it("renders no chip when the host has no install queue", async () => {
    await mountShell(null);

    expect(host.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
  });
});
