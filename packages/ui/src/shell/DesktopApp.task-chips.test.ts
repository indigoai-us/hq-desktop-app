// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";
import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

// Regression for the room-scoped task chips (v0.10.195 → v0.10.200): the
// strip was wired into views the desktop Messages window never renders. This
// mounts the REAL shell the window uses and asserts the chips appear beneath
// the conversation for a channel with an agent on its roster, and for a DM
// with an agent — using the exact payload shapes production returns.

const DEACON = "agt_01KTX6WQ6SYH3TZGF3DSDRPGGD";
const ROOM = "chn_01M0VBWPD2SQ41EQV2SACNQ23J";
const ROOM_PAYLOAD = {
  agentUid: DEACON,
  channelId: ROOM,
  tasks: [
    {
      taskId: "t20260905T013151Z-4c14affa",
      title: "Room inventory sweep",
      status: "working",
      originMessageId: "3fddab28",
      lastEventAt: "2026-09-05T01:31:51Z",
    },
    {
      taskId: "t20260904T232556Z-628c6c6a",
      title: "Recent project files",
      status: "done",
      originMessageId: "a1b2c3",
      lastEventAt: "2026-09-04T23:27:17Z",
    },
  ],
};
const AGENT_PAYLOAD = {
  agentUid: DEACON,
  running: { count: 1, tasks: [{ taskId: "t-dm-1", title: "Slow inventory sweep" }] },
  queued: { count: 0, tasks: [] },
  recentTerminal: [],
};

interface Fx {
  listChannelAgentTasks?: ReturnType<typeof vi.fn>;
  listAgentTasks?: ReturnType<typeof vi.fn>;
}

function adapter(fx: Fx): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () =>
        ok({
          members: [
            { channelId: ROOM, personUid: DEACON, displayName: "Deacon", role: "member" },
            { channelId: ROOM, personUid: "prs_me", displayName: "Corey", role: "owner" },
          ],
        }),
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: [] }),
      sendChannelMessage: async () => ok({ eventId: "evt_1", createdAt: new Date().toISOString() }),
      ...(fx.listChannelAgentTasks ? { listChannelAgentTasks: fx.listChannelAgentTasks } : {}),
      ...(fx.listAgentTasks ? { listAgentTasks: fx.listAgentTasks } : {}),
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

const CHANNEL_ROW: ConversationRow = {
  id: `ch:${ROOM}`,
  kind: "channel",
  title: "work-desktop-dogfood",
  channelId: ROOM,
} as ConversationRow;

const DM_ROW: ConversationRow = {
  id: `dm:${DEACON}`,
  kind: "dm",
  title: "Deacon",
  personUid: DEACON,
} as ConversationRow;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mountApp(fx: Fx, initialRow: ConversationRow) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(fx),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow,
      mentionCandidates: [],
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await settle();
}

describe("DesktopApp task chips", () => {
  it("renders room-scoped chips beneath a channel conversation with an agent on the roster", async () => {
    const listChannelAgentTasks = vi.fn(async () => ok(ROOM_PAYLOAD));
    const listAgentTasks = vi.fn(async () => ok(AGENT_PAYLOAD));
    await mountApp({ listChannelAgentTasks, listAgentTasks }, CHANNEL_ROW);
    expect(listChannelAgentTasks).toHaveBeenCalledWith(DEACON, ROOM);
    expect(listAgentTasks).not.toHaveBeenCalled();
    const strip = host.querySelector('[data-testid="agent-task-strip"]');
    expect(strip, "strip renders beneath the conversation").not.toBeNull();
    const chips = strip!.querySelectorAll('[data-testid="task-chip"]');
    expect(chips.length).toBe(2);
    expect(chips[0].getAttribute("aria-label")).toMatch(/^Room inventory sweep, Working/);
    // Same placement contract as the thinking row: inside the conversation,
    // after the messages, before the composer.
    const composer = host.querySelector('[data-testid="conversation-composer"]');
    expect(composer, "composer renders").not.toBeNull();
    expect(strip!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows chips in a DM with an agent from the agent-wide view", async () => {
    const listAgentTasks = vi.fn(async () => ok(AGENT_PAYLOAD));
    await mountApp({ listAgentTasks }, DM_ROW);
    expect(listAgentTasks).toHaveBeenCalledWith(DEACON);
    expect(host.querySelectorAll('[data-testid="task-chip"]').length).toBe(1);
  });

  it("polls nothing and renders nothing when the host has no task views", async () => {
    await mountApp({}, CHANNEL_ROW);
    expect(host.querySelector('[data-testid="agent-task-strip"]')).toBeNull();
  });
});
