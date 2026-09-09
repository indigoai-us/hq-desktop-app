// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";
import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

// Task chips in the REAL desktop shell (the surface the Messages window
// renders). Rooms: chips live only inside the thread they were spawned from;
// the main pane carries none. DMs with an agent: the agent-wide view renders
// beneath the conversation. Payload shapes are what production returns.

const DEACON = "agt_01KTX6WQ6SYH3TZGF3DSDRPGGD";
const ROOM = "chn_01M0VBWPD2SQ41EQV2SACNQ23J";
const ROOT_A = "evt_root_a";
const ROOT_B = "evt_root_b";
const ROOM_PAYLOAD = {
  agentUid: DEACON,
  channelId: ROOM,
  tasks: [
    {
      taskId: "t20260905T013151Z-4c14affa",
      title: "Room inventory sweep",
      status: "working",
      originMessageId: ROOT_A,
      lastEventAt: "2026-09-05T01:31:51Z",
    },
    {
      taskId: "t20260904T232556Z-628c6c6a",
      title: "Recent project files",
      status: "done",
      originMessageId: ROOT_B,
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
const ROOT_MESSAGES = [
  {
    eventId: ROOT_A,
    body: "@Deacon sweep the room",
    fromPersonUid: "prs_me",
    fromDisplayName: "Corey",
    createdAt: "2026-09-05T01:30:00Z",
    direction: "out",
    replyCount: 1,
  },
  {
    eventId: ROOT_B,
    body: "@Deacon recent files please",
    fromPersonUid: "prs_me",
    fromDisplayName: "Corey",
    createdAt: "2026-09-04T23:20:00Z",
    direction: "out",
    replyCount: 1,
  },
];

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
      fetchChannel: async () => ok({ messages: [...ROOT_MESSAGES].reverse() }),
      fetchReplyThread: async () => ok({ messages: [] }),
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

function chipsIn(root: Element | Document): string[] {
  return [...root.querySelectorAll('[data-testid="task-chip"]')].map(
    (el) => el.getAttribute("aria-label") ?? "",
  );
}

describe("DesktopApp task chips", () => {
  it("keeps the main room pane clean and shows a thread's own chips when that thread is opened", async () => {
    const listChannelAgentTasks = vi.fn(async () => ok(ROOM_PAYLOAD));
    const listAgentTasks = vi.fn(async () => ok(AGENT_PAYLOAD));
    await mountApp({ listChannelAgentTasks, listAgentTasks }, CHANNEL_ROW);
    expect(listChannelAgentTasks).toHaveBeenCalledWith(DEACON, ROOM);
    expect(listAgentTasks).not.toHaveBeenCalled();
    // Main pane: no strip — a room-wide strip would mix every thread's work.
    expect(host.querySelector('[data-testid="agent-task-strip"]')).toBeNull();

    // Open the thread of ROOT_A via its replies affordance.
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="message-replies"]')];
    expect(buttons.length, "reply affordances render for both roots").toBe(2);
    const rootA = host.querySelector(`[data-event-id="${ROOT_A}"]`) ?? buttons[1].closest("[data-event-id]");
    const openA = (rootA?.querySelector('[data-testid="message-replies"]') as HTMLButtonElement | null) ?? buttons[1];
    openA.click();
    await settle(16);
    const panel = host.querySelector('[data-testid="reply-panel"]');
    expect(panel, "thread panel opens").not.toBeNull();
    const inThread = chipsIn(panel!);
    expect(inThread.length, "only the task spawned from this root").toBe(1);
    expect(inThread[0]).toMatch(/^(Room inventory sweep|Recent project files), /);
    // Still nothing in the main pane.
    expect(host.querySelectorAll('[data-testid="agent-task-strip"]').length).toBe(1);
  });

  it("shows chips in a DM with an agent from the agent-wide view", async () => {
    const listAgentTasks = vi.fn(async () => ok(AGENT_PAYLOAD));
    await mountApp({ listAgentTasks }, DM_ROW);
    expect(listAgentTasks).toHaveBeenCalledWith(DEACON);
    expect(host.querySelectorAll('[data-testid="task-chip"]').length).toBe(1);
    // Hover card carries the detail the chip alone does not.
    const card = host.querySelector('[data-testid="task-chip-card"]');
    expect(card?.textContent).toContain("Slow inventory sweep");
    expect(card?.textContent).toContain("Working in the background");
  });

  it("polls nothing and renders nothing when the host has no task views", async () => {
    await mountApp({}, CHANNEL_ROW);
    expect(host.querySelector('[data-testid="agent-task-strip"]')).toBeNull();
  });
});
