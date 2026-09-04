// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const CHANNEL_ID = "chn_hq_dev";
const OLD_AT = "2026-08-18T16:09:15.946Z";
const INBOUND_AT = "2026-09-01T21:38:07.000Z";
/** The owner's own "Fleet agents incident update" send — newest in the thread. */
const OWN_SEND_AT = "2026-09-02T03:19:00.000Z";

const CHANNEL_ROW = {
  id: `ch:${CHANNEL_ID}`,
  kind: "channel",
  title: "hq-dev",
  channelId: CHANNEL_ID,
} as ConversationRow;

const THREAD_MESSAGES = [
  {
    eventId: "evt_old",
    fromPersonUid: "prs_jacob",
    fromDisplayName: "Jacob Posel",
    body: "Older inbound",
    createdAt: OLD_AT,
    direction: "in",
  },
  {
    eventId: "evt_in",
    fromPersonUid: "prs_jacob",
    fromDisplayName: "Jacob Posel",
    body: "Hey",
    createdAt: INBOUND_AT,
    direction: "in",
  },
  {
    eventId: "evt_own",
    fromPersonUid: "prs_me",
    fromDisplayName: "Corey",
    body: "Fleet agents incident update",
    createdAt: OWN_SEND_AT,
    direction: "out",
  },
];

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: THREAD_MESSAGES }),
      fetchDmThread: async () => ok({ messages: [] }),
    },
    notifications: {
      fetchDmInbox: async () => ok({ events: [] }),
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
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

describe("DesktopApp channel timeline stamps rail activity", () => {
  it("emits the newest channel timeline stamp once when a channel is opened", async () => {
    const bus = createChatWakeBus();
    const wakePayloads: Array<Record<string, unknown>> = [];
    bus.on("channel:new-message", (payload) => {
      wakePayloads.push(payload as unknown as Record<string, unknown>);
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
        initialRow: CHANNEL_ROW,
        wakes: bus,
        coreFixtures: false,
        seedDirectory: [
          {
            channelId: CHANNEL_ID,
            type: "company",
            scope: "company",
            companyUid: "cmp_indigo",
            name: "hq-dev",
            lastActivityAt: OLD_AT,
          },
        ],
      },
    });
    await settle();

    await vi.waitFor(() => {
      const mine = wakePayloads.filter((p) => p.channelId === CHANNEL_ID);
      expect(
        mine.length,
        "hydrate emits one activity stamp for the open channel",
      ).toBeGreaterThan(0);
      // The owner's own send is the newest message and must be the stamp.
      expect(mine[0]?.createdAt).toBe(OWN_SEND_AT);
      expect(mine[0]?.fromPersonUid).toBe("prs_me");
    });

    const before = wakePayloads.filter((p) => p.channelId === CHANNEL_ID).length;

    bus.emit("mesh:catchup", { reason: "focus" });
    await settle(12);

    expect(
      wakePayloads.filter((p) => p.channelId === CHANNEL_ID).length,
      "re-committing the same timeline must not emit a second stamp",
    ).toBe(before);
  });
});
