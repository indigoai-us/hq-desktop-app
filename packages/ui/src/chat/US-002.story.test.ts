/**
 * US-002 story acceptance: reply-thread adapter types + scope helper.
 *
 * Product copy: “replies” / “reply thread”. Not a work-mesh thread and not
 * GET /v1/notify/thread.
 */
import { describe, expect, it } from "vitest";

import {
  replyScopeForRow,
  type ConversationApi,
  type ReplyThreadResponse,
} from "./chat-api";

const emptyThread: ReplyThreadResponse = {
  scope: "channel",
  root: { eventId: "evt_root", createdAt: "2026-08-17T01:00:00.000Z" },
  replies: [],
  replyCount: 0,
};

function conversationApi(): ConversationApi {
  return {
    fetchChannel: async () => ({ messages: [], nextCursor: null }),
    sendChannelMessage: async () => {},
    fetchDmThread: async () => ({ messages: [], nextCursor: null }),
    sendDm: async () => {},
    fetchReplyThread: async () => emptyThread,
    sendReply: async () => {},
  };
}

describe("US-002: Adapter + ConversationApi for fetchReplyThread / sendReply", () => {
  it("ConversationApi exposes fetchReplyThread and sendReply without colliding with fetchDmThread", async () => {
    const api = conversationApi();
    const thread = await api.fetchReplyThread({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_general",
    });
    expect(thread.root?.eventId).toBe("evt_root");
    expect(Array.isArray(thread.replies)).toBe(true);
    expect(typeof thread.replyCount).toBe("number");
    await expect(
      api.sendReply({
        scope: "channel",
        rootEventId: "evt_root",
        channelId: "chn_general",
        body: "ok",
      }),
    ).resolves.toBeUndefined();
    expect(typeof api.fetchDmThread).toBe("function");
    expect(api.fetchReplyThread).not.toBe(api.fetchDmThread);
  });

  it("replyScopeForRow maps 1:1 DM, channel, and group DM; never kind===dm alone", () => {
    expect(replyScopeForRow({ kind: "dm", personUid: "prs_ada" })).toBe("dm");
    expect(replyScopeForRow({ kind: "channel", channelId: "chn_chat" })).toBe(
      "channel",
    );
    expect(replyScopeForRow({ kind: "group", channelId: "chn_group" })).toBe(
      "channel",
    );
    expect(replyScopeForRow({ kind: "dm" })).toBeNull();
    expect(replyScopeForRow(null)).toBeNull();
  });
});
