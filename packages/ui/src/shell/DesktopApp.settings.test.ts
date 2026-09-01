// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createTenantStorage } from "../identity/tenant-storage.js";
import { writeSettingsPrefs } from "../settings/settings-prefs.js";
import type { Workspace } from "../chat/workspaces.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
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

    const card = host.querySelector<HTMLButtonElement>(
      '[data-testid="chat-user-card"]',
    );
    expect(card).toBeTruthy();
    card?.click();
    await tick();

    const settingsItem = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.trim() === "Settings");
    expect(settingsItem).toBeTruthy();
    settingsItem?.click();
    await tick();

    const settings = host.querySelector('[data-testid="settings-host"]');
    expect(settings).toBeTruthy();
    expect(
      settings?.querySelector('[data-testid="settings-nav-notifications"]'),
    ).toBeTruthy();
    expect(
      settings?.querySelector('[data-testid="settings-nav-sync"]'),
    ).toBeNull();
    expect(
      settings?.querySelector('[data-testid="settings-nav-updates"]'),
    ).toBeNull();
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
});
