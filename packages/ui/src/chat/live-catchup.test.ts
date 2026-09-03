import { describe, expect, it } from "vitest";

import {
  channelActivityFromTimeline,
  dmActivityFromInboxPage,
  dmActivityFromThreadsPage,
  isMissingEndpointFailure,
  mergeDmActivity,
  dmActivityFromTimeline,
  pairUnreadsFromInboxPage,
  shouldArmDirectorySafety,
  shouldBumpDmUnread,
  TIMELINE_SAFETY_INTERVAL_MS,
} from "./live-catchup.js";

describe("shouldArmDirectorySafety", () => {
  it("polls only while MQTT is not connected", () => {
    expect(shouldArmDirectorySafety("connected")).toBe(false);
    expect(shouldArmDirectorySafety("reconnecting")).toBe(true);
    expect(shouldArmDirectorySafety("paused-hidden")).toBe(true);
    expect(shouldArmDirectorySafety(undefined)).toBe(true);
    expect(TIMELINE_SAFETY_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe("shouldBumpDmUnread", () => {
  it("bumps Deacon when a project channel is selected", () => {
    expect(
      shouldBumpDmUnread({
        selectedId: "ch:chn_proj",
        fromPersonUid: "agt_deacon",
        selfUid: "prs_stefan",
      }),
    ).toBe(true);
  });

  it("does not bump the open DM or the caller's own send", () => {
    expect(
      shouldBumpDmUnread({
        selectedId: "dm:agt_deacon",
        fromPersonUid: "agt_deacon",
      }),
    ).toBe(false);
    expect(
      shouldBumpDmUnread({
        selectedId: "ch:chn_proj",
        fromPersonUid: "prs_stefan",
        selfUid: "prs_stefan",
      }),
    ).toBe(false);
  });
});

describe("pairUnreadsFromInboxPage", () => {
  it("establishes a since cursor on first page without incrementing", () => {
    expect(
      pairUnreadsFromInboxPage({
        events: [
          {
            fromPersonUid: "prs_b",
            createdAt: "2026-08-18T12:00:00.000Z",
          },
        ],
      }),
    ).toEqual({ nextSince: "2026-08-18T12:00:00.000Z" });
  });

  it("increments only new inbound events once a since cursor exists", () => {
    expect(
      pairUnreadsFromInboxPage(
        {
          events: [
            {
              fromPersonUid: "prs_b",
              createdAt: "2026-08-18T13:00:00.000Z",
            },
          ],
        },
        { since: "2026-08-18T12:00:00.000Z", selfUid: "prs_me" },
      ),
    ).toEqual({
      pairUnreads: [{ withPersonUid: "prs_b", unreadCount: 1 }],
      nextSince: "2026-08-18T13:00:00.000Z",
      delta: true,
    });
  });

  it("uses server pairUnreads when the inbox page names Deacon", () => {
    expect(
      pairUnreadsFromInboxPage(
        {
          events: [
            {
              fromPersonUid: "agt_deacon",
              createdAt: "2026-08-22T19:59:22.000Z",
            },
          ],
          pairUnreads: [{ withPersonUid: "agt_deacon", unreadCount: 1 }],
        },
        { since: "2026-08-22T19:58:50.000Z" },
      ),
    ).toEqual({
      pairUnreads: [{ withPersonUid: "agt_deacon", unreadCount: 1 }],
      nextSince: "2026-08-22T19:59:22.000Z",
    });
  });
});

describe("dmActivityFromInboxPage", () => {
  it("keeps the newest createdAt per person", () => {
    expect(
      dmActivityFromInboxPage({
        events: [
          {
            fromPersonUid: "prs_b",
            createdAt: "2026-08-18T12:00:00.000Z",
            fromDisplayName: "Bee",
          },
          {
            fromPersonUid: "prs_c",
            createdAt: "2026-08-17T09:00:00.000Z",
          },
          {
            fromPersonUid: "prs_b",
            createdAt: "2026-08-18T15:00:00.000Z",
            fromDisplayName: "Bee",
          },
        ],
      }),
    ).toEqual([
      {
        personUid: "prs_b",
        lastMessageAt: "2026-08-18T15:00:00.000Z",
        displayName: "Bee",
      },
      {
        personUid: "prs_c",
        lastMessageAt: "2026-08-17T09:00:00.000Z",
      },
    ]);
  });

  it("skips blank uids and the caller", () => {
    expect(
      dmActivityFromInboxPage(
        {
          events: [
            {
              fromPersonUid: "prs_me",
              createdAt: "2026-08-18T12:00:00.000Z",
            },
            {
              fromPersonUid: "  ",
              createdAt: "2026-08-18T12:00:00.000Z",
            },
            {
              fromPersonUid: "prs_b",
              createdAt: "2026-08-18T12:00:00.000Z",
            },
            {
              fromPersonUid: "prs_c",
              createdAt: 123,
            },
          ],
        },
        { selfUid: "prs_me" },
      ),
    ).toEqual([
      { personUid: "prs_b", lastMessageAt: "2026-08-18T12:00:00.000Z" },
    ]);
  });

  it("returns [] for malformed input", () => {
    expect(dmActivityFromInboxPage(null)).toEqual([]);
    expect(dmActivityFromInboxPage(undefined)).toEqual([]);
    expect(dmActivityFromInboxPage([])).toEqual([]);
    expect(dmActivityFromInboxPage("nope")).toEqual([]);
    expect(dmActivityFromInboxPage({ events: "nope" })).toEqual([]);
  });
});

describe("dmActivityFromTimeline", () => {
  it("keeps the newest createdAt across mixed inbound and outbound messages", () => {
    expect(
      dmActivityFromTimeline("prs_jacob", [
        {
          createdAt: "2026-08-18T16:09:15.946Z",
          direction: "in",
          fromPersonUid: "prs_jacob",
          body: "older",
        },
        {
          createdAt: "2026-09-01T21:38:07.000Z",
          direction: "in",
          fromPersonUid: "prs_jacob",
          body: "Hey",
        },
        {
          createdAt: "2026-09-01T21:38:30.000Z",
          direction: "out",
          fromPersonUid: "prs_self",
          body: "Hey there",
        },
      ]),
    ).toEqual({
      personUid: "prs_jacob",
      lastMessageAt: "2026-09-01T21:38:30.000Z",
    });
  });

  it("counts a delegation card with details+prompt and empty body", () => {
    expect(
      dmActivityFromTimeline("prs_jacob", [
        {
          createdAt: "2026-08-18T12:00:00.000Z",
          direction: "in",
          body: "Hey",
        },
        {
          createdAt: "2026-09-01T15:00:00.000Z",
          body: "",
          details: "Hand this off to Deacon",
          prompt: "Please take the next step",
          messageKind: "delegation",
        },
      ]),
    ).toEqual({
      personUid: "prs_jacob",
      lastMessageAt: "2026-09-01T15:00:00.000Z",
    });
  });

  it("ignores messages whose createdAt is not a non-empty string", () => {
    expect(
      dmActivityFromTimeline("prs_jacob", [
        { createdAt: 1_725_000_000_000 },
        { createdAt: "" },
        { createdAt: null },
        {},
        { createdAt: "2026-09-01T21:38:07.000Z" },
      ]),
    ).toEqual({
      personUid: "prs_jacob",
      lastMessageAt: "2026-09-01T21:38:07.000Z",
    });
  });

  it("returns null for an empty list or a blank uid", () => {
    expect(dmActivityFromTimeline("prs_jacob", [])).toBeNull();
    expect(
      dmActivityFromTimeline("  ", [
        { createdAt: "2026-09-01T21:38:07.000Z" },
      ]),
    ).toBeNull();
    expect(dmActivityFromTimeline("", [{ createdAt: "2026-09-01T21:38:07.000Z" }])).toBeNull();
  });
});

describe("channelActivityFromTimeline", () => {
  it("keeps the newest createdAt across mixed inbound and outbound messages", () => {
    expect(
      channelActivityFromTimeline("chn_hq_dev", [
        {
          createdAt: "2026-08-18T16:09:15.946Z",
          fromPersonUid: "prs_other",
          eventId: "evt_old",
        },
        {
          createdAt: "2026-09-02T03:19:00.000Z",
          fromPersonUid: "prs_me",
          eventId: "evt_own",
          body: "Fleet agents incident update",
        },
        {
          createdAt: "2026-09-01T21:38:07.000Z",
          fromPersonUid: "prs_other",
          eventId: "evt_in",
        },
      ]),
    ).toEqual({
      channelId: "chn_hq_dev",
      lastMessageAt: "2026-09-02T03:19:00.000Z",
      fromPersonUid: "prs_me",
      eventId: "evt_own",
    });
  });

  it("counts a message with an empty body", () => {
    expect(
      channelActivityFromTimeline("chn_proj", [
        {
          createdAt: "2026-08-18T12:00:00.000Z",
          fromPersonUid: "prs_other",
          eventId: "evt_old",
          body: "Hey",
        },
        {
          createdAt: "2026-09-02T15:00:00.000Z",
          fromPersonUid: "prs_me",
          eventId: "evt_card",
          body: "",
        },
      ]),
    ).toEqual({
      channelId: "chn_proj",
      lastMessageAt: "2026-09-02T15:00:00.000Z",
      fromPersonUid: "prs_me",
      eventId: "evt_card",
    });
  });

  it("ignores messages whose createdAt is not a non-empty string", () => {
    expect(
      channelActivityFromTimeline("chn_hq_dev", [
        { createdAt: 1_725_000_000_000 },
        { createdAt: "" },
        { createdAt: null },
        {},
        { createdAt: "2026-09-02T03:19:00.000Z", fromPersonUid: "prs_me" },
      ]),
    ).toEqual({
      channelId: "chn_hq_dev",
      lastMessageAt: "2026-09-02T03:19:00.000Z",
      fromPersonUid: "prs_me",
    });
  });

  it("returns null for an empty list or a blank channel id", () => {
    expect(channelActivityFromTimeline("chn_hq_dev", [])).toBeNull();
    expect(
      channelActivityFromTimeline("  ", [
        { createdAt: "2026-09-02T03:19:00.000Z" },
      ]),
    ).toBeNull();
    expect(
      channelActivityFromTimeline("", [
        { createdAt: "2026-09-02T03:19:00.000Z" },
      ]),
    ).toBeNull();
  });
});

describe("dmActivityFromThreadsPage — the per-user DM peer index", () => {
  it("yields one stamp per peer from { threads: [{ peerUid, lastActivityAt }] }", () => {
    const out = dmActivityFromThreadsPage({
      threads: [
        {
          peerUid: "prs_jacob",
          lastActivityAt: "2026-09-01T21:38:30.000Z",
          lastEventId: "evt_2",
        },
        {
          peerUid: "prs_sent_last",
          lastActivityAt: "2026-08-27T09:00:00.000Z",
          lastEventId: "evt_1",
        },
      ],
      nextCursor: "abc",
    });
    expect(out).toEqual([
      { personUid: "prs_jacob", lastMessageAt: "2026-09-01T21:38:30.000Z" },
      { personUid: "prs_sent_last", lastMessageAt: "2026-08-27T09:00:00.000Z" },
    ]);
  });

  it("skips self, blank uids, malformed rows and non-string stamps", () => {
    const out = dmActivityFromThreadsPage(
      {
        threads: [
          { peerUid: "prs_me", lastActivityAt: "2026-09-01T00:00:00.000Z" },
          { peerUid: "  ", lastActivityAt: "2026-09-01T00:00:00.000Z" },
          { peerUid: "prs_no_stamp", lastActivityAt: 12345 },
          null,
          "junk",
          { peerUid: "prs_ok", lastActivityAt: "2026-09-01T00:00:00.000Z" },
        ],
      },
      { selfUid: "prs_me" },
    );
    expect(out).toEqual([
      { personUid: "prs_ok", lastMessageAt: "2026-09-01T00:00:00.000Z" },
    ]);
  });

  it("returns [] for a non-object page or a page without threads", () => {
    expect(dmActivityFromThreadsPage(null)).toEqual([]);
    expect(dmActivityFromThreadsPage([])).toEqual([]);
    expect(dmActivityFromThreadsPage({ events: [] })).toEqual([]);
  });
});

describe("mergeDmActivity — newest stamp per peer wins, names survive", () => {
  it("prefers the newer stamp regardless of source order and keeps a known name", () => {
    const inbox = [
      {
        personUid: "prs_jacob",
        lastMessageAt: "2026-09-01T21:38:07.837Z",
        displayName: "Jacob Posel",
      },
    ];
    const threads = [
      { personUid: "prs_jacob", lastMessageAt: "2026-09-01T21:38:30.000Z" },
      { personUid: "prs_sent_last", lastMessageAt: "2026-08-27T09:00:00.000Z" },
    ];
    expect(mergeDmActivity(inbox, threads)).toEqual([
      {
        personUid: "prs_jacob",
        lastMessageAt: "2026-09-01T21:38:30.000Z",
        displayName: "Jacob Posel",
      },
      { personUid: "prs_sent_last", lastMessageAt: "2026-08-27T09:00:00.000Z" },
    ]);
    expect(mergeDmActivity(threads, inbox)).toEqual([
      {
        personUid: "prs_jacob",
        lastMessageAt: "2026-09-01T21:38:30.000Z",
        displayName: "Jacob Posel",
      },
      { personUid: "prs_sent_last", lastMessageAt: "2026-08-27T09:00:00.000Z" },
    ]);
  });
});

describe("isMissingEndpointFailure — feature-detecting dm-threads", () => {
  it("treats HTTP 404, NOT_FOUND codes, and unavailable adapters as missing", () => {
    expect(isMissingEndpointFailure({ ok: false, code: "http-404" })).toBe(true);
    expect(
      isMissingEndpointFailure({ ok: false, reason: "error", code: "ROUTE_NOT_FOUND" }),
    ).toBe(true);
    expect(
      isMissingEndpointFailure({
        ok: false,
        reason: "unavailable",
        code: "not-yet-implemented-api",
      }),
    ).toBe(true);
  });

  it("does not mistake other failures for a missing endpoint", () => {
    expect(isMissingEndpointFailure({ ok: false, code: "http-500" })).toBe(false);
    expect(isMissingEndpointFailure({ ok: false, reason: "error", code: "network" })).toBe(
      false,
    );
    expect(isMissingEndpointFailure(null)).toBe(false);
    expect(isMissingEndpointFailure(undefined)).toBe(false);
  });
});
