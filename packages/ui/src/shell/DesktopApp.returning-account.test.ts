// @vitest-environment happy-dom

/**
 * US-023: an account that setup recognised as returning (it already has
 * companies) owes no welcome setup, takeover, team card or automatic tour,
 * and the shell offers no create-company push. The host says so through
 * get_setup_status's accountKind. A new account on the same fixture keeps
 * the "Create another company" action, so the hidden action is not an
 * artefact of the fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { SETUP_ROW_ID } from "../chat/setup-channel.js";
import { VISUAL_FIRST_RUN_DONE_KEY } from "../chat/first-run/visual-first-run.js";
import { TOUR_AUTO_START_DELAY_MS, TOUR_SEEN_STORAGE_KEY } from "../tour/guided-tour.js";
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

function adapter(status: Record<string, unknown>, markWelcomeTourShown: () => Promise<unknown>): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ({ ok: false as const, reason: "unavailable" }),
      runCardAction: async () => ok({}),
    },
    files: { listDir: async () => ok([]), getFileContent: async () => ok("") },
    identity: { hasFeature: async (flag: string) => ok(flag === "desktop.rail-brief-v1") },
    appShell: { setActiveCompany: async () => ok(undefined) },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", ...status }),
      markWelcomeTourShown,
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

async function mountApp(status: Record<string, unknown>) {
  const markWelcomeTourShown = vi.fn(async () => ok(undefined));
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(status, markWelcomeTourShown),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Ada Lovelace", email: "ada@example.com" },
      coreFixtures: false,
      companies: [ACME],
    },
  });
  await settle();
  return { markWelcomeTourShown };
}

async function openWelcome(): Promise<void> {
  await vi.waitFor(() => expect(host.querySelector(`[data-conversation-id="${SETUP_ROW_ID}"]`)).toBeTruthy(), {
    timeout: 4000,
    interval: 20,
  });
  host.querySelector<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`)!.click();
  await settle();
}

describe("DesktopApp for a returning account (US-023)", () => {
  it("marks the takeover finished, starts no tour, offers no create-company push and flags the brief", async () => {
    const { markWelcomeTourShown } = await mountApp({
      welcomeSetupOwed: true,
      welcomeTourShown: false,
      accountKind: "returning",
    });
    await vi.waitFor(() => expect(memoryStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1"), {
      timeout: 4000,
      interval: 20,
    });

    await openWelcome();
    await vi.waitFor(() => expect(q("setup-company-actions")).toBeTruthy(), { timeout: 4000, interval: 20 });
    expect(q("setup-open-company-acme")).toBeTruthy();
    expect(q("setup-create-another-company")).toBeNull();

    await new Promise((r) => setTimeout(r, TOUR_AUTO_START_DELAY_MS + 400));
    await settle();
    expect(q("guided-tour-card")).toBeNull();
    expect(markWelcomeTourShown).not.toHaveBeenCalled();
    expect(memoryStorage.getItem(TOUR_SEEN_STORAGE_KEY)).toBeNull();

    q("rail-brief")!.click();
    await settle();
    await vi.waitFor(() => expect(q("brief-host")).toBeTruthy(), { timeout: 4000, interval: 20 });
    expect(q("brief-host")!.getAttribute("data-first-view-returning")).toBe("true");
  }, 20_000);

  it("keeps Create another company and an unflagged brief for a new account", async () => {
    await mountApp({ welcomeSetupOwed: false, welcomeTourShown: true, accountKind: "new" });
    await openWelcome();
    await vi.waitFor(() => expect(q("setup-company-actions")).toBeTruthy(), { timeout: 4000, interval: 20 });
    expect(q("setup-create-another-company")).toBeTruthy();

    q("rail-brief")!.click();
    await settle();
    await vi.waitFor(() => expect(q("brief-host")).toBeTruthy(), { timeout: 4000, interval: 20 });
    expect(q("brief-host")!.hasAttribute("data-first-view-returning")).toBe(false);
  }, 20_000);
});
