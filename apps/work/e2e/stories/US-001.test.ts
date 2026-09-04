/**
 * US-001 story acceptance tests (from PRD e2eTests):
 *
 * 1. Given a channel page that includes one root and one reply (rootEventId
 *    set to the root), when the conversation opens, then only the root body
 *    is visible in the main timeline.
 * 2. Given a root with replyCount 2, when the timeline renders, then the
 *    row still appears and carries replyCount 2.
 *
 * Follows the US-007 story-test convention: vitest drives the real
 * live-messages hydrate helpers the conversation views use. No live
 * Cognito, no GET /v1/notify/thread, and no work-mesh thread wording —
 * this is a reply thread filter.
 */

import { describe, expect, it } from "vitest";

import {
  collectTimelineRoots,
  isReplyMessage,
  messagesForDisplay,
} from "../../../../packages/ui/src/chat/live-messages.js";
import type { ConversationMessageWire } from "../../../../packages/ui/src/chat/chat-api.js";

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

describe("US-001: hide replies from the main timeline", () => {
  it("Given a channel page that includes one root and one reply, when the conversation opens, then only the root body is visible in the main timeline", async () => {
    const { roots } = await collectTimelineRoots({
      fetchPage: async () => ({
        messages: [reply, root],
        nextCursor: null,
      }),
    });
    const timeline = [...roots].reverse().filter((row) => !isReplyMessage(row));
    expect(timeline.map((m) => m.body)).toEqual(["root body"]);
    expect(timeline.some((m) => m.body === "reply body")).toBe(false);
    expect(isReplyMessage(reply)).toBe(true);
    expect(isReplyMessage(root)).toBe(false);
  });

  it("Given a root with replyCount 2, when the timeline renders, then the row still appears and carries replyCount 2", async () => {
    const display = messagesForDisplay({ messages: [reply, root] }).filter(
      (row) => !isReplyMessage(row),
    );
    expect(display).toHaveLength(1);
    expect(display[0]?.eventId).toBe("evt_root");
    expect(display[0]?.replyCount).toBe(2);
    expect(display[0]?.body).toBe("root body");
  });
});
