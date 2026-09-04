import { describe, expect, it } from "vitest";

import {
  applyHonestDirectoryActivity,
  boardFromWorkItems,
  honestRowActivityAt,
  mergeLiveContacts,
  mergeWorkProjectsIntoDirectory,
  parseInboxPage,
  parseWorkFeed,
} from "./live-sidebar.js";

describe("parseInboxPage", () => {
  it("reads events, pair unreads, and a successor cursor", () => {
    const page = parseInboxPage({
      events: [
        { fromPersonUid: "prs_j", createdAt: "2026-08-16T12:00:00.000Z" },
      ],
      pairUnreads: [{ withPersonUid: "prs_j", unreadCount: 2 }],
      nextCursor: "abc",
    });
    expect(page.events).toHaveLength(1);
    expect(page.pairUnreads[0]?.unreadCount).toBe(2);
    expect(page.nextCursor).toBe("abc");
  });
});

describe("mergeLiveContacts", () => {
  it("stamps inbox activity and skips the caller's own outbound events", () => {
    const merged = mergeLiveContacts(
      [{ personUid: "prs_jacob", displayName: "Jacob" }],
      [
        {
          fromPersonUid: "prs_me",
          fromDisplayName: "Stefan",
          createdAt: "2026-08-16T22:00:00.000Z",
        },
        {
          fromPersonUid: "prs_jacob",
          fromDisplayName: "Jacob",
          createdAt: "2026-08-16T21:00:00.000Z",
        },
      ],
      [],
      "prs_me",
    );
    expect(merged).toEqual([
      expect.objectContaining({
        personUid: "prs_jacob",
        lastMessageAt: "2026-08-16T21:00:00.000Z",
      }),
    ]);
  });

  it("promotes a pair-unread that is missing from contacts", () => {
    const merged = mergeLiveContacts(
      [],
      [],
      [{ withPersonUid: "prs_new", unreadCount: 3 }],
      "prs_me",
    );
    expect(merged).toEqual([
      expect.objectContaining({ personUid: "prs_new", unreadCount: 3 }),
    ]);
  });
});

