// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";

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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

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
});
