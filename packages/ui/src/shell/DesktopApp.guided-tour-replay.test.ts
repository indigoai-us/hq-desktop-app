// @vitest-environment happy-dom

/**
 * The guided tour runs by itself only once. When the host says it was already
 * shown, a fresh-install shell does not show it again, and "Take the tour" in
 * the command palette replays it; Escape skips it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { TOUR_AUTO_START_DELAY_MS } from "../tour/guided-tour.js";
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

/** The palette binds Mod+K to this environment's platform modifier. */
function isMacHere(): boolean {
  return /Mac OS X|Macintosh/i.test(navigator.userAgent);
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

// One mount per file: the sidebar's boot pick keeps module-level state.
describe("DesktopApp guided tour replay", () => {
  it("does not auto-start once shown, and the palette replays it", async () => {
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
            welcomeTourShown: true,
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
    await vi.waitFor(() => expect(q("setup-channel-intro")).toBeTruthy(), {
      timeout: 8000,
      interval: 20,
    });
    await new Promise((r) => setTimeout(r, TOUR_AUTO_START_DELAY_MS + 200));
    await settle();
    expect(q("guided-tour-card")).toBeNull();

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        metaKey: isMacHere(),
        ctrlKey: !isMacHere(),
        bubbles: true,
      }),
    );
    await tick();
    const row = host.querySelector<HTMLButtonElement>("#command-take-tour");
    expect(row?.textContent).toContain("Take the tour");
    row!.click();
    await vi.waitFor(() => expect(q("guided-tour-card")).toBeTruthy(), {
      timeout: 2000,
      interval: 20,
    });
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("1 of 8");
    expect(markWelcomeTourShown).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(q("guided-tour-card")).toBeNull();
    expect(q("setup-channel-intro")).toBeTruthy();
  }, 20_000);
});
