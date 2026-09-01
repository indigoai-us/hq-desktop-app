// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import { agentAvatarAssets } from "../chat/messaging/agent-avatars";

interface Fixture {
  messages: Array<Record<string, unknown>>;
  failSend: boolean;
  toggleReaction: ReturnType<typeof vi.fn>;
  members: Array<Record<string, unknown>>;
}

function adapter(fx: Fixture): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [...fx.members] }),
      fetchChannel: async () => ok({ messages: [...fx.messages].reverse() }),
      fetchDmThread: async () =>
        ok({ messages: [...fx.messages].reverse() }),
      sendDm: async () =>
        fx.failSend
          ? { ok: false as const, reason: "unavailable", message: "nope" }
          : ok({
              eventId: "evt_self_1",
              createdAt: new Date().toISOString(),
            }),
      sendChannelMessage: async () =>
        ok({
          eventId: "evt_self_1",
          createdAt: new Date().toISOString(),
        }),
      toggleReaction: fx.toggleReaction,
      fetchReactions: async () => ok({ reactions: [] }),
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

const DM_ROW = {
  id: "dm:agt_izzy",
  kind: "dm",
  title: "Izzy",
  personUid: "agt_izzy",
} as ConversationRow;

const HUMAN_ROW = {
  id: "dm:prs_someone",
  kind: "dm",
  title: "Dana",
  personUid: "prs_someone",
} as ConversationRow;

const CHANNEL_ROW = {
  id: "ch:chn_proj",
  kind: "channel",
  title: "launch",
  channelId: "chn_proj",
} as ConversationRow;

const PHOTO_URL = "https://cdn.test/agent.png";
const now = () => new Date().toISOString();

function createFx(overrides: Partial<Fixture> = {}): Fixture {
  return {
    messages: [],
    failSend: false,
    toggleReaction: vi.fn(async () => ok(undefined)),
    members: [],
    ...overrides,
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(
  fx: Fixture,
  wakes = createChatWakeBus(),
  row: ConversationRow = DM_ROW,
  extra: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(fx),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow: row,
      wakes,
      coreFixtures: false,
      ...extra,
    },
  });
  await settle();
  return wakes;
}

function headerAvatar(): HTMLElement {
  const el = host.querySelector<HTMLElement>(
    '[data-testid="channel-header-avatar"]',
  );
  expect(el, "DM header avatar renders").toBeTruthy();
  return el!;
}

describe("DesktopApp DM header avatar", () => {
  it("renders a generated agent avatar in the DM header", async () => {
    await mountApp(createFx());

    const header = headerAvatar();
    const img = header.querySelector("img.avatar-img");
    expect(img, "agent DM header shows a generated photo").toBeTruthy();
    expect(agentAvatarAssets).toContain(img?.getAttribute("src"));
  });

  it("renders monogram initials in a human DM header", async () => {
    await mountApp(createFx(), createChatWakeBus(), HUMAN_ROW);

    const header = headerAvatar();
    expect(header.querySelector("img.avatar-img")).toBeNull();
    expect(header.querySelector(".monogram")?.textContent).toBe("DA");
  });

  it("prefers a roster photo when the agent appears on a loaded channel", async () => {
    // fixtures.ts has no listChannelMembers; the PlatformAdapter test double
    // is the seam that returns roster rows with avatarUrl. Open a chn_*
    // channel first so DesktopApp hydrates avatarByUid, then the agent DM.
    const sidebarApi = createFixtureChatSidebarApi();
    const fx = createFx({
      members: [
        {
          personUid: "agt_photo",
          displayName: "Photo Agent",
          avatarUrl: PHOTO_URL,
        },
      ],
    });
    await mountApp(fx, createChatWakeBus(), CHANNEL_ROW, {
      sidebarApi: {
        ...sidebarApi,
        listContacts: async () => ({
          contacts: [
            {
              personUid: "agt_photo",
              displayName: "Photo Agent",
              lastActivityAt: now(),
              lastDmAt: now(),
            },
          ],
        }),
      },
      seedDirectory: [
        {
          channelId: "chn_proj",
          type: "project",
          scope: "project",
          companyUid: "cmp_1",
          name: "launch",
          lastActivityAt: now(),
        },
      ],
    });

    const dm = await vi.waitFor(() => {
      const btn = host.querySelector<HTMLButtonElement>(
        '[data-conversation-id="dm:agt_photo"]',
      );
      expect(btn, "agent DM row is in the rail").toBeTruthy();
      return btn!;
    });
    dm.click();
    await settle(10);

    const header = headerAvatar();
    expect(header.querySelector("img.avatar-img")?.getAttribute("src")).toBe(
      PHOTO_URL,
    );
  });
});
