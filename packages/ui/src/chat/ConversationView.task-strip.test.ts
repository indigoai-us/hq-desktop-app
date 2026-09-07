// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ConversationView from "./ConversationView.svelte";
import type { ConversationApi } from "./chat-api";
import type { ConversationRow } from "./sidebar-model";

// Regression for the room-scoped task chips (hq-pro #3035 / v0.10.195):
// the strip was first wired into the popover-era ChannelView, which the
// desktop Messages window never renders. This mounts the SHARED view that
// window actually uses, with the exact payload shape production returned.

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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};

function api(over: Partial<ConversationApi> = {}): ConversationApi {
  return {
    fetchChannel: async () => ({ messages: [], nextCursor: null }),
    sendChannelMessage: async () => {},
    fetchDmThread: async () => ({ messages: [], nextCursor: null }),
    sendDm: async () => {},
    fetchReplyThread: async () => ({ messages: [], nextCursor: null }),
    sendReply: async () => {},
    runCardAction: async () => ({}),
    ...over,
  } as ConversationApi;
}

function roomRow(): ConversationRow {
  return {
    id: `ch:${ROOM}`,
    kind: "channel",
    title: "work-desktop-dogfood",
    companyUid: "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    channelId: ROOM,
    members: [
      { personUid: DEACON, displayName: "Deacon" },
      { personUid: "per_01CORY", displayName: "Corey" },
    ],
  } as ConversationRow;
}

describe("ConversationView task strip", () => {
  it("renders room-scoped chips for a channel with an agent member", async () => {
    const listChannelAgentTasks = vi.fn(async () => ROOM_PAYLOAD);
    const listAgentTasks = vi.fn(async () => AGENT_PAYLOAD);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ConversationView, {
      target: host,
      props: { api: api({ listChannelAgentTasks, listAgentTasks }), row: roomRow() },
    });
    await settle();
    expect(listChannelAgentTasks).toHaveBeenCalledWith({ agentUid: DEACON, channelId: ROOM });
    expect(listAgentTasks).not.toHaveBeenCalled();
    const strip = host.querySelector('[data-testid="agent-task-strip"]');
    expect(strip).not.toBeNull();
    const chips = strip!.querySelectorAll('[data-testid="task-chip"]');
    // The live task shows; the task that finished yesterday has aged out.
    expect(chips.length).toBe(1);
    expect(chips[0].getAttribute("aria-label")).toMatch(/^Room inventory sweep, Working/);
    // The strip sits between the message list and the composer.
    const composer = host.querySelector('[data-testid="conversation-composer"]');
    expect(strip!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("falls back to the agent-wide view when the room route is unavailable", async () => {
    const listChannelAgentTasks = vi.fn(async () => {
      throw new Error("not available for this room");
    });
    const listAgentTasks = vi.fn(async () => AGENT_PAYLOAD);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ConversationView, {
      target: host,
      props: { api: api({ listChannelAgentTasks, listAgentTasks }), row: roomRow() },
    });
    await settle();
    expect(listAgentTasks).toHaveBeenCalledWith({ agentUid: DEACON });
    expect(host.querySelectorAll('[data-testid="task-chip"]').length).toBe(1);
  });

  it("shows chips in a DM with an agent, using the agent-wide view", async () => {
    const listAgentTasks = vi.fn(async () => AGENT_PAYLOAD);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ConversationView, {
      target: host,
      props: {
        api: api({ listAgentTasks }),
        row: {
          id: `dm:${DEACON}`,
          kind: "dm",
          title: "Deacon",
          companyUid: null,
          unreadDot: false,
          lastActivityAt: 0,
          pinned: false,
          personUid: DEACON,
        } as ConversationRow,
      },
    });
    await settle();
    expect(listAgentTasks).toHaveBeenCalledWith({ agentUid: DEACON });
    expect(host.querySelectorAll('[data-testid="task-chip"]').length).toBe(1);
  });

  it("renders nothing and polls nothing when the host has no task routes", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ConversationView, { target: host, props: { api: api(), row: roomRow() } });
    await settle();
    expect(host.querySelector('[data-testid="agent-task-strip"]')).toBeNull();
  });
});
