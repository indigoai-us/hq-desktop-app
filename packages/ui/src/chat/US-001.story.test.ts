// @vitest-environment happy-dom

/**
 * US-001 story acceptance: hide reply messages from the main timeline.
 *
 * Product copy: “replies” / “reply thread”. Not a work-mesh thread and not
 * GET /v1/notify/thread.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ConversationView from "./ConversationView.svelte";
import ChannelConversation from "./messaging/ChannelConversation.svelte";
import type { ConversationApi, ConversationMessageWire } from "./chat-api";
import type { ConversationRow } from "./sidebar-model";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const channelRow: ConversationRow = {
  id: "ch:chn_general",
  kind: "channel",
  title: "general",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_general",
};

const root: ConversationMessageWire = {
  eventId: "evt_root",
  body: "root body",
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 2,
};

const reply: ConversationMessageWire = {
  eventId: "evt_reply",
  rootEventId: "evt_root",
  body: "reply body",
  createdAt: "2026-08-17T02:00:00.000Z",
  fromDisplayName: "Bob",
};

function conversationApi(messages: ConversationMessageWire[]): ConversationApi {
  return {
    fetchChannel: async () => ({ messages, nextCursor: null }),
    sendChannelMessage: async () => {},
    fetchDmThread: async () => ({ messages: [], nextCursor: null }),
    sendDm: async () => {},
    fetchReplyThread: async () => ({
      scope: "channel",
      root: null,
      replies: [],
      replyCount: 0,
    }),
    sendReply: async () => {},
    runCardAction: async () => ({
      cardId: "",
      actionId: "",
      state: "pending",
    }),
  };
}

describe("US-001: Wire reply fields and hide replies from the main timeline", () => {
  it("Given a channel page that includes one root and one reply, when the conversation opens, then only the root body is visible in the main timeline", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ConversationView, {
      target: host,
      props: {
        api: conversationApi([reply, root]),
        row: channelRow,
      },
    });
    await tick();
    await vi.waitFor(() => {
      const rows = host.querySelectorAll(
        '[data-testid="conversation-message"]',
      );
      expect(rows).toHaveLength(1);
    });
    const text = host.textContent ?? "";
    expect(text).toContain("root body");
    expect(text).not.toContain("reply body");
    expect(host.querySelector('[data-event-id="evt_root"]')).not.toBeNull();
    expect(host.querySelector('[data-event-id="evt_reply"]')).toBeNull();
  });

  it("Given a root with replyCount 2, when the timeline renders, then the row still appears and carries replyCount 2", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [root, reply],
      },
    });
    await tick();
    const rows = host.querySelectorAll('[data-testid="conversation-message"]');
    expect(rows).toHaveLength(1);
    const row = host.querySelector('[data-event-id="evt_root"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-reply-count")).toBe("2");
    expect(host.textContent).toContain("root body");
    expect(host.textContent).not.toContain("reply body");
  });
});
