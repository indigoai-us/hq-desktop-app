// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const DM_ROW = {
  id: "dm:agt_izzy",
  kind: "dm",
  title: "Izzy",
  personUid: "agt_izzy",
  companyUid: "cmp_indigo",
} as ConversationRow;

const HUMAN_ROW = {
  id: "dm:prs_someone",
  kind: "dm",
  title: "Dana",
  personUid: "prs_someone",
} as ConversationRow;

function adapter(overrides: {
  selectAgentAvatar?: PlatformAdapter["identity"]["selectAgentAvatar"];
  listContacts?: PlatformAdapter["messaging"]["listContacts"];
} = {}): PlatformAdapter {
  const selectAgentAvatar =
    overrides.selectAgentAvatar ??
    (async () =>
      ok({
        uid: "agt_izzy",
        avatarUrl:
          "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/agents/agt_izzy/hash.png",
      }));
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity: {
      getProfile: async () => ok({ profile: null }),
      updateAgentProfile: async () =>
        ok({
          uid: "agt_izzy",
          profile: { avatarBase64: "cHJldmlldw==" },
          slackUpdated: false,
        }),
      listAvatarPacks: async () =>
        ok({
          packs: [
            {
              id: "animals",
              name: "Animals",
              version: "1.0.0",
              author: { handle: "lizzy", displayName: "Lizzy" },
              count: 1,
            },
          ],
          expiresAt: Date.now() + 60_000,
        }),
      getAvatarPack: async () =>
        ok({
          id: "animals",
          name: "Animals",
          version: "1.0.0",
          author: { handle: "lizzy", displayName: "Lizzy" },
          count: 1,
          items: [
            {
              id: "v2-dot",
              name: "Dot",
              tags: ["rabbit"],
              thumbUrl:
                "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/avatar-packs/animals/thumbs/v2-dot.png",
              fullUrl:
                "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/avatar-packs/animals/items/v2-dot.png",
            },
          ],
          expiresAt: Date.now() + 60_000,
        }),
      selectAgentAvatar,
    },
    agents: {
      getStatus: async () =>
        ok({
          agent: {
            uid: "agt_izzy",
            name: "Izzy",
            companyUid: "cmp_indigo",
            profile: { displayName: "Izzy" },
            runtime: { status: "running" },
          },
          setupState: { phase: "ready" },
        }),
      listMobileRoster: async () => ok({ agents: [] }),
      listJobs: async () => ok({ jobs: [] }),
      pauseJob: async () => ok({}),
      updateProfile: async () => ok({}),
      stop: async () => ok({}),
      start: async () => ok({}),
      deprovision: async () => ok({}),
      listOwners: async () => ok({ owners: [] }),
      getCompanyTelemetry: async () => ok({ perMember: [] }),
    },
    messaging: {
      listContacts:
        overrides.listContacts ?? (async () => ok({ contacts: [] })),
      listChannelMembers: async () => ok({ members: [] }),
      fetchDmThread: async () => ok({ messages: [] }),
      sendDm: async () =>
        ok({ eventId: "evt_1", createdAt: new Date().toISOString() }),
      fetchReactions: async () => ok({ reactions: [] }),
    },
    meetings: {
      listUpcoming: async () => ok([]),
      listMemberships: async () => ok([]),
    },
    notifications: {
      fetchDmInbox: async () => ok({}),
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({
        ok: false as const,
        reason: "unavailable",
      }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("missing", { status: 404 })),
  );
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow: DM_ROW,
      wakes: createChatWakeBus(),
      coreFixtures: false,
      isAdmin: true,
      ...extra,
    },
  });
  await settle();
}

describe("DesktopApp agent avatar picker", () => {
  it("shows Edit profile on an agent DM the caller can admin", async () => {
    await mountApp();
    expect(host.querySelector('[data-testid="agent-edit-profile"]')).not.toBeNull();
  });

  it("hides Edit profile for humans and for callers who cannot admin", async () => {
    await mountApp({ isAdmin: false });
    expect(host.querySelector('[data-testid="agent-edit-profile"]')).toBeNull();

    await unmount(component!);
    component = null;
    host.remove();
    await mountApp({ isAdmin: true, initialRow: HUMAN_ROW });
    expect(host.querySelector('[data-testid="agent-edit-profile"]')).toBeNull();
  });

  it("opens the pack picker from Edit profile", async () => {
    await mountApp();
    (
      host.querySelector(
        '[data-testid="agent-edit-profile"]',
      ) as HTMLButtonElement
    ).click();
    await settle();
    expect(host.querySelector('[data-testid="agent-detail-panel"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="agent-detail-avatar-picker-slot"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-pack-picker"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-use-generated"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-pack-save"]')).not.toBeNull();
  });

  it("selects a pack item through the adapter and refreshes contacts", async () => {
    const selectAgentAvatar = vi.fn(async () =>
      ok({
        uid: "agt_izzy",
        avatarUrl:
          "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/agents/agt_izzy/hash.png",
      }),
    );
    const listContacts = vi.fn(async () => ok([]));
    await mountApp({ adapter: adapter({ selectAgentAvatar, listContacts }) });
    (
      host.querySelector(
        '[data-testid="agent-edit-profile"]',
      ) as HTMLButtonElement
    ).click();
    await settle(20);
    const tile = host.querySelector(
      '[data-item="v2-dot"]',
    ) as HTMLButtonElement | null;
    expect(tile).not.toBeNull();
    tile?.click();
    await settle();
    (
      host.querySelector('[data-testid="avatar-pack-save"]') as HTMLButtonElement
    ).click();
    await settle(20);
    expect(selectAgentAvatar).toHaveBeenCalledWith("agt_izzy", {
      packId: "animals",
      itemId: "v2-dot",
    });
    expect(listContacts).toHaveBeenCalled();
  });
});
