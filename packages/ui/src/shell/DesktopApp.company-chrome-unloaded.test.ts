// @vitest-environment happy-dom

/**
 * Regression: opening a company's home channel via `requestChannelOpen`
 * before that company's rows are loaded (the Companies-row click path when
 * the "All" scope hasn't fetched that company's channels yet, same as a
 * notification or deep link into an unseen channel) built a bare stub row —
 * `{ id, kind: "channel", channelId, title, companyUid }` — with no
 * `channelScope` or `isCompanyHome`. `isCompanyChannel` used to key
 * exclusively off `selectedRow.isCompanyHome`, so the stub never got the
 * CompanyHero header, the settings gear, or the company tabs — even though
 * the channel genuinely is that company's home channel. Reported live: two
 * companies opened via this path, one (already loaded) showed the company
 * chrome, the other (opened as a fresh stub) did not.
 *
 * The fix resolves "is this a company home channel" from the roster's own
 * `homeChannelId` (a channelId → company map), independent of the selected
 * row's own fields, so a same-shaped stub gets the same chrome the loaded
 * row would have.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { requestChannelOpen, takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

const SETUP_ROW: ConversationRow = {
  id: "ch:setup",
  kind: "channel",
  title: "setup",
  channelId: "setup",
  channelScope: "personal",
  companyUid: null,
} as ConversationRow;

const LIVERECOVER: Workspace = {
  slug: "liverecover",
  displayName: "Liverecover",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_liverecover",
  bucketName: "hq-vault-liverecover",
  hasLocalFolder: true,
  localPath: "/tmp/HQ/companies/liverecover",
  membershipStatus: "active",
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
  homeChannelId: "chn_liverecover_home",
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  takePendingChannelOpen();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const CLOUD_PROVISION_OPTIONS: AgentProvisionOptionsView = {
  defaultInstanceType: "t4g.medium",
  catalogVersion: "test-catalog",
  options: [],
};

function adapter(messaging: Partial<PlatformAdapter["messaging"]> = {}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      runCardAction: async () => ({ ok: false as const, reason: "unavailable" }),
      ...messaging,
    },
    identity: {
      listAvatarPacks: async () => ok({ packs: [], expiresAt: Date.now() + 60_000 }),
      updateAgentProfile: async () => ok({}),
      hasFeature: async () => ok(false),
    },
    agents: {
      getProvisionOptions: async () => ok(CLOUD_PROVISION_OPTIONS),
    },
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
  } as unknown as PlatformAdapter;
}

describe("DesktopApp company chrome, home channel opened by id before rows load", () => {
  it("shows the CompanyHero header for a stub row whose channelId matches the roster's homeChannelId", async () => {
    const fetchChannel = vi.fn(async (args: { channelId: string }) =>
      ok({
        messages: [],
        nextCursor: null,
        channel: { channelId: args.channelId, title: "Liverecover", companyUid: "cmp_liverecover", scope: "company" },
      }),
    );

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter({ fetchChannel }),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
        coreFixtures: false,
        initialRow: SETUP_ROW,
        companies: [LIVERECOVER],
      },
    });
    await settle();

    // Mirrors `ChatSidebar.openHomeChannelId()`'s fallback when the home
    // channel is not among the sidebar's already-loaded rows: it calls
    // `requestChannelOpen(homeChannelId, {})` with no title/companyUid hint,
    // so the resulting stub carries neither `channelScope` nor
    // `isCompanyHome`.
    requestChannelOpen(LIVERECOVER.homeChannelId!, {});
    await settle(12);

    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="channel-name"]')).toBeTruthy();
    });
    expect(host.querySelector('[data-testid="company-hero"]')).toBeTruthy();
  }, 15_000);
});
