// @vitest-environment happy-dom

/**
 * First-run guided tour, end to end through the real shell: on a fresh
 * install (the host says the guided setup is owed and the tour was never
 * shown) it starts by itself once #welcome is on screen, records "seen" at
 * once, then walks all eight steps: the titlebar Files button and the
 * sidebar "+" (pointed at, not opened: no explorer, no create modal), the
 * Companies section for invites, meetings, the console globe, the held-open
 * Launch menu and the command palette. The setup bot's DM opens mid-tour
 * (as the auto-started bot does on a real install): step 1 re-points at its
 * composer, and Done leaves the person on that conversation, with every
 * surface the tour opened closed, nothing created and no navigation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { SETUP_ROW_ID } from "../chat/setup-channel.js";
import { TOUR_SEEN_STORAGE_KEY, resolveTourTarget, tourSteps } from "../tour/guided-tour.js";
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

const SETUP_BOT_UID = "agt_setup_tour";

const SETUP_BOT: LocalBotRow = {
  name: "setup",
  agentUid: SETUP_BOT_UID,
  ownerUid: "prs_test",
  runtime: "claude",
  state: "running",
  pid: 11,
  processAlive: true,
  online: false,
  lastHeartbeatAt: null,
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/tmp/HQ/personal/workers/setup",
  workerId: "setup",
};

const STEPS = tourSteps({ hasCompany: true, hasCompanyVault: true });

/** Which of a step's target selectors is in the DOM (happy-dom has no layout). */
function resolvedSelector(index: number): string | null {
  return resolveTourTarget(STEPS[index].targets, (sel) => document.querySelector(sel))?.selector ?? null;
}

async function next(): Promise<void> {
  q("guided-tour-next")!.click();
  await settle();
}

