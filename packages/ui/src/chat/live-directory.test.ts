import { describe, expect, it } from "vitest";

import { directoryRowCount, normalizeDirectoryFeed } from "./live-directory.js";

describe("normalizeDirectoryFeed", () => {
  it("passes through a contractVersion-2 snapshot", () => {
    const feed = {
      contractVersion: 2,
      snapshot: true,
      cursor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      cursorExpiresAt: "2026-09-01T00:00:00.000Z",
      rows: [
        {
          channelId: "chn_01KWGKHOH5C8TESTCHANNEL0001",
          scope: "project",
          name: "One",
        },
      ],
    };
    expect(normalizeDirectoryFeed(feed)).toBe(feed);
  });

  it("wraps a bare channels array with minted channel ids", () => {
    const feed = normalizeDirectoryFeed({
      channels: [
        {
          id: "chn_01KWGKHOH5C8TESTCHANNEL0002",
          name: "Alpha",
          scope: "project",
        },
      ],
    });
    expect(feed.snapshot).toBe(true);
    expect(feed.rows?.[0]?.channelId).toBe("chn_01KWGKHOH5C8TESTCHANNEL0002");
    expect(feed.rows?.[0]?.name).toBe("Alpha");
    expect(directoryRowCount(feed)).toBe(1);
  });

  it("treats type=project as a project channel and binds a slug name", () => {
    const feed = normalizeDirectoryFeed({
      channels: [
        {
          id: "chn_01KWGKHOH5C8TESTCHANNEL0003",
          name: "work-desktop-dogfood",
          type: "project",
        },
      ],
    });
    expect(feed.rows?.[0]).toEqual(
      expect.objectContaining({
        channelId: "chn_01KWGKHOH5C8TESTCHANNEL0003",
        type: "project",
        scope: "project",
        projectId: "work-desktop-dogfood",
      }),
    );
  });

  it("drops project-slug ids that are not minted channel ids", () => {
    const feed = normalizeDirectoryFeed({
      channels: [{ id: "proj-1", name: "Alpha", scope: "project" }],
    });
    expect(feed.rows ?? []).toEqual([]);
    expect(directoryRowCount(feed)).toBe(0);
  });

  it("lifts nested directoryRow + group members for unnamed chats", () => {
    const feed = normalizeDirectoryFeed({
      channels: [
        {
          channelId: "chn_group",
          name: "",
          scope: "group",
          lastActivityAt: null,
          memberCount: 3,
          members: [
            { personUid: "prs_a", displayName: "Ada" },
            { personUid: "prs_b", displayName: "Ben" },
          ],
          directoryRow: {
            channelId: "chn_group",
            type: "dm",
            scope: "group",
            name: "",
            subtitle: "Direct message",
            lastActivityAt: "2026-08-04T17:25:35.887Z",
            lastHumanMessageAt: "2026-08-03T17:25:35.887Z",
            unreadCount: 0,
            memberCount: 3,
          },
        },
      ],
    });
    expect(feed.rows?.[0]).toEqual(
      expect.objectContaining({
        channelId: "chn_group",
        type: "dm",
        scope: "group",
        lastActivityAt: "2026-08-04T17:25:35.887Z",
        lastHumanMessageAt: "2026-08-03T17:25:35.887Z",
        members: [
          { personUid: "prs_a", displayName: "Ada" },
          { personUid: "prs_b", displayName: "Ben" },
        ],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Company icon (`iconUrl`). The server stamps it on company-owned rows; the
// normalizer must carry it (in either casing, top level or nested) and must
// leave it undefined when absent so reconciliation cannot blank a known icon.
// ---------------------------------------------------------------------------
describe("normalizeDirectoryFeed — iconUrl", () => {
  const ICON =
    "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/branding/cmp_acme/favicon.png?X-Amz-Signature=mock";

  function firstRow(channels: unknown[]) {
    return normalizeDirectoryFeed({ channels }).rows?.[0];
  }

  it("reads iconUrl from the top level of a channel payload", () => {
    expect(
      firstRow([
        {
          channelId: "chn_01KWGKHOH5C8TESTCHANNEL0001",
          scope: "company",
          companyUid: "cmp_acme",
          name: "general",
          iconUrl: ICON,
        },
      ])?.iconUrl,
    ).toBe(ICON);
  });

  it("reads iconUrl from the nested directoryRow", () => {
    expect(
      firstRow([
        {
          channelId: "chn_01KWGKHOH5C8TESTCHANNEL0001",
          scope: "company",
          name: "general",
          directoryRow: { companyUid: "cmp_acme", iconUrl: ICON },
        },
      ])?.iconUrl,
    ).toBe(ICON);
  });

  it("accepts the snake_case spelling like every sibling field", () => {
    expect(
      firstRow([
        {
          channelId: "chn_01KWGKHOH5C8TESTCHANNEL0001",
          scope: "company",
          name: "general",
          icon_url: ICON,
        },
      ])?.iconUrl,
    ).toBe(ICON);
  });

  it("leaves iconUrl undefined when the server does not send it", () => {
    // A v-old server omits the field entirely; undefined (not null) is what
    // lets reconciliation preserve an already-known icon.
    expect(
      firstRow([
        {
          channelId: "chn_01KWGKHOH5C8TESTCHANNEL0001",
          scope: "company",
          companyUid: "cmp_acme",
          name: "general",
        },
      ])?.iconUrl,
    ).toBeUndefined();
  });

  it("leaves iconUrl undefined for an empty or non-string value", () => {
    for (const iconUrl of ["", "   ", 42, {}, []]) {
      expect(
        firstRow([
          {
            channelId: "chn_01KWGKHOH5C8TESTCHANNEL0001",
            scope: "company",
            name: "general",
            iconUrl,
          },
        ])?.iconUrl,
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Last human message. The server sends `lastHumanMessageAt` when it knows the
// time, `hasHumanMessage: false` when it knows there is none, and neither when
// it does not know. Both are mirrored at the top level of the list row and on
// `directoryRow`. Absent must stay absent so it is never read as "none".
// ---------------------------------------------------------------------------
describe("normalizeDirectoryFeed: last human message (three states)", () => {
  function firstRow(channel: Record<string, unknown>) {
    return normalizeDirectoryFeed({
      channels: [{ channelId: "chn_01KWGKHOH5C8TESTCHANNEL0001", scope: "company", name: "ops", ...channel }],
    }).rows?.[0];
  }

  it("known: reads the time from the top level or the nested directoryRow", () => {
    expect(
      firstRow({ lastHumanMessageAt: "2026-09-30T10:00:00.000Z" })?.lastHumanMessageAt,
    ).toBe("2026-09-30T10:00:00.000Z");
    expect(
      firstRow({ directoryRow: { lastHumanMessageAt: "2026-09-29T10:00:00.000Z" } })
        ?.lastHumanMessageAt,
    ).toBe("2026-09-29T10:00:00.000Z");
    expect(
      firstRow({ last_human_message_at: "2026-09-28T10:00:00.000Z" })?.lastHumanMessageAt,
    ).toBe("2026-09-28T10:00:00.000Z");
  });

  it("none: reads hasHumanMessage false from the top level or the nested directoryRow", () => {
    for (const channel of [
      { hasHumanMessage: false },
      { directoryRow: { hasHumanMessage: false } },
      { has_human_message: false },
    ]) {
      const row = firstRow(channel);
      expect(row?.hasHumanMessage).toBe(false);
      expect(row && "lastHumanMessageAt" in row).toBe(false);
    }
  });

  it("unknown: a row with neither field carries neither key", () => {
    for (const channel of [
      {},
      { lastHumanMessageAt: null },
      { hasHumanMessage: true },
      { directoryRow: { lastActivityAt: "2026-09-30T10:00:00.000Z" } },
    ]) {
      const row = firstRow(channel);
      expect(row).toBeDefined();
      expect(row && "lastHumanMessageAt" in row).toBe(false);
      expect(row && "hasHumanMessage" in row).toBe(false);
    }
  });

  it("a time wins over a stray hasHumanMessage false", () => {
    const row = firstRow({
      hasHumanMessage: false,
      directoryRow: { lastHumanMessageAt: "2026-09-29T10:00:00.000Z" },
    });
    expect(row?.lastHumanMessageAt).toBe("2026-09-29T10:00:00.000Z");
    expect(row && "hasHumanMessage" in row).toBe(false);
  });

  it("carries the creation time used to order known-none rows", () => {
    expect(
      firstRow({ hasHumanMessage: false, createdAt: "2026-08-01T00:00:00.000Z" })?.createdAt,
    ).toBe("2026-08-01T00:00:00.000Z");
  });
});
