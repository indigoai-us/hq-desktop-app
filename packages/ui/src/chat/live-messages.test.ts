import { describe, expect, it } from "vitest";

import {
  collectTimelineRoots,
  inlineReplyRows,
  isReplyMessage,
  mergeFetchedTimeline,
  mergeTimelineMessages,
  messagesForDisplay,
  normalizeConversationMessages,
  sentMessageFromResult,
  sinceForChannelWake,
  timelineHasEvent,
  timelinePageFromPayload,
  HUMAN_HISTORY_VIEW,
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

  it("returns the existing array reference when the page adds nothing new", () => {
    const page = {
      messages: [
        {
          eventId: "evt_1",
          body: "one",
          createdAt: "2026-08-23T16:05:00.000Z",
          reactions: [{ emoji: "+1", count: 1 }],
        },
        {
          eventId: "evt_2",
          body: "two",
          createdAt: "2026-08-23T16:06:00.000Z",
        },
      ],
    };
    const existing = mergeFetchedTimeline([], page);
    expect(existing).toHaveLength(2);
    // Same page re-fetched by the safety catch-up: fresh objects, same content.
    expect(mergeFetchedTimeline(existing, JSON.parse(JSON.stringify(page)))).toBe(
      existing,
    );
    // Empty page is also a no-op.
    expect(mergeFetchedTimeline(existing, { messages: [] })).toBe(existing);
  });

  it("returns a new array when the page changes content", () => {
    const base = {
      eventId: "evt_1",
      body: "one",
      createdAt: "2026-08-23T16:05:00.000Z",
    };
    const existing = mergeFetchedTimeline([], { messages: [base] });

    const appended = mergeFetchedTimeline(existing, {
      messages: [
        base,
        { eventId: "evt_2", body: "two", createdAt: "2026-08-23T16:06:00.000Z" },
      ],
    });
    expect(appended).not.toBe(existing);
    expect(appended.map((r) => r.eventId)).toEqual(["evt_1", "evt_2"]);

    const edited = mergeFetchedTimeline(existing, {
      messages: [{ ...base, body: "one (edited)" }],
    });
    expect(edited).not.toBe(existing);
    expect(edited[0]?.body).toBe("one (edited)");

    const reacted = mergeFetchedTimeline(existing, {
      messages: [{ ...base, reactions: [{ emoji: "+1", count: 1 }] }],
    });
    expect(reacted).not.toBe(existing);
    expect(reacted[0]?.reactions?.length).toBe(1);
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

describe("a one-to-one conversation with a bot", () => {
  // Regression (owner walkthrough 2026-10-02): a hosted bot answers each
  // message as a thread reply, so its answer sat under "1 reply". "See how
  // sheister replies in a DM? That's the flow we want."
  const PAGE = {
    messages: [
      { eventId: "e4", fromPersonUid: "agt_nova", body: "Here now.", createdAt: "2026-10-02T13:55:10.000Z", rootEventId: "e3" },
      { eventId: "e3", fromPersonUid: "prs_me", body: "Hello?", createdAt: "2026-10-02T13:54:50.000Z", replyCount: 1 },
      { eventId: "e2", fromPersonUid: "agt_nova", body: "Hi, I'm Nova.", createdAt: "2026-10-02T13:54:20.000Z", rootEventId: "e1" },
      { eventId: "e1", fromPersonUid: "prs_me", body: "Automatic message from HQ: ...", createdAt: "2026-10-02T13:53:50.000Z", audience: "agent", replyCount: 1 },
      { eventId: "e0", fromPersonUid: "agt_nova", body: "Nova just joined.", createdAt: "2026-10-02T13:50:42.000Z" },
    ],
  };

  it("shows the bot's replies in line, in time order, with no reply counts", () => {
    const rows = messagesForDisplay(PAGE, { inlineReplies: true });
    expect(rows.map((row) => row.eventId)).toEqual(["e0", "e2", "e3", "e4"]);
    expect(rows.every((row) => row.rootEventId === undefined && row.replyCount === undefined)).toBe(true);
  });

  it("leaves out rows written for the bot only", () => {
    const rows = messagesForDisplay(PAGE, { inlineReplies: true });
    expect(rows.some((row) => row.eventId === "e1")).toBe(false);
  });

  it("keeps threads tucked under their root everywhere else", () => {
    const rows = messagesForDisplay(PAGE);
    expect(rows.map((row) => row.eventId)).toEqual(["e0", "e1", "e3"]);
    expect(rows.find((row) => row.eventId === "e3")?.replyCount).toBe(1);
  });

  it("merges a later page without dropping the replies already shown", () => {
    const first = messagesForDisplay({ messages: PAGE.messages.slice(2) }, { inlineReplies: true });
    const merged = mergeFetchedTimeline(first, PAGE, { inlineReplies: true });
    expect(merged.map((row) => row.eventId)).toEqual(["e0", "e2", "e3", "e4"]);
    expect(mergeFetchedTimeline(merged, PAGE, { inlineReplies: true })).toBe(merged);
  });
  it("hides the app's hello request even when a row carries no lane", () => {
    // Regression (owner, 2026-10-02): "this 'automatic message' thing - that's
    // not great to be able to see that". The row came from the host's stored
    // thread, which had no audience on it, and the merge kept it.
    const seeded = [
      { eventId: "e0", fromPersonUid: "agt_nova", body: "Nova just joined.", createdAt: "2026-10-02T13:50:42.000Z" },
      { eventId: "e1", fromPersonUid: "prs_me", body: "Automatic message from HQ: your setup has just finished", createdAt: "2026-10-02T13:53:50.000Z" },
    ];
    expect(inlineReplyRows(seeded).map((row) => row.eventId)).toEqual(["e0"]);
    const merged = mergeFetchedTimeline(seeded, PAGE, { inlineReplies: true });
    expect(merged.map((row) => row.eventId)).toEqual(["e0", "e2", "e3", "e4"]);
  });

  it("hands back the same array when a timeline is already flat", () => {
    const flat = messagesForDisplay(PAGE, { inlineReplies: true });
    expect(inlineReplyRows(flat)).toBe(flat);
  });
});

describe("timelinePageFromPayload: server human view fields", () => {
  it("an ordinary page (older server, or no view requested) carries no view", () => {
    const page = timelinePageFromPayload({ messages: [], nextCursor: "abc" });
    expect(page.nextCursor).toBe("abc");
    expect("view" in page).toBe(false);
    expect("viewScanTruncated" in page).toBe(false);
  });

  it("reads the view echo of a server-filtered page", () => {
    const page = timelinePageFromPayload({
      messages: [{ eventId: "e1" }],
      view: "human",
      nextCursor: "abc",
    });
    expect(page.view).toBe(HUMAN_HISTORY_VIEW);
    expect(page.nextCursor).toBe("abc");
    expect("viewScanTruncated" in page).toBe(false);
  });

  it("reads viewScanTruncated together with its cursor", () => {
    const page = timelinePageFromPayload({
      messages: [],
      view: "human",
      nextCursor: "abc",
      viewScanTruncated: true,
    });
    expect(page).toEqual({
      messages: [],
      nextCursor: "abc",
      view: "human",
      viewScanTruncated: true,
    });
  });

  it("an empty filtered page with no cursor means no more visible history", () => {
    const page = timelinePageFromPayload({ messages: [], view: "human" });
    expect(page.view).toBe("human");
    expect(page.nextCursor).toBeNull();
  });

  it("ignores an unknown view value and a truncated flag without the echo", () => {
    const other = timelinePageFromPayload({ messages: [], view: "everything" });
    expect("view" in other).toBe(false);
    const noEcho = timelinePageFromPayload({ messages: [], viewScanTruncated: true });
    expect("viewScanTruncated" in noEcho).toBe(false);
  });
});
