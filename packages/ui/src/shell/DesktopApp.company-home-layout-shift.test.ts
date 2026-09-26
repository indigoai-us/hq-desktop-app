// @vitest-environment happy-dom

/**
 * Regression: opening a company home channel by id (deep link, notification,
 * or a Companies-row click before that company's rows are loaded) used to
 * paint the header without the hero, without reserved header-control slots,
 * and with skeleton rows before the real message list mounted — each
 * arrival reflowed the pane. The fix reserves the hero, the member-count
 * pill, and the mute control at their final size from the very first
 * render, and matches skeleton-row geometry to the empty state so nothing
 * downstream moves once data resolves.
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

const RAMEN_BAE: Workspace = {
  slug: "ramen-bae",
  displayName: "Ramen Bae",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_ramenbae",
  bucketName: "hq-vault-ramenbae",
  hasLocalFolder: true,
  localPath: "/tmp/HQ/companies/ramen-bae",
  membershipStatus: "active",
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
  homeChannelId: "chn_01RAMENBAEHOMECHANNELID000",
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
      setChannelNotifyLevel: async () => ok({}),
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

describe("DesktopApp company-home channel: no layout shift on load", () => {
  it("reserves the hero and header-control slots at final size before any async data resolves, and keeps them stable once it does", async () => {
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
                  name: "Ramen Bae Home",
                  companyUid: "cmp_ramenbae",
                  scope: "company",
                  memberCount: 7,
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
        adapter: adapter({ fetchChannel: fetchChannel as unknown as PlatformAdapter["messaging"]["fetchChannel"] }),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
        coreFixtures: false,
        initialRow: SETUP_ROW,
        companies: [RAMEN_BAE],
      },
    });
    await settle();

    // Same open path as a Companies-row click into a company whose rows
    // have not loaded yet: `requestChannelOpen` with the slug as a hint.
    requestChannelOpen(RAMEN_BAE.homeChannelId!, {
      title: RAMEN_BAE.slug,
      companyUid: RAMEN_BAE.cloudUid,
    });
    await settle(4);

    const hero = () => host.querySelector<HTMLElement>('[data-testid="company-hero"]');
    const memberPill = () => host.querySelector<HTMLElement>('[data-testid="channel-members"]');
    const skeleton = () => host.querySelector('[data-testid="conversation-skeleton"]');

    // First render, before `fetchChannel` resolves: the hero and the
    // member-count slot must already exist at their final fixed size.
    await vi.waitFor(() => expect(hero()).toBeTruthy());
    expect(getComputedStyle(hero()!).height).toBe("140px");
    const heroWidthBefore = hero()!.getBoundingClientRect;

    await vi.waitFor(() => expect(memberPill()).toBeTruthy());
    const pillRectBefore = getComputedStyle(memberPill()!);
    expect(pillRectBefore.padding).toBe("5px 12px");

    // Cold-open skeleton rows stand in for the real messages until the
    // timeline resolves — same row geometry either way (see
    // `.thread-skeleton-row` in ChannelConversation.svelte).
    expect(skeleton()).toBeTruthy();

    // Now resolve the channel-get call: real metadata lands.
    await vi.waitFor(() => expect(resolveFetch).toBeTruthy());
    resolveFetch!(undefined);
    await settle(12);

    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toBe("Ramen Bae Home");
    });

    // The hero is still exactly the same fixed height after the company
    // name/wallpaper data resolves — nothing pushed it taller.
    expect(hero()).toBeTruthy();
    expect(getComputedStyle(hero()!).height).toBe("140px");
    expect(hero()!.getBoundingClientRect).toBe(heroWidthBefore);

    // The member pill never disappeared and never re-mounted — same node,
    // same reserved geometry, now showing the real count.
    expect(memberPill()).toBeTruthy();
    expect(getComputedStyle(memberPill()!).padding).toBe("5px 12px");
  }, 15_000);
});
