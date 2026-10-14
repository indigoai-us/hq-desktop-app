// @vitest-environment happy-dom

/**
 * QA-090 — Bots → a bot → Message opens the DM even when no cache knows it.
 *
 * Message used to navigate to `{ kind: "dm", personUid }`, which only resolves
 * when the rail already lists that DM. A bot nobody had messaged yet (not in
 * local bots, not in the contact list) fell through to "This destination is no
 * longer available." The action now opens the DM by UID in the viewing
 * company and lets the conversation hydrate.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import type { Workspace } from "../chat/workspaces.js";

const BOT_UID = "agt_dr_love";

/** Any agents call the test does not stub answers "unavailable", as an old server would. */
function unavailableByDefault<T extends object>(api: T): T {
  return new Proxy(api, {
    get: (target, key) =>
      key in target
        ? (target as Record<PropertyKey, unknown>)[key]
        : async () => ({ ok: false, reason: "unavailable" }),
  });
}

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
      fetchDmThread: async () => ok({ messages: [] }),
    },
    agents: unavailableByDefault({
      listMobileRoster: async () =>
        ok({
          agents: [
            { agentUid: BOT_UID, displayName: "dr-love", companyUid: "cmp_indigo", status: "IDLE" },
          ],
        }),
      getStatus: async () => ok({}),
    }),
    meetings: {
      listAccounts: async () => ok([]),
      listUpcoming: async () => ok([]),
      permissionsState: async () => ok(null),
    },
    appShell: { notificationPermissionState: async () => ok("default") },
    settings: { getSettings: async () => ok({}) },
    library: {
      getRoot: async () => ok({ workers: [], skills: [] }),
      getCompany: async () => ok({ workers: [], skills: [] }),
      getWorkerDetail: async () => ok({}),
      getSkillDetail: async () => ok({}),
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
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("Bots → Message with cold caches (QA-090)", () => {
  it("opens the bot's DM instead of the unavailable page", { timeout: 30_000 }, async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_test", displayName: "Tester", email: "t@example.com" },
        coreFixtures: false,
        companies: [
          {
            slug: "indigo",
            displayName: "Indigo",
            kind: "company",
            state: "synced",
            cloudUid: "cmp_indigo",
            role: "member",
            membershipStatus: "active",
          } as Workspace,
        ],
      },
    });
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="rail-company"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-row-id="bots"]')!.click();
    await settle();
    // The profile pane is a lazy door; wait for its Message button.
    let message: HTMLButtonElement | null = null;
    for (let i = 0; i < 150 && !message; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settle();
      message = host.querySelector<HTMLButtonElement>('[data-testid="bot-profile-message"]');
    }
    expect(message).not.toBeNull();
    message!.click();
    // Longer than the destination wait (16 × 50 ms) that used to give up.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await settle();

    expect(host.textContent ?? "").not.toContain("This destination is no longer available");
    expect(host.querySelector('[data-testid="bots-page"]')).toBeNull();
    expect(host.textContent ?? "").toContain("dr-love");
  });
});
