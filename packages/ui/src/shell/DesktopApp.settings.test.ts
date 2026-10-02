// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createTenantStorage } from "../identity/tenant-storage.js";
import {
  writeSettingsPrefs,
  writeStoredUiSize,
} from "../settings/settings-prefs.js";
import type { Workspace } from "../chat/workspaces.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      // The shell loads the open channel's timeline after mount.
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
    },
  } as unknown as PlatformAdapter;
}


const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  document.documentElement.removeAttribute("data-ui-size");
  document.documentElement.style.removeProperty("--hq-window-opacity");
});

const acmeWorkspace: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme",
  bucketName: "hq-acme",
  hasLocalFolder: true,
  localPath: "/tmp/acme",
  membershipStatus: "active",
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

describe("DesktopApp settings on web", () => {
  it("opens the shared Settings destination from the identity footer", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: {
          uid: "prs_test",
          displayName: "Stefan Johnson",
          email: "stefan@example.com",
        },
        coreFixtures: false,
      },
    });
    await tick();

    expect(host.querySelector('[data-testid="settings-host"]')).toBeNull();

    expect(host.querySelector('[data-testid="chat-user-card"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="rail-you"]')?.click();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();

    const settingsItem = host.querySelector<HTMLButtonElement>(
      '[data-testid="account-settings"]',
    );
    expect(settingsItem).toBeTruthy();
    settingsItem?.click();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();

    // US-035 replaced the placeholder with the account host.
    const account = host.querySelector('[data-testid="account-host"]');
    expect(account?.getAttribute("data-page")).toBe("settings");
    expect(host.querySelector('[data-testid="rail-placeholder"]')).toBeNull();
    expect(host.querySelector('[data-testid="settings-host"]')).toBeNull();
  });

  it("keeps the selected company scope when the tenant-keyed sidebar remounts", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: {
          uid: "prs_test",
          displayName: "Stefan Johnson",
          email: "stefan@example.com",
        },
        tenantAccountId: "acct_stefan",
        tenantGeneration: 1,
        companies: [acmeWorkspace],
        coreFixtures: false,
      },
    });
    await tick();

    (host.querySelector('[data-testid="chat-scope-pill"]') as HTMLButtonElement).click();
    await tick();
    (document.querySelector('[data-testid="chat-scope-option"][data-scope="cmp_acme"]') as HTMLButtonElement).click();
    await tick();
    await tick();

    const scope = host.querySelector('[data-testid="chat-scope-pill"]');
    expect(scope?.textContent).toContain("Acme");
    expect(scope?.getAttribute("aria-label")).toContain("Acme");
  });

  it("applies interface preferences from the active tenant storage at startup", async () => {
    writeSettingsPrefs({ uiSize: "large", windowOpacity: 96 });
    const storage = createTenantStorage(memoryStorage, {
      accountId: "acct_stefan",
      companyId: "all",
    });
    writeSettingsPrefs({ uiSize: "compact", windowOpacity: 64 }, storage);

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: {
          uid: "prs_test",
          displayName: "Stefan Johnson",
          email: "stefan@example.com",
        },
        tenantAccountId: "acct_stefan",
        tenantGeneration: 1,
        coreFixtures: false,
      },
    });
    await tick();

    expect(document.documentElement.getAttribute("data-ui-size")).toBe("compact");
    expect(document.documentElement.style.getPropertyValue("--hq-window-opacity")).toBe("64%");
  });

  it("applies the device-wide interface size at startup over a tenant copy (QA-074)", async () => {
    writeStoredUiSize("large");
    const storage = createTenantStorage(memoryStorage, {
      accountId: "acct_stefan",
      companyId: "all",
    });
    writeSettingsPrefs({ uiSize: "compact" }, storage);

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: {
          uid: "prs_test",
          displayName: "Stefan Johnson",
          email: "stefan@example.com",
        },
        tenantAccountId: "acct_stefan",
        tenantGeneration: 1,
        coreFixtures: false,
      },
    });
    await tick();

    expect(document.documentElement.getAttribute("data-ui-size")).toBe("large");
  });
});
