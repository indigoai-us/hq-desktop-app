// @vitest-environment happy-dom

/**
 * Regression: opening a company's home channel via `requestChannelOpen`
 * before that company's rows are loaded (the Companies-row click path when
 * the "All" scope hasn't fetched that company's channels yet — same path a
 * notification or deep link takes into an unseen channel) built a bare stub
 * row with no display hint, so the channel title bar and composer
 * placeholder showed the raw `chn_…` id instead of a name. Verified live:
 * clicking Liverecover in the Companies section opened its home channel
 * with the company header, but the title read
 * "chn_01M3C8NWK6KAE8ZY6BWBD61XTG".
 *
 * The fix: `ChatSidebar.openHomeChannelId()` now seeds `requestChannelOpen`
 * with the company's slug as a display hint, so the stub is titled with the
 * slug (never the raw id) from the first paint. Once `fetchChannel` (the
 * channel-get call the timeline fetch already makes) returns the channel's
 * own metadata, `DesktopApp.hydrateStubChannelRow` adopts the real name.
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
  homeChannelId: "chn_01M3C8NWK6KAE8ZY6BWBD61XTG",
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

describe("DesktopApp home-channel title, opened by id before rows load", () => {
  it("shows the company slug (never the raw channel id), then the real name once fetched", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    const fetchChannel = vi.fn(
      async (args: { channelId: string }) =>
        new Promise((resolve) => {
          resolveFetch = () =>
            resolve(
              ok({
                messages: [],
                nextCursor: null,
                channel: {
                  channelId: args.channelId,
                  name: "Liverecover Home",
                  companyUid: "cmp_liverecover",
                  scope: "company",
                },
              }),
            );
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

    // Mirrors `ChatSidebar.openCompanyHome()` -> `openHomeChannelId()`: the
    // home channel is known from the roster but not among the sidebar's
    // already-loaded rows, so it opens via `requestChannelOpen` with the
    // company slug as the display hint.
    requestChannelOpen(LIVERECOVER.homeChannelId!, {
      title: LIVERECOVER.slug,
      companyUid: LIVERECOVER.cloudUid,
    });
    await settle(12);

    // Before the channel-get call resolves, the title must never be the raw
    // id — it should read the company slug.
    const titleEl = () => host.querySelector('[data-testid="channel-name"]');
    await vi.waitFor(() => expect(titleEl()).toBeTruthy());
    expect(titleEl()?.textContent).toBe("liverecover");
    expect(titleEl()?.textContent).not.toContain("chn_");

    // Once the channel-get metadata lands, the real name replaces the stub
    // slug placeholder.
    await vi.waitFor(() => expect(resolveFetch).toBeTruthy());
    resolveFetch!(undefined);
    await settle(12);

    await vi.waitFor(() => {
      expect(titleEl()?.textContent).toBe("Liverecover Home");
    });
    expect(titleEl()?.textContent).not.toContain("chn_");
  }, 15_000);
});