describe("mergeWorkProjectsIntoDirectory", () => {
  it("keeps work-feed-only projects out of the chat directory", () => {
    const rows = mergeWorkProjectsIntoDirectory(
      [
        {
          channelId: "chn_1",
          scope: "project",
          projectId: "hq-work-mono",
          name: "Project hq-work-mono abcd",
          lastActivityAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      [
        {
          projectId: "hq-work-mono",
          companyUid: "cmp_1",
          lastActivityAt: "2026-08-16T01:00:00.000Z",
        },
        {
          projectId: "indigo-marketing",
          companyUid: "cmp_1",
          lastActivityAt: "2026-08-17T01:44:00.000Z",
        },
      ],
    );
    expect(rows.map((r) => r.projectId ?? r.channelId)).toEqual([
      "hq-work-mono",
    ]);
    expect(rows.find((row) => row.projectId === "indigo-marketing")).toBeUndefined();
  });

  it("enriches the existing notify row without replacing its channel id", () => {
    const rows = mergeWorkProjectsIntoDirectory(
      [
        {
          channelId: "chn_project_1",
          type: "project",
          scope: "project",
          projectId: "hq-work-mono",
          name: "Project hq-work-mono abcd",
          lastActivityAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      [
        {
          projectId: "hq-work-mono",
          companyUid: "cmp_1",
          lastActivityAt: "2026-08-17T01:00:00.000Z",
        },
      ],
    );

    expect(rows).toEqual([
      expect.objectContaining({
        channelId: "chn_project_1",
        projectId: "hq-work-mono",
        lastActivityAt: "2026-08-17T01:00:00.000Z",
      }),
    ]);
  });
});

describe("boardFromWorkItems", () => {
  const items = [
    {
      projectId: "hq-work-mono",
      companyUid: "cmp_1",
      lastActivityAt: "2026-08-16T00:00:00.000Z",
      threadStatus: "in-progress",
      progressSummary: "Wire MQTT",
      threadId: "t1",
    },
    {
      projectId: "other",
      companyUid: "cmp_2",
      lastActivityAt: "2026-08-16T00:00:00.000Z",
      threadStatus: "open",
      threadId: "t2",
    },
  ];

  it("builds a board from work-mesh rows", () => {
    const board = boardFromWorkItems("hq-work-mono", items);
    expect(board?.columns.find((c) => c.id === "in_progress")?.cards).toEqual([
      expect.objectContaining({ storyId: "t1", label: "Wire MQTT" }),
    ]);
  });
});

describe("honestRowActivityAt", () => {
  it("uses newest work-mesh activity, not created-on", () => {
    const at = honestRowActivityAt(
      {
        channelId: "chn_1",
        scope: "project",
        projectId: "outpost-ec2-migration",
        name: "Project outpost-ec2-migration",
        lastActivityAt: "2026-08-17T03:10:56.885Z",
        createdAt: "2026-08-17T03:10:56.885Z",
        updatedAt: "2026-08-17T03:10:56.885Z",
      },
      [
        {
          projectId: "outpost-ec2-migration",
          companyUid: "cmp_1",
          lastActivityAt: "2026-08-15T18:00:00.000Z",
          createdAt: "2026-06-05T08:45:00.000Z",
          threadStatus: "needs-human",
        },
      ],
    );
    expect(at).toBe("2026-08-15T18:00:00.000Z");
  });

  it("keeps a real in-progress last activity", () => {
    const at = honestRowActivityAt(
      {
        channelId: "chn_1",
        scope: "project",
        projectId: "hq-work-mono",
        name: "hq-work-mono",
        lastActivityAt: "2026-08-17T03:10:00.000Z",
        createdAt: "2026-08-17T03:10:00.000Z",
        updatedAt: "2026-08-17T03:10:00.000Z",
      },
      [
        {
          projectId: "hq-work-mono",
          companyUid: "cmp_1",
          lastActivityAt: "2026-08-16T22:00:00.000Z",
          createdAt: "2026-08-01T00:00:00.000Z",
          threadStatus: "in-progress",
        },
      ],
    );
    expect(at).toBe("2026-08-16T22:00:00.000Z");
  });

  it("falls back to created-on when there is no real work activity", () => {
    expect(
      honestRowActivityAt({
        channelId: "chn_new",
        scope: "project",
        projectId: "brand-new",
        name: "brand-new",
        lastActivityAt: "2026-08-17T03:10:00.000Z",
        createdAt: "2026-04-01T12:00:00.000Z",
        updatedAt: "2026-08-17T03:10:00.000Z",
      }),
    ).toBe("2026-04-01T12:00:00.000Z");
  });

  it("keeps the previous cached date when the work feed is empty", () => {
    const rows = applyHonestDirectoryActivity(
      [
        {
          channelId: "chn_1",
          scope: "project",
          projectId: "old",
          name: "old",
          lastActivityAt: "2026-08-17T03:10:00.000Z",
          createdAt: "2026-08-17T03:10:00.000Z",
          updatedAt: "2026-08-17T03:10:00.000Z",
        },
      ],
      [],
      [
        {
          channelId: "chn_1",
          scope: "project",
          projectId: "old",
          name: "old",
          lastActivityAt: "2026-04-01T12:00:00.000Z",
        },
      ],
    );
    expect(rows[0]?.lastActivityAt).toBe("2026-08-17T03:10:00.000Z");
  });

  it("rewrites a whole directory through applyHonestDirectoryActivity", () => {
    const rows = applyHonestDirectoryActivity(
      [
        {
          channelId: "chn_1",
          scope: "project",
          projectId: "old",
          name: "old",
          lastActivityAt: "2026-08-17T03:10:00.000Z",
          createdAt: "2026-08-17T03:10:00.000Z",
          updatedAt: "2026-08-17T03:10:00.000Z",
        },
      ],
      [
        {
          projectId: "old",
          companyUid: "cmp_1",
          lastActivityAt: "2026-08-17T03:11:00.000Z",
          createdAt: "2026-04-01T12:00:00.000Z",
          threadStatus: "open",
        },
      ],
    );
    expect(rows[0]?.lastActivityAt).toBe("2026-08-17T03:11:00.000Z");
  });

  it("matches work-mesh activity from a Project slug hash name", () => {
    expect(
      honestRowActivityAt(
        {
          channelId: "chn_1",
          scope: "project",
          projectId: "import-data-redesign",
          name: "Project import-data-redesign abcd1234",
          lastActivityAt: "2026-08-17T03:10:00.000Z",
          createdAt: "2026-08-17T03:10:00.000Z",
          updatedAt: "2026-08-17T03:10:00.000Z",
        },
        [
          {
            projectId: "import-data-redesign",
            companyUid: "cmp_1",
            lastActivityAt: "2026-08-17T17:28:07.141Z",
            createdAt: "2026-08-07T00:04:01.501Z",
            threadStatus: "in-progress",
          },
        ],
      ),
    ).toBe("2026-08-17T17:28:07.141Z");
  });

  it("dates a Thursday-created project on Thursday when that is the activity", () => {
    expect(
      honestRowActivityAt(
        {
          channelId: "chn_thu",
          scope: "project",
          projectId: "thu-project",
          name: "thu-project",
          lastActivityAt: "2026-08-14T16:00:00.000Z",
          createdAt: "2026-08-14T09:00:00.000Z",
          updatedAt: "2026-08-14T16:00:00.000Z",
        },
        [
          {
            projectId: "thu-project",
            companyUid: "cmp_1",
            lastActivityAt: "2026-08-14T16:00:00.000Z",
            createdAt: "2026-08-14T09:00:00.000Z",
            threadStatus: "open",
          },
        ],
      ),
    ).toBe("2026-08-14T16:00:00.000Z");
  });
});

describe("parseWorkFeed", () => {
  it("reads the open snapshot", () => {
    const items = parseWorkFeed({
      open: [{ projectId: "a", companyUid: "c", lastActivityAt: "t" }],
    });
    expect(items).toEqual([
      expect.objectContaining({ projectId: "a", companyUid: "c" }),
    ]);
  });

  it("merges open and changed rows", () => {
    const items = parseWorkFeed({
      open: [{ projectId: "a", lastActivityAt: "t1" }],
      changed: [{ projectId: "b", lastActivityAt: "t2" }],
    });
    expect(items.map((item) => item.projectId)).toEqual(["a", "b"]);
  });

  it("reads projectId from routing tags when the field is missing", () => {
    const items = parseWorkFeed({
      open: [
        {
          lastActivityAt: "2026-08-17T17:28:07.141Z",
          routing: { tags: ["hq-project", "project:import-data-redesign"] },
        },
      ],
    });
    expect(items[0]?.projectId).toBe("import-data-redesign");
  });

});
