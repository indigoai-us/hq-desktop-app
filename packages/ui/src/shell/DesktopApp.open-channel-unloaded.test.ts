// @vitest-environment happy-dom

/**
 * Regression: the Companies section's `openHomeChannelId()` falls back to
 * `requestChannelOpen(id)` — the same generic "open a channel by id" path
 * notifications and deep links use — when the home channel isn't among the
 * sidebar's already-loaded rows (e.g. the "All" scope hasn't fetched that
 * company's channels yet). This pins that the shell actually NAVIGATES on
 * that event rather than silently dropping an id it doesn't recognize.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { requestChannelOpen, takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const SETUP_ROW: ConversationRow = {
  id: "ch:setup",
  kind: "channel",
  title: "setup",
  channelId: "setup",
  channelScope: "personal",
  companyUid: null,
} as ConversationRow;

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

describe("DesktopApp open-channel deep link, id not in loaded rows", () => {
  it("navigates to the channel even though it was never in searchRows/railRows", async () => {
    // The company's home channel is never returned by any directory/search
    // fetch here — this simulates the "All" scope click before that
    // company's channels have loaded, which `openHomeChannelId()` handles by
    // calling `requestChannelOpen(homeChannelId, {})` directly.
    const fetchChannel = vi.fn(async (args: { channelId: string }) =>
      ok({
        messages: [],
        nextCursor: null,
        channel: { channelId: args.channelId, title: "Indigo", companyUid: "cmp_indigo", scope: "company" },
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
      },
    });
    await settle();

    requestChannelOpen("chn_indigo_home", {});
    await settle(12);

    // The shell must not silently drop an id it has never seen in a loaded
    // row — it builds a stub (`conversationRowForDeepLink`) and navigates,
    // the same fallback a notification deep link to an unloaded channel
    // uses. Proven by the header actually switching to the requested
    // channel, not just the DOM event firing (the event always fires —
    // `requestChannelOpen` itself does that unconditionally).
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toBe(
        "chn_indigo_home",
      );
    });
  }, 15_000);
});
