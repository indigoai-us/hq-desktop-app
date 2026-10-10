import { describe, expect, it } from "vitest";
import { isHumanMessage } from "@hq/platform";

import {
  collectTimelineRoots,
  inlineReplyRows,
  isAppRequestRow,
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
import { firstRunHandoffNotice, firstRunImportNotice, firstRunSettledNotice } from "./first-run/visual-first-run.js";

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

  it("keeps a row's richContent as sent, and adds none to a row without it", () => {
    const richContent = { v: 1, blocks: [{ kind: "connect", items: [{ app: "slack", slack: { installed: "absent" } }] }] };
    const [withCards, plain] = normalizeConversationMessages([
      { eventId: "e1", body: "Apps: Slack (not added yet)", createdAt: "2026-10-05T00:00:00.000Z", richContent },
      { eventId: "e2", body: "hello", createdAt: "2026-10-05T00:00:01.000Z", richContent: null },
    ]);
    expect(withCards?.richContent).toEqual(richContent);
    expect(plain && "richContent" in plain).toBe(false);
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

describe("the app's own requests to a bot: which rows are left out", () => {
  const LEAD = "Automatic message from HQ:";
  const BOT = "agt_nova";
  const ME = "prs_me";
  const at = (n: number): string => `2026-10-02T13:5${n}:00.000Z`;
  const ids = (rows: Array<{ eventId: string }>): string[] => rows.map((row) => row.eventId);

  it("never hides a row the bot sent, even one that starts with the app's opening words", () => {
    // Second review, 2026-10-04: a bot that quoted the opening words at the
    // start of its answer had the answer hidden. The "working" row then ran
    // out and the person read "stopped responding".
    const page = {
      messages: [
        { eventId: "b3", fromPersonUid: BOT, body: `${LEAD} is how my setup request began. Here is what I did.`, createdAt: at(3), audience: "agent", rootEventId: "p1" },
        { eventId: "b2", fromPersonUid: BOT, body: `${LEAD} your setup has just finished`, createdAt: at(2), audience: "both", rootEventId: "p1" },
        { eventId: "b1", fromPersonUid: BOT, body: `${LEAD} quoted with no lane on the row`, createdAt: at(1) },
        { eventId: "p1", fromPersonUid: ME, body: "What did the app tell you?", createdAt: at(0), audience: "both", replyCount: 2 },
      ],
    };
    for (const options of [{ inlineReplies: true }, { inlineReplies: true, selfUid: ME }]) {
      expect(ids(messagesForDisplay(page, options))).toEqual(["p1", "b1", "b2", "b3"]);
    }
    for (const row of normalizeConversationMessages(page, { keepAudience: true })) {
      if (row.fromPersonUid === BOT) {
        expect(isAppRequestRow(row), row.eventId).toBe(false);
        expect(isAppRequestRow(row, { selfUid: ME }), row.eventId).toBe(false);
        // Even when the host is wrong about who is looking.
        expect(isAppRequestRow(row, { selfUid: BOT }), row.eventId).toBe(false);
      }
    }
  });

  it("hides a row on the bot-only lane that the person's app sent", () => {
    const rows = normalizeConversationMessages(
      { messages: [{ eventId: "r1", fromPersonUid: ME, body: "anything at all", createdAt: at(1), audience: "agent" }] },
      { keepAudience: true },
    );
    expect(isAppRequestRow(rows[0]!)).toBe(true);
    expect(isAppRequestRow(rows[0]!, { selfUid: ME })).toBe(true);
    expect(isAppRequestRow({ ...rows[0]!, audience: " Agent " })).toBe(true);
    expect(inlineReplyRows(rows)).toEqual([]);
  });

  it("shows a message the person typed themselves that starts with the opening words", () => {
    // The server returns the audience on every read: a typed message is for
    // the person as much as for the bot. Hiding it made the person's own
    // message vanish while the bot still acted on it.
    const page = {
      messages: [
        { eventId: "b1", fromPersonUid: BOT, body: "No, that is the app's own wording.", createdAt: at(2), audience: "both", rootEventId: "p1" },
        { eventId: "p1", fromPersonUid: ME, body: `${LEAD} is that what you get sent?`, createdAt: at(1), audience: "both", replyCount: 1 },
      ],
    };
    for (const options of [{ inlineReplies: true }, { inlineReplies: true, selfUid: ME }]) {
      expect(ids(messagesForDisplay(page, options))).toEqual(["p1", "b1"]);
    }
    for (const audience of ["both", "human", "everyone"]) {
      expect(isAppRequestRow({ eventId: "p1", fromPersonUid: ME, body: `${LEAD} typed`, audience }, { selfUid: ME }), audience).toBe(false);
    }
  });

  it("shows the person's message while it is on its way out, before the server has it", () => {
    // The row the composer adds at once carries no audience yet.
    const sending = { eventId: "local-send-7", fromPersonUid: ME, body: `${LEAD} is that what you get sent?`, createdAt: at(1), direction: "out" };
    expect(isAppRequestRow(sending)).toBe(false);
    expect(isAppRequestRow(sending, { selfUid: ME })).toBe(false);
    const timeline = [sending];
    expect(inlineReplyRows(timeline)).toBe(timeline);
    expect(inlineReplyRows(timeline, { selfUid: ME })).toBe(timeline);
  });

  it("hides the request copied from the host's stored thread, which keeps no lane, only when the person sent it", () => {
    const stored = { eventId: "e1", fromPersonUid: ME, body: `${LEAD} your setup has just finished`, createdAt: at(1) };
    // The host says who is looking: the sender must be that person.
    expect(isAppRequestRow(stored, { selfUid: ME })).toBe(true);
    expect(isAppRequestRow({ ...stored, fromPersonUid: "prs_teammate" }, { selfUid: ME })).toBe(false);
    expect(inlineReplyRows([{ ...stored, fromPersonUid: "prs_teammate" }], { selfUid: ME })).toHaveLength(1);
    // The host does not say: any sender that is not a bot, which in a
    // one-to-one conversation with a bot is the person.
    expect(isAppRequestRow(stored)).toBe(true);
    expect(isAppRequestRow({ ...stored, fromPersonUid: null })).toBe(false);
    expect(isAppRequestRow({ ...stored, fromPersonUid: BOT })).toBe(false);
    // The words alone are not enough: they must open the message.
    expect(isAppRequestRow({ ...stored, body: `About "${LEAD}": what is it?` }, { selfUid: ME })).toBe(false);
    expect(isAppRequestRow({ ...stored, body: null }, { selfUid: ME })).toBe(false);
  });

  it("shows the person's typed message again once the server's row replaces the stored copy", () => {
    const typed = `${LEAD} is that what you get sent?`;
    const stored = [{ eventId: "p1", fromPersonUid: ME, body: typed, createdAt: at(1) }];
    const page = { messages: [{ eventId: "p1", fromPersonUid: ME, body: typed, createdAt: at(1), audience: "both" }] };
    const merged = mergeFetchedTimeline(stored, page, { inlineReplies: true, selfUid: ME });
    expect(ids(merged)).toEqual(["p1"]);
    // And the app's request stays out when the server's row says it is the bot's alone.
    const request = { messages: [{ eventId: "p1", fromPersonUid: ME, body: typed, createdAt: at(1), audience: "agent" }] };
    expect(mergeFetchedTimeline(stored, request, { inlineReplies: true, selfUid: ME })).toEqual([]);
  });
});

describe("audience on conversation rows", () => {
  // A conversation between two people, as the server returns it: every row
  // carries an audience, and one is tagged for a bot.
  const PEOPLE = {
    messages: [
      { eventId: "m3", fromPersonUid: "prs_sam", body: "Sounds good.", createdAt: "2026-10-02T13:55:00.000Z", audience: "both" },
      { eventId: "m2", fromPersonUid: "prs_me", body: "Automatic message from HQ: is a funny way to start a note", createdAt: "2026-10-02T13:54:00.000Z", audience: "agent" },
      { eventId: "m1", fromPersonUid: "prs_sam", body: "Posted by a script.", createdAt: "2026-10-02T13:53:00.000Z", audience: "bot" },
    ],
  };

  it("keeps real lane metadata for ordinary conversation timelines", () => {
    // Conversation views classify from the server's lane, whether the rows
    // came from a channel or an ordinary direct message.
    for (const rows of [messagesForDisplay(PEOPLE), mergeFetchedTimeline([], PEOPLE)]) {
      expect(rows.map((row) => row.eventId).sort()).toEqual(["m1", "m2", "m3"]);
      expect(rows.map((row) => row.audience).sort()).toEqual(["agent", "bot", "both"]);
      expect(isHumanMessage(rows.find((row) => row.eventId === "m1")!, { inferFromUid: false })).toBe(false);
      expect(isHumanMessage(rows.find((row) => row.eventId === "m2")!, { inferFromUid: false })).toBe(false);
      expect(isHumanMessage(rows.find((row) => row.eventId === "m3")!, { inferFromUid: false })).toBe(true);
    }
  });

  it("carries the audience in a one-to-one conversation with a bot, where the app's requests are left out by it", () => {
    const kept = normalizeConversationMessages(PEOPLE, { keepAudience: true });
    expect(kept.map((row) => row.audience)).toEqual(["both", "agent", "bot"]);
    const BOT_DM = {
      messages: [
        { eventId: "e2", fromPersonUid: "agt_nova", body: "Hi, I'm Nova.", createdAt: "2026-10-02T13:54:20.000Z", audience: "both", rootEventId: "e1" },
        { eventId: "e1", fromPersonUid: "prs_me", body: "Automatic message from HQ: your setup has just finished", createdAt: "2026-10-02T13:53:50.000Z", audience: "agent", replyCount: 1 },
      ],
    };
    const rows = messagesForDisplay(BOT_DM, { inlineReplies: true });
    expect(rows.map((row) => row.eventId)).toEqual(["e2"]);
    expect(rows[0]!.audience).toBe("both");
  });
});

/**
 * Owner finding, round 2: after the visual first run, the setup assistant's
 * chat showed a message from the person themselves holding the raw handoff
 * ("Setup note from the HQ desktop app: ... Handoff from the app: {...}").
 * The app sends it on the bot-only lane, but the server's thread read does
 * not return the lane, so the row arrived untagged and was shown.
 */
describe("the visual first run's notes to the setup assistant", () => {
  const BOT = "agt_setup";
  const ME = "prs_me";
  const at = (n: number): string => `2026-10-10T13:5${n}:00.000Z`;
  const settled = firstRunSettledNotice({ imported: null, team: { kind: "personal" }, apps: null })!;
  const handoff = firstRunHandoffNotice({ name: "Biscuit", runtime: "claude", toolsReady: ["claude"], imported: null, team: null, apps: null });
  const imported = firstRunImportNotice({ summary: { projects: 3, repos: 1 }, report: null });
  /** Newest first, untagged, as the server's direct-message read returns them. */
  const page = {
    messages: [
      { eventId: "e5", fromPersonUid: BOT, body: "You're all set up. What next?", createdAt: at(5) },
      { eventId: "e4", fromPersonUid: ME, body: imported, createdAt: at(4) },
      { eventId: "e3", fromPersonUid: ME, body: settled, createdAt: at(3) },
      { eventId: "e2", fromPersonUid: ME, body: handoff, createdAt: at(2) },
      { eventId: "e1", fromPersonUid: BOT, body: "Hi, I'm Biscuit.", createdAt: at(1) },
    ],
  };

  it("are left out of the conversation, though the server returns them with no lane", () => {
    const rows = messagesForDisplay(page, { inlineReplies: true, selfUid: ME });
    expect(rows.map((row) => row.eventId)).toEqual(["e1", "e5"]);
    const shown = rows.map((row) => row.body ?? "").join("\n");
    expect(shown).not.toContain("Handoff from the app");
    expect(shown).not.toContain("desktop-visual-first-run");
    expect(shown).not.toContain("Setup note from the HQ desktop app");
    // Nothing the person is shown as sending carries the handoff.
    expect(rows.filter((row) => row.fromPersonUid === ME)).toEqual([]);
  });

  it("stay out when merged into an open timeline and when tagged for the bot", () => {
    const merged = mergeFetchedTimeline([], page, { inlineReplies: true, selfUid: ME });
    expect(merged.map((row) => row.eventId)).toEqual(["e1", "e5"]);
    const tagged = { eventId: "t1", fromPersonUid: ME, body: settled, createdAt: at(1), audience: "agent" };
    expect(isAppRequestRow(tagged, { selfUid: ME })).toBe(true);
  });

  it("still carry the marker and the JSON the setup worker reads", () => {
    for (const body of [settled, handoff, imported]) {
      const json = body.match(/Handoff from the app: (\{.*?\})\. /)?.[1];
      expect(json).toBeTruthy();
      const parsed = JSON.parse(json!);
      expect(parsed.from).toBe("desktop-visual-first-run");
      expect(parsed.v).toBe(1);
    }
    expect(JSON.parse(settled.match(/Handoff from the app: (\{.*?\})\. /)![1]!)).toEqual({
      from: "desktop-visual-first-run",
      v: 1,
      done: ["company"],
      team: { kind: "personal" },
    });
  });

  it("does not hide what a bot or another person wrote, or a message the person typed that only mentions the setup", () => {
    expect(isAppRequestRow({ eventId: "b", fromPersonUid: BOT, body: settled }, { selfUid: ME })).toBe(false);
    expect(isAppRequestRow({ eventId: "o", fromPersonUid: "prs_other", body: settled }, { selfUid: ME })).toBe(false);
    expect(isAppRequestRow({ eventId: "s", fromPersonUid: ME, body: "What was the setup note from the HQ desktop app?" }, { selfUid: ME })).toBe(false);
    expect(isAppRequestRow({ eventId: "local-send-1", fromPersonUid: ME, body: settled }, { selfUid: ME })).toBe(false);
  });

  it("shows a message the person typed that quotes the handoff JSON further in", () => {
    const json = settled.match(/Handoff from the app: (\{.*?\})\. /)![1]!;
    const typed = `I saw this in the chat, what is it? Handoff from the app: ${json}. Is that normal?`;
    const row = { eventId: "q1", fromPersonUid: ME, body: typed, createdAt: at(6) };
    expect(isAppRequestRow(row, { selfUid: ME })).toBe(false);
    expect(messagesForDisplay({ messages: [row] }, { inlineReplies: true, selfUid: ME }).map((r) => r.eventId)).toEqual(["q1"]);
  });

  it("shows a message the person typed that opens with the note's lead but carries no handoff", () => {
    const typed = "Setup note from the HQ desktop app: I want to redo the team step.";
    const row = { eventId: "q2", fromPersonUid: ME, body: typed, createdAt: at(6) };
    expect(isAppRequestRow(row, { selfUid: ME })).toBe(false);
    expect(messagesForDisplay({ messages: [row] }, { inlineReplies: true, selfUid: ME }).map((r) => r.eventId)).toEqual(["q2"]);
  });

  it("still hides every note the three first-run builders write", () => {
    const withTeamAndApps = firstRunSettledNotice({
      imported: { summary: { projects: 2 }, report: "workspace/imports/s1/report.json" },
      team: { kind: "company", how: "joined", name: "Acme", slug: "acme" },
      apps: { notes: { name: "Granola", domain: "granola.ai" }, projects: null },
    })!;
    for (const body of [settled, withTeamAndApps, handoff, imported]) {
      expect(isAppRequestRow({ eventId: "n", fromPersonUid: ME, body }, { selfUid: ME })).toBe(true);
    }
  });
});
