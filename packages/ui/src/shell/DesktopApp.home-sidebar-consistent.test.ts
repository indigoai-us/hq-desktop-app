// @vitest-environment happy-dom

/**
 * Home's chat sidebar looks the same however Home is reached.
 *
 * The rail Home button lands on the cross-company list. Opening a
 * conversation from a company page (Bots → Message, ⌘K over a company page)
 * used to record the entry under that page's company, so Home re-scoped to
 * the company and showed an Activity section the Home button never shows.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import type { Workspace } from "../chat/workspaces.js";
import type { ChatSidebarApi } from "../chat/chat-api";

const BOT_UID = "agt_deez";
const COMPANY_UID = "cmp_indigo";

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
            { agentUid: BOT_UID, displayName: "deez", companyUid: COMPANY_UID, status: "IDLE" },
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

/** The fixture directory plus one Indigo company channel (an Activity row). */
function sidebarApi(): ChatSidebarApi {
  const base = createFixtureChatSidebarApi();
  return {
    ...base,
    fetchChannelDirectory: async (cursor: string | null) => {
      const feed = await base.fetchChannelDirectory(cursor);
      return {
        ...feed,
        rows: [
          ...(feed.rows ?? []),
          {
            channelId: "chn_indigo_ops",
            type: "project",
            scope: "company",
            companyUid: COMPANY_UID,
            name: "indigo-ops",
            subtitle: "company",
            // Newest row whatever the time of day: the fixture stamps rows at
            // today(7..10), which are still in the future before 10:12 local,
            // so a plain "now" sinks below them and out of the ⌘K list.
            lastActivityAt: new Date(Math.max(Date.now(), new Date().setHours(11, 0, 0, 0))).toISOString(),
            unreadCount: 0,
            memberCount: 4,
          },
        ],
      };
    },
  };
}

const memoryStorage = installMemoryLocalStorage();
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeAll(async () => {
  await import("../activity/ActivityView.svelte");
});

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

async function mountShell(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi: sidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Tester", email: "t@example.com" },
      coreFixtures: false,
      companies: [
        {
          slug: "indigo",
          displayName: "Indigo",
          kind: "company",
          state: "synced",
          cloudUid: COMPANY_UID,
          role: "member",
          membershipStatus: "active",
        } as Workspace,
      ],
    },
  });
  await settle();
}

function click(selector: string): void {
  const el = host.querySelector<HTMLElement>(selector);
  expect(el, selector).not.toBeNull();
  el!.click();
}

/** What the Home sidebar shows: its scope and its section headers. */
function homeSidebar(): { scope: string | null; activity: boolean } {
  expect(host.querySelector('[data-testid="company-sidepane-header"]')).toBeNull();
  return {
    scope: host.querySelector('[data-testid="chat-scope-pill"]')?.getAttribute("aria-label") ?? null,
    activity: host.querySelector("#chat-activity-label") != null,
  };
}

async function homeViaRail(): Promise<ReturnType<typeof homeSidebar>> {
  click('[data-testid="rail-home"]');
  await settle();
  return homeSidebar();
}

async function openCompanyBots(): Promise<void> {
  click('[data-testid="rail-company"]');
  await settle();
  click('[data-row-id="bots"]');
  await settle();
}

async function messageBotFromProfile(): Promise<void> {
  let message: HTMLButtonElement | null = null;
  for (let i = 0; i < 150 && !message; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    message = host.querySelector<HTMLButtonElement>('[data-testid="bot-profile-message"]');
  }
  expect(message).not.toBeNull();
  message!.click();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await settle();
}

describe("Home sidebar is the same however Home is reached", () => {
  it("Bots → Message lands on the same sidebar as the Home button", { timeout: 30_000 }, async () => {
    await mountShell();
    const viaRail = await homeViaRail();
    expect(viaRail.activity).toBe(false);

    await openCompanyBots();
    await messageBotFromProfile();
    expect(host.querySelector('[data-testid="bots-page"]')).toBeNull();
    expect(host.textContent ?? "").toContain("deez");
    expect(homeSidebar()).toEqual(viaRail);

    // Back returns to Bots; Forward restores the DM with the same sidebar.
    click('[data-testid="titlebar-back"]');
    await settle();
    expect(host.querySelector('[data-testid="bots-page"]')).not.toBeNull();
    click('[data-testid="titlebar-forward"]');
    // A cold DM resolves after the destination wait (16 × 50 ms).
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await settle();
    expect(host.querySelector('[data-testid="bots-page"]')).toBeNull();
    expect(host.textContent ?? "").not.toContain("This destination is no longer available");
    expect(host.textContent ?? "").toContain("deez");
    expect(homeSidebar()).toEqual(viaRail);
  });

  it("⌘K conversation pick over a company page matches the Home button", { timeout: 30_000 }, async () => {
    await mountShell();
    const viaRail = await homeViaRail();

    click('[data-testid="rail-company"]');
    await settle();
    click('[data-row-id="team"]');
    await settle();
    const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: mac, ctrlKey: !mac, bubbles: true }),
    );
    await settle();
    click('[id="conversation-ch:chn_indigo_ops"]');
    await settle();

    expect(homeSidebar()).toEqual(viaRail);
  });

  it("the company picker still narrows Home and shows that company's Activity", { timeout: 30_000 }, async () => {
    await mountShell();
    await homeViaRail();
    click('[data-testid="chat-scope-pill"]');
    await settle();
    click(`[data-testid="chat-scope-option"][data-scope="${COMPANY_UID}"]`);
    await settle();
    expect(homeSidebar().activity).toBe(true);

    // Opening a conversation from Home keeps the picked company.
    click('[data-conversation-id="ch:chn_indigo_ops"]');
    await settle();
    expect(homeSidebar().activity).toBe(true);
  });
});
