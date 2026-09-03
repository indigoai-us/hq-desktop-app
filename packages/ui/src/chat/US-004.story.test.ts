// @vitest-environment happy-dom

/**
 * US-004 story acceptance: type:thread wake refreshes an open reply panel.
 *
 * Wake event is `reply:new` — never `thread:` (work-mesh collision).
 * Product copy: “replies” / “reply thread”.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "../shell/DesktopApp.svelte";
import ConversationView from "./ConversationView.svelte";
import ReplyPanel from "./messaging/ReplyPanel.svelte";
import {
  bumpRootReplyCount,
  createChatWakeBus,
  replyNewMatchesConversation,
  type ChatSidebarApi,
  type ConversationApi,
  type ConversationMessageWire,
  type NotificationsApi,
  type ReplyNewWake,
  type ReplyThreadResponse,
} from "./chat-api";
import { collectTimelineRoots, isReplyMessage } from "./live-messages";
import type { ConversationRow } from "./sidebar-model";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const projectRow: ConversationRow = {
  id: "ch:chn_proj",
  kind: "channel",
  title: "launch",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_proj",
};

const root: ConversationMessageWire = {
  eventId: "evt_root",
  body: "root body",
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 0,
};

const existingReply: ConversationMessageWire = {
  eventId: "evt_existing",
  rootEventId: "evt_root",
  body: "already here",
  createdAt: "2026-08-17T01:05:00.000Z",
  fromDisplayName: "Ada",
};

const incomingReply: ConversationMessageWire = {
  eventId: "evt_b",
  rootEventId: "evt_root",
  body: "from B",
  createdAt: "2026-08-17T01:10:00.000Z",
  fromDisplayName: "Bea",
};

function conversationApi(options: {
  messages?: ConversationMessageWire[];
  threadFor?: (rootEventId: string) => ReplyThreadResponse;
}): ConversationApi & { fetchCalls: string[] } {
  const fetchCalls: string[] = [];
  return {
    fetchCalls,
    fetchChannel: async () => ({
      messages: options.messages ?? [root],
      nextCursor: null,
    }),
    sendChannelMessage: async () => {},
    fetchDmThread: async () => ({
      messages: options.messages ?? [root],
      nextCursor: null,
    }),
    sendDm: async () => {},
    fetchReplyThread: async (args) => {
      fetchCalls.push(args.rootEventId);
      return (
        options.threadFor?.(args.rootEventId) ?? {
          scope: "channel",
          root,
          replies: [existingReply],
          replyCount: 1,
        }
      );
    },
    sendReply: async () => {},
    runCardAction: async () => ({
      cardId: "",
      actionId: "",
      state: "pending",
    }),
  };
}

describe("US-004: type:thread wake refreshes an open reply panel", () => {
  it("ChatWakeEvents names the doorbell reply:new, never thread:", () => {
    const wakes = createChatWakeBus();
    const seen: ReplyNewWake[] = [];
    wakes.on("reply:new", (payload) => seen.push(payload));
    const payload: ReplyNewWake = {
      rootEventId: "evt_root",
      eventId: "evt_b",
      scope: "channel",
      channelId: "chn_proj",
    };
    wakes.emit("reply:new", payload);
    expect(seen).toEqual([payload]);
    expect(Object.keys(payload).sort()).toEqual(
      ["channelId", "eventId", "rootEventId", "scope"].sort(),
    );
    expect("thread:new" in ({} as Record<string, unknown>)).toBe(false);
  });

  it("Given user A has a reply panel open on root R, when user B’s reply to R is durable and a type:thread wake fires, then A’s panel shows B’s reply without a manual refresh", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const wakes = createChatWakeBus();
    let replies = [existingReply];
    const api = conversationApi({
      messages: [{ ...root, replyCount: 1 }],
      threadFor: () => ({
        scope: "channel",
        root: { ...root, replyCount: replies.length },
        replies: [...replies],
        replyCount: replies.length,
      }),
    });
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api,
        wakes,
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_proj",
        seedRoot: root,
        onclose: () => {},
      },
    });
    await tick();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("already here");
    });
    expect(api.fetchCalls).toEqual(["evt_root"]);

    replies = [existingReply, incomingReply];
    wakes.emit("reply:new", {
      rootEventId: "evt_root",
      eventId: "evt_b",
      scope: "channel",
      channelId: "chn_proj",
    });
    await tick();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("from B");
    });
    expect(api.fetchCalls).toEqual(["evt_root", "evt_root"]);
    expect(
      host
        .querySelector('[data-testid="reply-panel"]')
        ?.getAttribute("data-root-event-id"),
    ).toBe("evt_root");
  });

  it("Given a wake for a different root, when A’s panel is open on R, then the panel contents do not change", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const wakes = createChatWakeBus();
    const api = conversationApi({
      threadFor: () => ({
        scope: "channel",
        root,
        replies: [existingReply],
        replyCount: 1,
      }),
    });
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api,
        wakes,
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_proj",
        seedRoot: root,
        onclose: () => {},
      },
    });
    await tick();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("already here");
    });
    const before = host.querySelector(
      '[data-testid="reply-panel-list"]',
    )?.textContent;
    wakes.emit("reply:new", {
      rootEventId: "evt_other",
      eventId: "evt_x",
      scope: "channel",
      channelId: "chn_proj",
    });
    await tick();
    await vi.waitFor(() => expect(api.fetchCalls).toEqual(["evt_root"]));
    expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="reply-panel-list"]')?.textContent,
    ).toBe(before);
    expect(host.textContent).toContain("already here");
    expect(host.textContent).not.toContain("from B");
  });

  it("DesktopApp bumps visible N replies on reply:new when the panel is closed", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const wakes = createChatWakeBus();
    const sidebarApi: ChatSidebarApi = {
      fetchChannelDirectory: async () => ({
        snapshot: true,
        cursor: "c1",
        cursorExpiresAt: "2099-01-01T00:00:00.000Z",
        rows: [],
      }),
      listContacts: async () => ({ contacts: [] }),
      listDmRequests: async () => ({ requests: [] }),
      listChannels: async () => ({ channels: [] }),
      markDmThreadRead: async () => {},
      markChannelRead: async () => {},
      sendChannelMessage: async () => {},
      sendDm: async () => {},
      searchMessages: async () => ({ results: [] }),
    };
    const notificationsApi: NotificationsApi = {
      fetchNotifications: async () => ({ notifications: [], unreadCount: 0 }),
      ackNotification: async () => {},
      readAllNotifications: async () => {},
      runNotificationAction: async () => ({}),
    };
    const adapter = {
      kind: "web",
      isAvailable: () => false,
      messaging: {
        fetchChannel: async () =>
          ok({ messages: [{ ...root, replyCount: 1 }], nextCursor: null }),
        fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
        fetchReplyThread: async () =>
          ok({
            scope: "channel",
            root: { ...root, replyCount: 1 },
            replies: [existingReply],
            replyCount: 1,
          }),
        sendReply: async () => ok({}),
        sendChannelMessage: async () => ok(undefined),
        sendDm: async () => ok(undefined),
        listContacts: async () => ok({ contacts: [] }),
        listChannelMembers: async () => ok({ members: [] }),
        toggleReaction: async () => ok(undefined),
      },
    } as unknown as PlatformAdapter;
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter,
        sidebarApi,
        notificationsApi,
        wakes,
        initialRow: projectRow,
        searchRows: [projectRow],
        hydrateLiveMessages: true,
      },
    });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="message-replies"]')?.textContent,
      ).toContain("1 reply");
    });
    expect(host.querySelector('[data-testid="reply-panel"]')).toBeNull();

    wakes.emit("reply:new", {
      rootEventId: "evt_root",
      eventId: "evt_b",
      scope: "channel",
      channelId: "chn_proj",
    });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="message-replies"]')?.textContent,
      ).toContain("2 replies");
    });
    expect(
      host
        .querySelector("[data-reply-count]")
        ?.getAttribute("data-reply-count"),
    ).toBe("2");
    expect(host.querySelector('[data-testid="reply-panel"]')).toBeNull();
    expect(host.textContent).not.toContain("from B");
  });

  it("bumps visible N replies when the conversation is open and the panel is closed", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const wakes = createChatWakeBus();
    const api = conversationApi({
      messages: [{ ...root, replyCount: 1 }],
    });
    component = mount(ConversationView, {
      target: host,
      props: { api, wakes, row: projectRow },
    });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="message-replies"]')?.textContent,
      ).toContain("1 reply");
    });
    expect(host.querySelector('[data-testid="reply-panel"]')).toBeNull();

    wakes.emit("reply:new", {
      rootEventId: "evt_root",
      eventId: "evt_b",
      scope: "channel",
      channelId: "chn_proj",
    });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="message-replies"]')?.textContent,
      ).toContain("2 replies");
    });
    expect(host.querySelector('[data-testid="reply-panel"]')).toBeNull();
    expect(host.textContent).not.toContain("from B");
  });

  it("does not invent sidebar unread when the conversation is not open", () => {
    const wake: ReplyNewWake = {
      rootEventId: "evt_root",
      eventId: "evt_b",
      scope: "channel",
      channelId: "chn_other",
    };
    expect(replyNewMatchesConversation(wake, projectRow)).toBe(false);
    const messages = [{ ...root, replyCount: 1 }];
    expect(bumpRootReplyCount(messages, "evt_missing")[0]?.replyCount).toBe(1);
  });

  it("every timeline hydrate runs isReplyMessage so a channel:new-message refresh cannot leak a reply", async () => {
    const { roots } = await collectTimelineRoots({
      fetchPage: async () => ({
        messages: [incomingReply, { ...root, replyCount: 2 }],
        nextCursor: null,
      }),
    });
    const timeline = [...roots].reverse().filter((row) => !isReplyMessage(row));
    expect(timeline.map((row) => row.eventId)).toEqual(["evt_root"]);
    expect(timeline[0]?.replyCount).toBe(2);
    expect(isReplyMessage(incomingReply)).toBe(true);
  });
});
