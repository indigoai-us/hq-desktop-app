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

const CHANNEL_ROW = {
  id: "ch:chn_visual",
  kind: "channel",
  title: "HQ Visual Explorer",
  channelId: "chn_visual",
} as ConversationRow;

const HUMAN_PHOTO = "https://cdn.test/corey.jpg";
const SELF_PHOTO = "https://cdn.test/me.jpg";
const now = () => new Date().toISOString();

function adapter(opts: {
  members?: Array<Record<string, unknown>>;
  membersDelay?: () => Promise<void>;
  selfAvatarUrl?: string | null;
}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity: {
      getProfile: async () =>
        ok({
          profile: opts.selfAvatarUrl
            ? { avatarUrl: opts.selfAvatarUrl }
            : null,
        }),
    },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => {
        await opts.membersDelay?.();
        return ok({ members: [...(opts.members ?? [])] });
      },
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: [] }),
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

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountChannel(opts: {
  members?: Array<Record<string, unknown>>;
  membersDelay?: () => Promise<void>;
  selfAvatarUrl?: string | null;
  messages: Array<Record<string, unknown>>;
}): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(opts),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow: CHANNEL_ROW,
      wakes: createChatWakeBus(),
      coreFixtures: false,
      messagesByRow: () => opts.messages,
      seedDirectory: [
        {
          channelId: "chn_visual",
          type: "project",
          scope: "project",
          companyUid: "cmp_1",
          name: "HQ Visual Explorer",
          lastActivityAt: now(),
        },
      ],
    },
  });
  await settle();
}

describe("DesktopApp channel message avatars", () => {
  it("renders a human roster photo on a channel message row", async () => {
    await mountChannel({
      members: [
        {
          personUid: "prs_corey",
          displayName: "Corey",
          avatarUrl: HUMAN_PHOTO,
        },
      ],
      messages: [
        {
          eventId: "evt_human",
          direction: "in",
          fromPersonUid: "prs_corey",
          fromDisplayName: "Corey Epstein",
          body: "hello",
          createdAt: "2026-08-28T01:14:00.000Z",
        },
      ],
    });

    await vi.waitFor(() => {
      expect(
        host
          .querySelector(".dm-msg-avatar img.avatar-img")
          ?.getAttribute("src"),
      ).toBe(HUMAN_PHOTO);
    });
  });

  it("renders the signed-in user's own photo on their channel messages", async () => {
    await mountChannel({
      selfAvatarUrl: SELF_PHOTO,
      messages: [
        {
          eventId: "evt_self",
          direction: "out",
          fromPersonUid: "prs_me",
          fromDisplayName: "Corey",
          body: "mine",
          createdAt: "2026-08-28T01:14:00.000Z",
        },
      ],
    });

    await vi.waitFor(() => {
      expect(
        host
          .querySelector(".dm-msg-avatar img.avatar-img")
          ?.getAttribute("src"),
      ).toBe(SELF_PHOTO);
    });
  });

  it("updates the row when the roster photo arrives after first render", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mountChannel({
      membersDelay: () => gate,
      members: [
        {
          personUid: "prs_jacob",
          displayName: "Jacob",
          avatarUrl: "https://cdn.test/jacob.jpg",
        },
      ],
      messages: [
        {
          eventId: "evt_jacob",
          direction: "in",
          fromPersonUid: "prs_jacob",
          fromDisplayName: "Jacob Posel",
          body: "hey",
          createdAt: "2026-08-28T01:14:00.000Z",
        },
      ],
    });

    expect(host.querySelector(".dm-msg-avatar .monogram")?.textContent).toBe(
      "JP",
    );
    expect(host.querySelector(".dm-msg-avatar img")).toBeNull();

    release();
    await vi.waitFor(() => {
      expect(
        host
          .querySelector(".dm-msg-avatar img.avatar-img")
          ?.getAttribute("src"),
      ).toBe("https://cdn.test/jacob.jpg");
    });
  });

  it("renders a generated avatar for an agent with no roster photo", async () => {
    await mountChannel({
      messages: [
        {
          eventId: "evt_izzy",
          direction: "in",
          fromPersonUid: "agt_izzy",
          fromDisplayName: "Izzy",
          body: "on it",
          createdAt: "2026-08-28T01:14:00.000Z",
        },
      ],
    });

    await vi.waitFor(() => {
      const src = host
        .querySelector(".dm-msg-avatar img.avatar-img")
        ?.getAttribute("src");
      expect(agentAvatarAssets).toContain(src);
    });
  });
});
