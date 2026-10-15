// @vitest-environment happy-dom

/**
 * US-008: hq://brief and hq://vault select the Daily Brief and the rail's
 * Files page. The desktop host turns each link into the embedded target below
 * (apps/sync desktopRouteToEmbeddedTarget, covered in route.test.ts); these
 * tests drive that target into the real shell and assert the view and the
 * rail selection match a rail click.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { loadBrief } from "./brief-lazy.js";
import {
  dispatchEmbeddedNavigation,
  type EmbeddedNavigationTarget,
} from "./embedded-navigation.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

/** The targets hq://brief and hq://vault resolve to in the desktop host. */
const HQ_BRIEF_TARGET: EmbeddedNavigationTarget = { kind: "extra", page: "rail-brief" };
const HQ_VAULT_TARGET: EmbeddedNavigationTarget = { kind: "extra", page: "rail-library" };

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

function localFilesAdapter(): PlatformAdapter {
  return {
    ...webAdapter(),
    files: {
      listDir: async () => ok([]),
      getFileContent: async () => ok(""),
      vault: {
        summary: async (root: string) =>
          ok({ root, notes: 0, files: 0, links: 0, truncated: false, hubs: [], folders: [] }),
        search: async () => ok([]),
        noteLinks: async () => ok({ resolved: [], backlinks: [], backlinkCount: 0, outgoing: [] }),
        readNote: async () => ok({ text: "", size: 0, truncated: false }),
      },
    },
  } as unknown as PlatformAdapter;
}

/** Turns the Daily Brief gate on, as the rail tests do. */
function withBriefGate(adapter: PlatformAdapter): PlatformAdapter {
  (adapter as unknown as { identity: unknown }).identity = {
    whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
    hasFeature: async (flag: string) => ok(flag === "desktop.rail-brief-v1"),
    subscribeFeature: () => () => {},
  };
  return adapter;
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
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

async function mountShell(adapter: PlatformAdapter): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
      coreFixtures: false,
    },
  });
  await settle();
}

function current(): string | null {
  return (
    host
      .querySelector('[data-testid="app-rail"] [aria-current="page"]')
      ?.getAttribute("data-rail-id") ?? null
  );
}

describe("DesktopApp hq:// links (US-008)", () => {
  it("hq://brief opens the Daily Brief with the rail on Brief", async () => {
    await mountShell(withBriefGate(webAdapter()));
    expect(host.querySelector('[data-testid="brief-host"]')).toBeNull();
    dispatchEmbeddedNavigation(HQ_BRIEF_TARGET);
    await settle();
    expect(host.querySelector('[data-testid="brief-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-files-host"]')).toBeNull();
    expect(current()).toBe("brief");
    await loadBrief();
    await settle();
  });

  it("hq://vault opens the Files page with the rail on Files", async () => {
    await mountShell(localFilesAdapter());
    expect(host.querySelector('[data-testid="rail-files-host"]')).toBeNull();
    dispatchEmbeddedNavigation(HQ_VAULT_TARGET);
    await settle();
    expect(host.querySelector('[data-testid="rail-files-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="brief-host"]')).toBeNull();
    expect(current()).toBe("library");
  });
});
