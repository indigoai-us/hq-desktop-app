// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { InboxDmActivity } from "../chat/live-catchup.js";

const PEER = "prs_jacob";
const DELEGATION_AT = "2026-08-18T16:09:15.946Z";
const INBOUND_AT = "2026-09-01T21:38:07.000Z";
const OUTBOUND_AT = "2026-09-01T21:38:30.000Z";

const DM_ROW = {
  id: `dm:${PEER}`,
  kind: "dm",
  title: "Jacob Posel",
  personUid: PEER,
  companyUid: null,
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
} as ConversationRow;

const THREAD_MESSAGES = [
  {
    eventId: "evt_out",
    fromPersonUid: "prs_me",
    fromDisplayName: "Corey",
    body: "Hey there",
    createdAt: OUTBOUND_AT,
    direction: "out",
  },
  {
    eventId: "evt_in",
    fromPersonUid: PEER,
    fromDisplayName: "Jacob Posel",
    body: "Hey",
    createdAt: INBOUND_AT,
    direction: "in",
  },
  {
    eventId: "evt_delegation",
    fromPersonUid: PEER,
    fromDisplayName: "Jacob Posel",
    body: "",
    details: "Hand this off to Deacon",
    prompt: "Please take the next step",
    createdAt: DELEGATION_AT,
    direction: "in",
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
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: THREAD_MESSAGES }),
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

describe("DesktopApp DM timeline stamps rail activity", () => {
  it("emits the newest timeline stamp once when a DM thread is opened", async () => {
    const bus = createChatWakeBus();
    const activityPayloads: InboxDmActivity[][] = [];
    bus.on("dm:pair-unreads", (payload) => {
      if (Array.isArray(payload.activity) && payload.activity.length > 0) {
        activityPayloads.push(payload.activity);
      }
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
        initialRow: DM_ROW,
        wakes: bus,
        coreFixtures: false,
      },
    });
    await settle();

    await vi.waitFor(() => {
      const stamps = activityPayloads.flat().filter((entry) => entry.personUid === PEER);
      expect(stamps.length, "hydrate emits one activity stamp for the open DM").toBeGreaterThan(
        0,
      );
      expect(stamps[0]?.lastMessageAt).toContain("21:38:30");
    });

    const beforeCatchup = activityPayloads
      .flat()
      .filter((entry) => entry.personUid === PEER).length;

    bus.emit("mesh:catchup", { reason: "focus" });
    await settle(12);

    const afterCatchup = activityPayloads
      .flat()
      .filter((entry) => entry.personUid === PEER).length;
    expect(
      afterCatchup,
      "re-committing the same timeline must not emit a second activity payload",
    ).toBe(beforeCatchup);
  });
});
