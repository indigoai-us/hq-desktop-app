import { describe, expect, it } from "vitest";
import {
  parseMeshCachedMessage,
  parseMeshDirectoryRow,
  parseMeshProjectView,
  parseWorkMeshSnapshot,
} from "./parse.js";
import {
  boardActivityFromLive,
  normalizeStoryStage,
  overlayFromSnapshot,
  projectViewToBoard,
} from "./map.js";

const SNAPSHOT = {
  projects: [
    {
      companyUid: "cmp_indigo",
      projectId: "work-mesh-testing",
      name: "work-mesh-testing",
      description: "Live board for HQ Work mesh.",
      stories: [
        {
          id: "US-000",
          title: "Genesis",
          status: "done",
          passes: true,
          acceptanceCriteria: ["thread exists"],
        },
        {
          id: "US-008",
          title: "Story status",
          status: "in_progress",
          passes: false,
          acceptanceCriteria: [
            { text: "PATCH doorbells", done: true },
            { text: "Board columns honor status", done: false },
          ],
        },
        { id: "US-009", title: "Queued work", status: "queued" },
      ],
      repos: [{ path: "repos/private/hq-pro", branch: "main" }],
      files: [
        {
          path: "projects/work-mesh-testing/prd.json",
          name: "prd.json",
          updatedAt: "2026-08-15T22:21:00.000Z",
        },
      ],
      updatedAt: "2026-08-16T05:41:14.155Z",
    },
  ],
  channels: [
    {
      channelId: "chn_linked",
      messages: [
        {
          eventId: "m1",
          fromDisplayName: "Deacon",
          fromPersonUid: "agt_deacon",
          body: "probe @Deacon",
          createdAt: "2026-08-16T01:28:01.538Z",
          reactions: [{ emoji: "🎉", count: 1, reactedByMe: false }],
          mentions: [
            {
              participantUid: "agt_deacon",
              participantType: "agent",
              displayName: "Deacon",
            },
          ],
        },
      ],
    },
    {
      channelId: "chn_orphan",
      messages: [
        {
          eventId: "o1",
          fromDisplayName: "Stefan",
          body: "orphan",
          createdAt: "2026-08-15T00:55:42.162Z",
        },
      ],
    },
  ],
  genesis: [
    {
      projectId: "work-mesh-testing",
      channelId: "chn_linked",
      channelName: "Project work-mesh-testing",
    },
  ],
};

describe("parseMeshDirectoryRow", () => {
  it("keeps projectId from the directory payload", () => {
    expect(
      parseMeshDirectoryRow({
        channelId: "chn_teams",
        type: "project",
        scope: "project",
        companyUid: "cmp_indigo",
        projectId: "work-mesh-testing",
        name: "teams-agent-channel",
        lastActivityAt: "2026-08-15T12:00:00.000Z",
        memberCount: 4,
      })?.projectId,
    ).toBe("work-mesh-testing");
  });
});

describe("parseMeshCachedMessage mentions", () => {
  it("keeps structured mentions on a cached channel message", () => {
    const parsed = parseMeshCachedMessage({
      eventId: "m1",
      createdAt: "2026-08-16T01:28:01.538Z",
      body: "hey @Deacon",
      mentions: [
        {
          participantUid: "agt_deacon",
          participantType: "agent",
          displayName: "Deacon",
        },
      ],
    });
    expect(parsed?.mentions).toEqual([
      {
        participantUid: "agt_deacon",
        participantType: "agent",
        displayName: "Deacon",
      },
    ]);
  });
});

