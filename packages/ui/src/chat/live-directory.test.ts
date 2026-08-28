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
        members: [
          { personUid: "prs_a", displayName: "Ada" },
          { personUid: "prs_b", displayName: "Ben" },
        ],
      }),
    );
  });
});