// One mount per file: the sidebar's boot pick keeps module-level state.
describe("DesktopApp first-run guided tour", () => {
  it("auto-starts on a fresh install, walks the eight steps and leaves the person where they are", async () => {
    const markWelcomeTourShown = vi.fn(async () => ok(undefined));
    const createBot = vi.fn(async () => ok({ ok: true, name: "x", agentUid: "agt_x" }));
    const onselectrow = vi.fn();
    const adapter = {
      kind: "desktop",
      isAvailable: () => false,
      capabilities: {},
      messaging: {
        listContacts: async () => ok({ contacts: [] }),
        listChannelMembers: async () => ok({ members: [] }),
        fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
        fetchDmThread: async () => ({ ok: false as const, reason: "unavailable" }),
      },
      files: { listDir: async () => ok([]) },
      identity: { hasFeature: async () => ok(false) },
      bots: {
        list: async () => ok({ bots: [SETUP_BOT] }),
        create: createBot,
        start: async () => ok({}),
        stop: async () => ok({}),
        remove: async () => ok({}),
        workers: async () => ok({ workers: [] }),
      },
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
        onselectrow,
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
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("1 of 8");
    expect(resolvedSelector(0)).toBe('[data-testid="setup-hero"]');

    // Mid-tour the setup bot's DM opens (on a real install the bot does this
    // by itself). Step 1 now points at its composer.
    q("setup-run")!.click();
    await settle();
    await vi.waitFor(() => expect(q("channel-name")?.textContent).toContain("setup"), {
      timeout: 2000,
      interval: 20,
    });
    const dmStep = tourSteps({ setupBotDmOpen: true, setupBotUid: SETUP_BOT_UID })[0];
    expect(
      resolveTourTarget(dmStep.targets, (sel) => document.querySelector(sel))?.selector,
    ).toBe(".dm-reply-composer");
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("1 of 8");
    expect(createBot).not.toHaveBeenCalled();

    // Step 2: the rail Library button; the explorer does not open.
    await next();
    expect(q("guided-tour-card")?.textContent).toContain("Your company's files");
    expect(resolvedSelector(1)).toBe('[data-testid="rail-library"]');
    expect(q("vault-explorer")).toBeNull();

    // Step 3: the sidebar "+" that leads to New bot; the create modal stays shut.
    await next();
    expect(q("guided-tour-card")?.textContent).toContain("Make your own bots");
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("3 of 8");
    expect(resolvedSelector(2)).toBe('[data-testid="chat-new-message"]');
    expect(q("chat-create-modal")).toBeNull();

    // Step 4: invites, pointed at the first company tile on the rail.
    await next();
    expect(q("guided-tour-card")?.textContent).toContain("Bring in your team");
    expect(resolvedSelector(3)).toBe('[data-testid="rail-company"]');

    // Back and forth over steps 2-4 never opens the explorer or the modal.
    q("guided-tour-back")!.click();
    await settle();
    q("guided-tour-back")!.click();
    await settle();
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("2 of 8");
    await next();
    await next();
    expect(q("vault-explorer")).toBeNull();
    expect(q("chat-create-modal")).toBeNull();

    // Step 5: meetings.
    await next();
    expect(q("guided-tour-card")?.textContent).toContain("HQ can take notes on your calls");
    expect(resolvedSelector(4)).toBe('[data-testid="rail-meetings"]');

    // The person opens another conversation themselves mid-tour.
    const other = host.querySelector<HTMLButtonElement>('.chat-row[data-conversation-id^="dm:person-"]')!;
    const otherId = other.getAttribute("data-conversation-id")!;
    other.click();
    await settle();
    await vi.waitFor(
      () => expect(host.querySelector(`.chat-row[data-conversation-id="${otherId}"].active`)).toBeTruthy(),
      { timeout: 2000, interval: 20 },
    );
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("5 of 8");

    // Step 6: the personal tools on the rail.
    await next();
    expect(q("guided-tour-card")?.textContent).toContain("Your personal tools");
    expect(resolvedSelector(5)).toBe('[data-testid="rail-deployments"]');
    expect(q("titlebar-launch-menu")).toBeNull();

    // Step 7: the Launch menu is held open; a click on the card keeps it.
    await next();
    expect(q("titlebar-launch-menu")).toBeTruthy();
    q("guided-tour-card")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();
    expect(q("titlebar-launch-menu")).toBeTruthy();

    // Step 8: the command palette opens; the Launch menu closes.
    await next();
    expect(q("titlebar-launch-menu")).toBeNull();
    expect(q("command-palette")).toBeTruthy();
    expect(resolvedSelector(7)).toBe('[data-testid="command-palette"]');
    expect(q("guided-tour-card")?.textContent).toContain("Find anything with");
    expect(q("guided-tour-progress")?.textContent?.trim()).toBe("8 of 8");
    expect(q("guided-tour-next")?.textContent?.trim()).toBe("Done");

    // Done: the layer and the palette close, and nothing navigates: the
    // conversation picked mid-tour stays selected (not #welcome, not the
    // setup DM), no row is selected again, and the history is untouched.
    const selectionsBefore = onselectrow.mock.calls.length;
    const backBefore = q("titlebar-back")?.outerHTML;
    await next();
    await settle();
    await new Promise((r) => setTimeout(r, 100));
    await settle();
    expect(host.querySelector(`.chat-row[data-conversation-id="${otherId}"].active`)).toBeTruthy();
    expect(q("setup-channel-intro")).toBeNull();
    expect(onselectrow.mock.calls.length).toBe(selectionsBefore);
    expect(q("titlebar-back")?.outerHTML).toBe(backBefore);
    expect(q("vault-explorer")).toBeNull();
    expect(q("guided-tour-card")).toBeNull();
    expect(q("command-palette")).toBeNull();
    expect(q("chat-create-modal")).toBeNull();
    expect(q("titlebar-launch-menu")).toBeNull();
    expect(createBot).not.toHaveBeenCalled();
    expect(markWelcomeTourShown).toHaveBeenCalledTimes(1);
  }, 20_000);
});