describe("work-mesh snapshot overlay", () => {
  it("parses a PROJECT_VIEW into board columns by story.status", () => {
    const snap = parseWorkMeshSnapshot(SNAPSHOT);
    const board = projectViewToBoard(snap.projects[0]!);
    expect(board.columns.map((c) => c.id)).toEqual([
      "queued",
      "in_progress",
      "review",
      "done",
    ]);
    expect(board.columns.map((c) => c.title)).toEqual([
      "To do",
      "Doing",
      "Waiting",
      "Done",
    ]);
    expect(board.columns.find((c) => c.id === "review")?.cards).toEqual([]);
    expect(
      board.columns.find((c) => c.id === "queued")?.cards.map((c) => c.storyId),
    ).toEqual(["US-009"]);
    expect(board.stories["US-008"]?.acCountLabel).toBe("1 / 2");
    expect(board.stories["US-000"]?.statusBadge).toBe("Done");
    expect(board.stories["US-009"]?.statusBadge).toBe("To do");
  });

  it("copies PROJECT_VIEW description onto channel status", () => {
    const snap = parseWorkMeshSnapshot(SNAPSHOT);
    const overlay = overlayFromSnapshot(snap);
    expect(overlay.statusByChannelId.chn_linked?.description).toBe(
      "Live board for HQ Work mesh.",
    );
  });

  it("parses vault-style userStories onto the board", () => {
    const board = projectViewToBoard(
      parseMeshProjectView({
        companyUid: "cmp_x",
        projectId: "work-desktop-dogfood",
        userStories: [
          { id: "US-001", title: "Native notifications", passes: false },
        ],
      })!,
    );
    expect(
      board.columns.find((c) => c.id === "queued")?.cards.map((c) => c.storyId),
    ).toEqual(["US-001"]);
  });

  it("keeps empty stage columns when a project has no stories", () => {
    const board = projectViewToBoard({
      companyUid: "cmp_x",
      projectId: "empty",
      stories: [],
      repos: [],
    });
    expect(board.columns.map((c) => [c.id, c.cards.length])).toEqual([
      ["queued", 0],
      ["in_progress", 0],
      ["review", 0],
      ["done", 0],
    ]);
  });

  it("falls back to Updated activity when no live/task rows are passed", () => {
    const board = projectViewToBoard({
      companyUid: "cmp_x",
      projectId: "p",
      stories: [{ id: "US-015", title: "Live", status: "in_progress" }],
      repos: [],
      updatedAt: "2026-09-04T11:58:00.000Z",
    });
    expect(board.stories["US-015"]?.activity).toEqual([
      { id: "updated", at: "11:58", text: "Updated" },
    ]);
  });

  it("builds live session + task_status activity per story (case-insensitive)", () => {
    const board = projectViewToBoard(
      {
        companyUid: "cmp_x",
        projectId: "work-mesh-live",
        stories: [
          { id: "US-015", title: "Live read", status: "in_progress" },
          { id: "US-016", title: "Other", status: "queued" },
        ],
        repos: [],
        updatedAt: "2026-09-04T12:00:00.000Z",
      },
      {
        liveSessions: [
          {
            sessionId: "sess_corey",
            actorUid: "prs_corey",
            displayName: "Corey",
            harness: "claude-code",
            taskId: "us-015",
            turnCount: 12,
            lastTurnAt: "2026-09-04T11:58:00.000Z",
          },
          {
            sessionId: "sess_other",
            displayName: "Other",
            harness: "codex",
            taskId: "US-016",
            turnCount: 1,
            lastTurnAt: "2026-09-04T11:00:00.000Z",
          },
        ],
        taskStatusChanges: [
          {
            id: "tsc_1",
            taskId: "US-015",
            at: "2026-09-04T11:50:00.000Z",
            text: "Corey moved US-015 to in_progress",
          },
        ],
      },
    );
    expect(board.stories["US-015"]?.activity).toEqual([
      {
        id: "tsc_1",
        at: "11:50",
        text: "Corey moved US-015 to in_progress",
      },
      {
        id: "sess_corey",
        at: "11:58",
        text: "Corey · claude-code · 12 turns",
      },
    ]);
    expect(board.stories["US-016"]?.activity).toEqual([
      {
        id: "sess_other",
        at: "11:00",
        text: "Other · codex · 1 turns",
      },
    ]);
    expect(boardActivityFromLive("US-015", undefined, "2026-09-04T09:00:00Z")).toEqual(
      [{ id: "updated", at: "09:00", text: "Updated" }],
    );
  });

  it("maps official and alias statuses onto the four stages", () => {
    expect(normalizeStoryStage({ id: "a", title: "a", status: "queued" })).toBe(
      "queued",
    );
    expect(normalizeStoryStage({ id: "a", title: "a", status: "todo" })).toBe(
      "queued",
    );
    expect(
      normalizeStoryStage({ id: "a", title: "a", status: "in_progress" }),
    ).toBe("in_progress");
    expect(
      normalizeStoryStage({ id: "a", title: "a", status: "in-progress" }),
    ).toBe("in_progress");
    expect(normalizeStoryStage({ id: "a", title: "a", status: "review" })).toBe(
      "review",
    );
    expect(
      normalizeStoryStage({ id: "a", title: "a", status: "waiting" }),
    ).toBe("review");
    expect(normalizeStoryStage({ id: "a", title: "a", status: "doing" })).toBe(
      "in_progress",
    );
    expect(
      normalizeStoryStage({ id: "a", title: "a", status: "in_review" }),
    ).toBe("review");
    expect(normalizeStoryStage({ id: "a", title: "a", status: "done" })).toBe(
      "done",
    );
    expect(
      normalizeStoryStage({
        id: "a",
        title: "a",
        status: "queued",
        passes: true,
      }),
    ).toBe("queued");
    expect(normalizeStoryStage({ id: "a", title: "a", passes: true })).toBe(
      "done",
    );
    expect(normalizeStoryStage({ id: "a", title: "a" })).toBe("queued");
  });

  it("binds genesis channel messages onto the project row and keeps orphans", () => {
    const overlay = overlayFromSnapshot(parseWorkMeshSnapshot(SNAPSHOT));
    const ids = overlay.rows.map((r) => r.channelId);
    expect(ids).toContain("chn_linked");
    expect(ids).toContain("chn_orphan");
    expect(ids).not.toContain("work-mesh-testing");
    expect(overlay.messagesByChannelId["chn_linked"]?.[0]?.body).toBe(
      "probe @Deacon",
    );
    expect(overlay.messagesByChannelId["chn_linked"]?.[0]?.reactions).toEqual([
      { emoji: "🎉", count: 1, reactedByMe: false },
    ]);
    expect(overlay.messagesByChannelId["chn_linked"]?.[0]?.mentions).toEqual([
      {
        participantUid: "agt_deacon",
        participantType: "agent",
        displayName: "Deacon",
      },
    ]);
    expect(
      overlay.boardByChannelId["chn_linked"]?.stories["US-008"],
    ).toBeTruthy();
    expect(overlay.filesByChannelId["chn_linked"]?.[0]?.name).toBe("prd.json");
  });

  it("uses the directory feed for every channel type, not just projects", () => {
    const overlay = overlayFromSnapshot(
      parseWorkMeshSnapshot({
        ...SNAPSHOT,
        directory: [
          {
            channelId: "chn_linked",
            type: "project",
            scope: "project",
            companyUid: "cmp_indigo",
            name: "Project work-mesh-testing",
            lastActivityAt: "2026-08-16T05:00:00.000Z",
            unreadCount: 0,
            memberCount: 1,
          },
          {
            channelId: "chn_dm",
            type: "dm",
            scope: "group",
            name: "",
            subtitle: "Direct message",
            lastActivityAt: "2026-08-16T06:00:00.000Z",
            unreadCount: 1,
            memberCount: 3,
          },
          {
            channelId: "chn_chat",
            type: "chat",
            scope: "company",
            companyUid: "cmp_indigo",
            name: "eng",
            subtitle: "Company channel",
            lastActivityAt: "2026-08-15T12:00:00.000Z",
            unreadCount: 0,
            memberCount: 8,
          },
        ],
      }),
    );
    expect(overlay.rows.map((r) => [r.channelId, r.type])).toEqual([
      ["chn_dm", "dm"],
      ["chn_linked", "project"],
      ["chn_chat", "chat"],
      ["chn_orphan", "chat"],
    ]);
    expect(overlay.rows[0]?.name).toBe("Direct message");
    expect(
      overlay.boardByChannelId["chn_linked"]?.stories["US-008"],
    ).toBeTruthy();
    expect(overlay.boardByChannelId["chn_dm"]).toBeUndefined();
  });

  it("attaches the board by directory projectId when genesis is missing", () => {
    const overlay = overlayFromSnapshot(
      parseWorkMeshSnapshot({
        projects: [
          {
            companyUid: "cmp_indigo",
            projectId: "work-mesh-testing",
            name: "work-mesh-testing",
            stories: [
              { id: "US-008", title: "Story status", status: "in_progress" },
            ],
            repos: [],
          },
        ],
        channels: [{ channelId: "chn_teams", messages: [] }],
        genesis: [],
        directory: [
          {
            channelId: "chn_teams",
            type: "project",
            scope: "project",
            companyUid: "cmp_indigo",
            projectId: "work-mesh-testing",
            name: "teams-agent-channel",
            lastActivityAt: "2026-08-15T12:00:00.000Z",
            unreadCount: 0,
            memberCount: 4,
          },
        ],
      }),
    );
    expect(
      overlay.boardByChannelId["chn_teams"]?.stories["US-008"],
    ).toBeTruthy();
    expect(overlay.filesByChannelId["chn_teams"]).toEqual([]);
  });

  it("uses project created date when there is no chat or status activity", () => {
    const overlay = overlayFromSnapshot(
      parseWorkMeshSnapshot({
        projects: [
          {
            companyUid: "cmp_indigo",
            projectId: "outpost-ec2-migration",
            name: "outpost-ec2-migration",
            stories: [],
            repos: [],
            updatedAt: "2026-08-17T03:11:04.252Z",
            createdAt: "2026-06-05T08:45:00Z",
          },
        ],
        channels: [{ channelId: "chn_empty", messages: [] }],
        genesis: [
          {
            projectId: "outpost-ec2-migration",
            channelId: "chn_empty",
            at: "2026-06-05T08:45:00Z",
          },
        ],
        directory: [
          {
            channelId: "chn_empty",
            type: "project",
            scope: "project",
            companyUid: "cmp_indigo",
            name: "Project outpost-ec2-migration 072de385",
            lastActivityAt: "2026-08-17T03:10:56.885Z",
            unreadCount: 0,
            memberCount: 1,
          },
        ],
      }),
    );
    expect(overlay.rows[0]?.lastActivityAt).toBe("2026-06-05T08:45:00Z");
  });

  it("falls back to genesis createdAt when the view has no createdAt", () => {
    const overlay = overlayFromSnapshot(
      parseWorkMeshSnapshot({
        projects: [
          {
            companyUid: "cmp_indigo",
            projectId: "old-one",
            stories: [],
            repos: [],
            updatedAt: "2026-08-17T03:11:04.252Z",
          },
        ],
        channels: [{ channelId: "chn_old", messages: [] }],
        genesis: [
          {
            projectId: "old-one",
            channelId: "chn_old",
            at: "2026-04-01T12:00:00Z",
          },
        ],
        directory: [
          {
            channelId: "chn_old",
            type: "project",
            scope: "project",
            companyUid: "cmp_indigo",
            name: "Project old-one",
            lastActivityAt: "2026-08-17T03:10:56.885Z",
            unreadCount: 0,
            memberCount: 1,
          },
        ],
      }),
    );
    expect(overlay.rows[0]?.lastActivityAt).toBe("2026-04-01T12:00:00Z");
  });

  it("keeps last message time when a project channel actually has chat", () => {
    const overlay = overlayFromSnapshot(
      parseWorkMeshSnapshot({
        ...SNAPSHOT,
        directory: [
          {
            channelId: "chn_linked",
            type: "project",
            scope: "project",
            companyUid: "cmp_indigo",
            name: "Project work-mesh-testing",
            lastActivityAt: "2026-08-17T03:10:56.885Z",
            unreadCount: 0,
            memberCount: 1,
          },
        ],
      }),
    );
    expect(
      overlay.rows.find((r) => r.channelId === "chn_linked")?.lastActivityAt,
    ).toBe("2026-08-16T01:28:01.538Z");
  });

  it("labels unnamed DMs from message display names, not person uids", () => {
    const overlay = overlayFromSnapshot(
      parseWorkMeshSnapshot({
        projects: [],
        channels: [
          {
            channelId: "chn_dm",
            messages: [
              {
                eventId: "m1",
                fromPersonUid: "prs_01KQ695MZHZBYFMVMPRTGFW34B",
                fromDisplayName: "Corey Epstein",
                createdAt: "2026-06-15T19:26:38.247Z",
              },
            ],
          },
        ],
        genesis: [],
        directory: [
          {
            channelId: "chn_dm",
            type: "dm",
            scope: "group",
            companyUid: null,
            name: "",
            subtitle: "Direct message",
            lastActivityAt: "2026-06-15T19:26:38.247Z",
            unreadCount: 0,
            memberCount: 2,
          },
        ],
      }),
    );
    expect(overlay.rows[0]?.name).toBe("Corey Epstein");
    expect(overlay.rows[0]?.name).not.toMatch(/^prs_/);
  });

  it("drops malformed snapshot pieces instead of throwing", () => {
    const overlay = overlayFromSnapshot(
      parseWorkMeshSnapshot({ projects: [null, 3, {}], channels: "nope" }),
    );
    expect(overlay.rows).toEqual([]);
  });
});
