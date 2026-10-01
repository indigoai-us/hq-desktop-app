// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter, createSyncPlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationMessageWire } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const CHANNEL_ROW = {
  id: "ch:chn_visual",
  kind: "channel",
  title: "HQ Visual Explorer",
  channelId: "chn_visual",
} as ConversationRow;

const now = () => new Date().toISOString();

function adapter(opts: {
  members?: Array<Record<string, unknown>>;
  membersDelay?: () => Promise<void>;
  selfAvatarUrl?: string | null;
  identityFeature?: Partial<PlatformAdapter["identity"]>;
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
      ...(opts.identityFeature ?? {}),
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
  identityFeature?: Partial<PlatformAdapter["identity"]>;
  messages: ConversationMessageWire[];
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

const MESH_NOTE =
  '{"v":1,"kind":"work-session-event","threadId":"work-desktop-dogfood:T-009","event":{"kind":"note","at":"2026-08-28T15:14:05.854Z","by":"Stefan Johnson","summary":"mesh-noted-xyz"}}';

const MESSAGES: ConversationMessageWire[] = [
  { eventId: "e_note", direction: "in", fromPersonUid: "prs_stefan", fromDisplayName: "Stefan Johnson", body: MESH_NOTE, createdAt: "2026-08-28T15:14:05.000Z" },
  { eventId: "e_bot", direction: "in", fromPersonUid: "bot_izzy", fromDisplayName: "Izzy", audience: "bot", body: "bot-audience-xyz", createdAt: "2026-08-28T15:14:06.000Z" },
  { eventId: "e_human", direction: "in", fromPersonUid: "prs_corey", fromDisplayName: "Corey", body: "human-hello-xyz", createdAt: "2026-08-28T15:14:07.000Z" },
] as ConversationMessageWire[];

// The desktop adapter pins the flag on; route its identity methods through
// the real sync adapter so this covers adapter -> DesktopApp -> timeline.
function desktopIdentity(): Partial<PlatformAdapter["identity"]> {
  const real = createSyncPlatformAdapter({
    invoke: async (cmd) => {
      if (cmd === "hq_pro_fetch") {
        return { status: 200, body: JSON.stringify({ version: 1, flags: { "desktop.human-only-conversations": false } }) };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  });
  return {
    hasFeature: real.identity.hasFeature,
    subscribeFeature: real.identity.subscribeFeature,
  };
}

describe("DesktopApp human-only conversations default", () => {
  it("desktop adapter: hides mesh noted rows and bot-audience messages, keeps human messages", async () => {
    await mountChannel({ identityFeature: desktopIdentity(), messages: MESSAGES });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("human-hello-xyz");
    });
    await settle();
    expect(host.textContent).not.toContain("mesh-noted-xyz");
    expect(host.querySelector(".work-mesh-row")).toBeNull();
    expect(host.textContent).not.toContain("bot-audience-xyz");
  });

  it("an adapter answering false turns the filter off", async () => {
    await mountChannel({
      identityFeature: {
        hasFeature: async () => ok(false),
        subscribeFeature: () => () => {},
      },
      messages: MESSAGES,
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("bot-audience-xyz");
    });
    expect(host.textContent).toContain("human-hello-xyz");
  });
});
