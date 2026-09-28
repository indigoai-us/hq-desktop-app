// @vitest-environment happy-dom

/**
 * First-run guided tour, end to end through the real shell: on a fresh
 * install (the host says the guided setup is owed and the tour was never
 * shown) it starts by itself once #welcome is on screen, records "seen" at
 * once, opens the company vault on step 2, holds the titlebar Launch menu
 * open on step 4, and Done returns to #welcome with the menu closed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { SETUP_ROW_ID } from "../chat/setup-channel.js";
import { TOUR_SEEN_STORAGE_KEY } from "../tour/guided-tour.js";
import type { Workspace } from "../chat/workspaces.js";

const memoryStorage = installMemoryLocalStorage();

const ACME: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

// One mount per file: the sidebar's boot pick keeps module-level state.
describe("DesktopApp first-run guided tour", () => {
  it("auto-starts on a fresh install, walks the four steps and lands back on #welcome", async () => {
    const markWelcomeTourShown = vi.fn(async () => ok(undefined));
    const adapter = {
      kind: "desktop",
      isAvailable: () => false,
      capabilities: {},
      messaging: {
        listContacts: async () => ok({ contacts: [] }),
        listChannelMembers: async () => ok({ members: [] }),
        fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      },
      files: { listDir: async () => ok([]) },
      appShell: { setActiveCompany: async () => ok(undefined) },
      settings: {
        getSetupStatus: async () =>
          ok({
            hqRootValid: true,
            configured: true,
            hqFolderPath: "/tmp/HQ",
            welcomeSetupOwed: true,
            welcomeTourShown: false,
          }),
        markWelcomeTourShown,
      },
      shell: {
        detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
      },
    } as unknown as PlatformAdapter;

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter,
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_test", displayName: "Ada Lovelace", email: "ada@example.com" },
        coreFixtures: false,
        companies: [ACME],
      },
    });
    await settle();

    await vi.waitFor(() => expect(q("guided-tour-card")).toBeTruthy(), {
      timeout: 8000,
      interval: 20,
    });
    // #welcome is on screen and is what step 1 spotlights.
    expect(q("setup-channel-intro")).toBeTruthy();
    expect(host.querySelector(`.chat-row[data-conversation-id="${SETUP_ROW_ID}"].active`)).toBeTruthy();
    expect(markWelcomeTourShown).toHaveBeenCalledTimes(1);
    expect(memoryStorage.getItem(TOUR_SEEN_STORAGE_KEY)).toBe("1");
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("1 of 4");

    // Step 2: the Files explorer on the company vault.
    q("guided-tour-next")!.click();
    await settle();
    await vi.waitFor(() => expect(q("vault-explorer")).toBeTruthy(), { timeout: 2000, interval: 20 });
    expect(q("guided-tour-card")?.textContent).toContain("Your company's files");

    // Step 3: the web console globe.
    q("guided-tour-next")!.click();
    await settle();
    expect(q("guided-tour-card")?.textContent).toContain("Open HQ on the web");
    expect(q("titlebar-launch-menu")).toBeNull();

    // Step 4: the Launch menu is held open; a click on the card keeps it.
    q("guided-tour-next")!.click();
    await settle();
    expect(q("titlebar-launch-menu")).toBeTruthy();
    q("guided-tour-card")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();
    expect(q("titlebar-launch-menu")).toBeTruthy();
    expect(q("guided-tour-next")?.textContent?.trim()).toBe("Done");

    // Done: the layer closes, the menu closes, and #welcome is back.
    q("guided-tour-next")!.click();
    await settle();
    await vi.waitFor(() => expect(q("setup-channel-intro")).toBeTruthy(), {
      timeout: 2000,
      interval: 20,
    });
    expect(q("vault-explorer")).toBeNull();
    expect(q("guided-tour-card")).toBeNull();
    expect(q("titlebar-launch-menu")).toBeNull();
    expect(markWelcomeTourShown).toHaveBeenCalledTimes(1);
  }, 20_000);
});
