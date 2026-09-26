// @vitest-environment happy-dom

/**
 * The "Projects" pill next to Chat in a company home channel's header. It is
 * an in-channel tab, not a link to the standalone Projects page: selecting it
 * keeps the company header chrome (hero, title, gear, bell, member pill, and
 * the Chat | Projects pills) mounted in place and swaps only the content area
 * below it for that company's project board (CompanyProjectsPage, scoped to
 * the channel's own company). Selecting Chat brings the feed and composer
 * back. Shown only on company home channels (same predicate as the rest of
 * the header chrome); a plain team channel renders none of that chrome,
 * including this pill.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

const RAMEN_BAE: Workspace = {
  slug: "ramen-bae",
  displayName: "Ramen Bae",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_ramenbae",
  role: "member",
  membershipStatus: "active",
  homeChannelId: "chn_ramenbae_home",
} as Workspace;

const HOME_ROW: ConversationRow = {
  id: "ch:home",
  kind: "channel",
  title: "ramen-bae",
  channelId: "chn_ramenbae_home",
  channelScope: "company",
  companyUid: "cmp_ramenbae",
  isCompanyHome: true,
} as ConversationRow;

const TEAM_ROW: ConversationRow = {
  id: "ch:team",
  kind: "channel",
  title: "marketing",
  channelId: "chn_ramenbae_team",
  channelScope: "company",
  companyUid: "cmp_ramenbae",
  isCompanyHome: false,
} as ConversationRow;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      runCardAction: async () => ({ ok: false as const, reason: "unavailable" }),
      setChannelNotifyLevel: async () => ok({}),
    },
    identity: {
      listAvatarPacks: async () => ok({ packs: [], expiresAt: Date.now() + 60_000 }),
      updateAgentProfile: async () => ok({}),
      hasFeature: async () => ok(false),
    },
    agents: { getProvisionOptions: async () => ok({ defaultInstanceType: "t4g.medium", catalogVersion: "test", options: [] }) },
    meetings: {
      listUpcoming: async () => ok([]),
      listMemberships: async () => ok([]),
      listAccounts: async () => ok([]),
      listScheduledBots: async () => ok([]),
    },
    calls: {
      contractVersion: "hq-meet/1",
      discoverOffice: async (companyUid: string) => ok({ companyUid, people: [], observedAt: Date.now() }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
    projects: {
      listLocal: async () => ok({ projects: [] }),
    },
    workMesh: {
      getProjectView: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountShell(initialRow: ConversationRow): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
      coreFixtures: false,
      initialRow,
      companies: [RAMEN_BAE],
    },
  });
  await settle(8);
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
});

describe("Projects tab on company home channels", () => {
  it("renders the board below the header and keeps the hero/title/pills mounted", async () => {
    await mountShell(HOME_ROW);

    const header = host.querySelector('[data-testid="channel-header"]');
    expect(header, "channel header").toBeTruthy();
    const headerHeightBefore = header!.getBoundingClientRect().height;

    const pill = host.querySelector<HTMLButtonElement>('[data-testid="company-tab-projects"]');
    expect(pill, "Projects pill on company home channel").toBeTruthy();
    expect(pill!.textContent).toContain("Projects");

    pill!.click();
    await settle(8);

    // Stayed in the channel — no standalone Projects page.
    expect(host.querySelector('[data-testid="projects-host"]')).toBeFalsy();

    // Board renders below the still-mounted header chrome.
    expect(host.querySelector('[data-testid="company-projects-tab-host"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="company-projects-page"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="channel-header"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="company-hero"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="company-channel-tabs"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="company-console-gear"]')).toBeTruthy();

    // The Projects pill is now the active one.
    const activePill = host.querySelector<HTMLButtonElement>(
      '[data-testid="company-tab-projects"]',
    );
    expect(activePill?.classList.contains("active")).toBe(true);

    const headerHeightAfter = host
      .querySelector('[data-testid="channel-header"]')!
      .getBoundingClientRect().height;
    expect(headerHeightAfter).toBe(headerHeightBefore);

    // Chat brings the feed and composer back.
    const chatPill = host.querySelector<HTMLButtonElement>('[data-testid="company-tab-chat"]');
    expect(chatPill).toBeTruthy();
    chatPill!.click();
    await settle(8);

    expect(host.querySelector('[data-testid="company-projects-tab-host"]')).toBeFalsy();
    expect(host.querySelector('[data-testid="chat-stage"]')).toBeTruthy();
    expect(chatPill!.classList.contains("active")).toBe(true);

    const headerHeightRestored = host
      .querySelector('[data-testid="channel-header"]')!
      .getBoundingClientRect().height;
    expect(headerHeightRestored).toBe(headerHeightBefore);
  });

  it("does not render the Projects pill on a plain team channel", async () => {
    await mountShell(TEAM_ROW);

    expect(host.querySelector('[data-testid="company-tab-projects"]')).toBeFalsy();
  });
});
