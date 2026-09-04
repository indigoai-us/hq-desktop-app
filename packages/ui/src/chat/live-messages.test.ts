import { describe, expect, it } from "vitest";

import {
  collectTimelineRoots,
  isReplyMessage,
  mergeFetchedTimeline,
  mergeTimelineMessages,
  messagesForDisplay,
  normalizeConversationMessages,
  sentMessageFromResult,
  sinceForChannelWake,
  timelineHasEvent,
  TIMELINE_ROOT_PAGE_SIZE,
} from "./live-messages.js";

describe("normalizeConversationMessages", () => {
  it("reads a { messages } page and a bare array", () => {
    const wire = {
      eventId: "e1",
      body: "hello",
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    expect(normalizeConversationMessages({ messages: [wire] })).toEqual([
      expect.objectContaining({ eventId: "e1", body: "hello" }),
    ]);
    expect(normalizeConversationMessages([wire])[0]?.eventId).toBe("e1");
  });

  it("keeps structured mentions on the wire message", () => {
    const [row] = normalizeConversationMessages([
      {
        eventId: "e2",
        body: "hey @Deacon",
        createdAt: "2026-08-17T00:00:00.000Z",
        mentions: [
          {
            participantUid: "agt_deacon",
            participantType: "agent",
            displayName: "Deacon",
          },
        ],
      },
    ]);
    expect(row?.mentions).toEqual([
      {
        participantUid: "agt_deacon",
        displayName: "Deacon",
        participantType: "agent",
      },
    ]);
  });

  it("keeps attachments on the wire message", () => {
    const [row] = normalizeConversationMessages([
      {
        eventId: "e3",
        body: "see this",
        createdAt: "2026-08-17T00:00:00.000Z",
        attachments: [
          {
            id: "att_1",
            vaultPath: "chat/attachments/chan/chn_x/att_1-shot.png",
            companyUid: "cmp_1",
            name: "shot.png",
            contentType: "image/png",
            sizeBytes: 100,
            kind: "image",
          },
        ],
      },
    ]);
    expect(row?.attachments).toEqual([
      expect.objectContaining({
        name: "shot.png",
        vaultPath: "chat/attachments/chan/chn_x/att_1-shot.png",
        kind: "image",
      }),
    ]);
  });

  it("reverses newest-first REST pages for display", () => {
    const display = messagesForDisplay({
      messages: [
        { eventId: "new", body: "n", createdAt: "2026-08-17T02:00:00.000Z" },
        { eventId: "old", body: "o", createdAt: "2026-08-17T01:00:00.000Z" },
      ],
    });
    expect(display.map((m) => m.eventId)).toEqual(["old", "new"]);
  });

  it("maps optional reply fields and leaves lastReplyAt optional", () => {
    const [mapped] = normalizeConversationMessages([
      {
        eventId: "root-1",
        body: "root",
        createdAt: "2026-08-17T00:00:00.000Z",
        rootEventId: "root-1",
        replyCount: 2,
      },
    ]);
    expect(mapped).toEqual(
      expect.objectContaining({
        eventId: "root-1",
        rootEventId: "root-1",
        replyCount: 2,
      }),
    );
    expect(mapped).not.toHaveProperty("lastReplyAt");
  });
});

describe("mergeFetchedTimeline", () => {
  it("drops a leaked reply from the cached timeline when the page names rootEventId", () => {
    const leaked = {
      eventId: "evt_pong",
      body: "Pong. I'm here.",
      createdAt: "2026-08-23T16:06:00.000Z",
    };
    const root = {
      eventId: "evt_ping",
      body: "Ping",
      createdAt: "2026-08-23T16:05:00.000Z",
      replyCount: 1,
    };
    const merged = mergeFetchedTimeline([root, leaked], {
      messages: [
        {
          eventId: "evt_pong",
          body: "Pong. I'm here.",
          createdAt: "2026-08-23T16:06:00.000Z",
          rootEventId: "evt_ping",
        },
        root,
      ],
    });
    expect(merged.map((row) => row.eventId)).toEqual(["evt_ping"]);
    expect(merged[0]?.replyCount).toBe(1);
  });
});

describe("isReplyMessage", () => {
  it("treats missing fields as a root", () => {
    expect(isReplyMessage({ eventId: "e1" })).toBe(false);
    expect(isReplyMessage({ eventId: "e1", rootEventId: "" })).toBe(false);
    expect(isReplyMessage({ eventId: "e1", rootEventId: "   " })).toBe(false);
    expect(isReplyMessage({ eventId: "e1", rootEventId: null })).toBe(false);
  });

  it("does not treat rootEventId === eventId as a reply", () => {
    expect(isReplyMessage({ eventId: "root-1", rootEventId: "root-1" })).toBe(
      false,
    );
  });

  it("treats a non-empty rootEventId that differs from eventId as a reply", () => {
    expect(isReplyMessage({ eventId: "reply-1", rootEventId: "root-1" })).toBe(
      true,
    );
  });
});

describe("collectTimelineRoots", () => {
  it("mixed page → only roots", async () => {
    const { roots } = await collectTimelineRoots({
      fetchPage: async () => ({
        messages: [
          {
            eventId: "reply-1",
            body: "reply body",
            rootEventId: "root-1",
            createdAt: "2026-08-17T02:00:00.000Z",
          },
          {
            eventId: "root-1",
            body: "root body",
            replyCount: 1,
            createdAt: "2026-08-17T01:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    });
    expect(roots.map((m) => m.eventId)).toEqual(["root-1"]);
    expect(roots[0]?.body).toBe("root body");
    expect(roots[0]?.replyCount).toBe(1);
  });

  it("missing fields → root", async () => {
    const { roots } = await collectTimelineRoots({
      fetchPage: async () => ({
        messages: [
          {
            eventId: "legacy",
            body: "old row",
            createdAt: "2026-08-17T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    });
    expect(roots).toHaveLength(1);
    expect(roots[0]?.eventId).toBe("legacy");
    expect(isReplyMessage(roots[0]!)).toBe(false);
  });

  it("rootEventId === eventId is not filtered", async () => {
    const { roots } = await collectTimelineRoots({
      fetchPage: async () => ({
        messages: [
          {
            eventId: "root-1",
            rootEventId: "root-1",
            body: "self root",
            replyCount: 2,
            createdAt: "2026-08-17T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    });
    expect(roots.map((m) => m.eventId)).toEqual(["root-1"]);
    expect(roots[0]?.replyCount).toBe(2);
  });

  it("over-fetch concatenates two pages", async () => {
    const pages: Record<
      string,
      { messages: unknown[]; nextCursor: string | null }
    > = {
      first: {
        messages: [
          {
            eventId: "reply-new",
            rootEventId: "root-old",
            body: "reply",
            createdAt: "2026-08-17T03:00:00.000Z",
          },
          {
            eventId: "root-new",
            body: "newer root",
            createdAt: "2026-08-17T02:00:00.000Z",
          },
        ],
        nextCursor: "page-2",
      },
      "page-2": {
        messages: [
          {
            eventId: "root-old",
            body: "older root",
            replyCount: 1,
            createdAt: "2026-08-17T01:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    };
    const cursors: Array<string | null> = [];
    const { roots, nextCursor } = await collectTimelineRoots({
      pageSize: TIMELINE_ROOT_PAGE_SIZE,
      fetchPage: async (cursor) => {
        cursors.push(cursor);
        return cursor == null ? pages.first : pages[cursor]!;
      },
    });
    expect(cursors).toEqual([null, "page-2"]);
    expect(roots.map((m) => m.eventId)).toEqual(["root-new", "root-old"]);
    expect(nextCursor).toBeNull();
  });

  it("over-fetch dedupes overlapping cursor pages", async () => {
    const { roots } = await collectTimelineRoots({
      fetchPage: async (cursor) =>
        cursor == null
          ? {
              messages: [
                {
                  eventId: "reply-1",
                  rootEventId: "root-keep",
                  body: "reply",
                  createdAt: "2026-08-17T03:00:00.000Z",
                },
                {
                  eventId: "root-keep",
                  body: "keep",
                  createdAt: "2026-08-17T02:00:00.000Z",
                },
              ],
              nextCursor: "page-2",
            }
          : {
              messages: [
                {
                  eventId: "root-keep",
                  body: "keep again",
                  createdAt: "2026-08-17T02:00:00.000Z",
                },
                {
                  eventId: "root-older",
                  body: "older",
                  createdAt: "2026-08-17T01:00:00.000Z",
                },
              ],
              nextCursor: null,
            },
    });
    expect(roots.map((m) => m.eventId)).toEqual(["root-keep", "root-older"]);
  });
});

describe("mergeTimelineMessages", () => {
  it("appends only the incoming event and keeps existing rows", () => {
    const existing = messagesForDisplay({
      messages: [
        { eventId: "old", body: "o", createdAt: "2026-08-17T01:00:00.000Z" },
      ],
    });
    const incoming = messagesForDisplay({
      messages: [
        { eventId: "new", body: "n", createdAt: "2026-08-17T02:00:00.000Z" },
      ],
    });
    const merged = mergeTimelineMessages(existing, incoming);
    expect(merged.map((m) => m.eventId)).toEqual(["old", "new"]);
    expect(merged[0]).toBe(existing[0]);
  });

  it("keeps local kind/previewUrl when the catch-up page omits them", () => {
    const existing = messagesForDisplay({
      messages: [
        {
          eventId: "e1",
          body: "",
          createdAt: "2026-08-17T01:00:00.000Z",
          attachments: [
            {
              id: "att_1",
              vaultPath: "chat/attachments/chan/chn_x/source.gif",
              companyUid: "cmp_1",
              name: "source.gif",
              contentType: "image/gif",
              kind: "image",
              previewUrl: "blob:local",
            },
          ],
        },
      ],
    });
    const incoming = messagesForDisplay({
      messages: [
        {
          eventId: "e1",
          body: "",
          createdAt: "2026-08-17T01:00:00.000Z",
          attachments: [
            {
              id: "att_1",
              vaultPath: "chat/attachments/chan/chn_x/source.gif",
              name: "source.gif",
            },
          ],
        },
      ],
    });
    const merged = mergeTimelineMessages(existing, incoming);
    expect(merged[0]?.attachments?.[0]).toMatchObject({
      kind: "image",
      contentType: "image/gif",
      previewUrl: "blob:local",
      companyUid: "cmp_1",
    });
  });

  it("is a no-op when the event is already cached", () => {
    const existing = messagesForDisplay({
      messages: [
        { eventId: "e1", body: "hi", createdAt: "2026-08-17T01:00:00.000Z" },
      ],
    });
    const again = mergeTimelineMessages(existing, existing);
    expect(again).toBe(existing);
  });
});

describe("sinceForChannelWake / timelineHasEvent", () => {
  it("rewinds 1ms so same-timestamp member_added siblings are included", () => {
    const local = messagesForDisplay({
      messages: [
        { eventId: "e2", body: "b", createdAt: "2026-08-17T02:00:00.000Z" },
        { eventId: "e1", body: "a", createdAt: "2026-08-17T01:00:00.000Z" },
      ],
    });
    expect(sinceForChannelWake(local)).toBe(
      new Date(Date.parse("2026-08-17T02:00:00.000Z") - 1).toISOString(),
    );
    expect(timelineHasEvent(local, "e2")).toBe(true);
    expect(timelineHasEvent(local, "missing")).toBe(false);
  });

  it("falls back to just before the wake createdAt when the cache is empty", () => {
    const since = sinceForChannelWake([], "2026-08-17T02:00:00.000Z");
    expect(since).toBe(
      new Date(Date.parse("2026-08-17T02:00:00.000Z") - 1).toISOString(),
    );
  });
});

describe("sentMessageFromResult", () => {
  it("promotes the POST echo and ignores a missing eventId", () => {
    expect(sentMessageFromResult({ ok: true }, { body: "hi" })).toBeNull();
    expect(
      sentMessageFromResult(
        { eventId: "evt_9", createdAt: "2026-08-18T12:00:00.000Z" },
        { body: "hi" },
      ),
    ).toEqual(
      expect.objectContaining({
        eventId: "evt_9",
        body: "hi",
        createdAt: "2026-08-18T12:00:00.000Z",
        direction: "out",
      }),
    );
  });
});

describe("peerIsSystemFromPayload", () => {
  it("is true only for an explicit peer.isSystem === true", async () => {
    const { peerIsSystemFromPayload } = await import("./live-messages.js");
    expect(
      peerIsSystemFromPayload({ messages: [], peer: { isSystem: true } }),
    ).toBe(true);
    expect(
      peerIsSystemFromPayload({ messages: [], peer: { isSystem: "true" } }),
    ).toBe(false);
    expect(peerIsSystemFromPayload({ messages: [] })).toBe(false);
    expect(peerIsSystemFromPayload([])).toBe(false);
    expect(peerIsSystemFromPayload(null)).toBe(false);
  });
});
