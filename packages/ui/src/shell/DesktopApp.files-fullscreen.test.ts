// @vitest-environment happy-dom

/**
 * Files is a full destination like Settings: opening it replaces the channel
 * list and conversation area, and Back returns to Messages.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

function desktopAdapter(): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
    },
    files: { listDir: async () => ok([]) },
  } as unknown as PlatformAdapter;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

describe("DesktopApp Files destination", () => {
  it("takes over the window like Settings and Back returns to Messages", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: desktopAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_test", displayName: "Ada Lovelace", email: "ada@example.com" },
        coreFixtures: false,
      },
    });
    await settle();

    expect(host.querySelector('[data-testid="chat-sidebar"]')).toBeTruthy();
    host.querySelector<HTMLButtonElement>('[data-testid="rail-library"]')!.click();
    await settle();

    const files = host.querySelector('[data-testid="files-host"]');
    expect(files).toBeTruthy();
    expect(files?.querySelector('[data-testid="vault-explorer"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="chat-sidebar"]')).toBeNull();

    host.querySelector<HTMLButtonElement>('[data-testid="files-back"]')!.click();
    await settle();

    expect(host.querySelector('[data-testid="files-host"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-sidebar"]')).toBeTruthy();
  });
});
