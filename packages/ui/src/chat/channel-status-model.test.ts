import { describe, expect, it } from "vitest";
import {
  buildActiveSessionRows,
  buildChannelStatusModel,
  buildLiveReadSessionRows,
  computeStoryRollup,
  extractStoryId,
  firstOpenStoryId,
  formatLastActivity,
  liveAgentRowFromSession,
  presenceOnlineFor,
  projectAboutBody,
  projectChannelHeaderParts,
  projectChannelHeaderTitle,
  groupProjectRepos,
  projectReposForDisplay,
  resolveMemberPillCount,
  resolvePreviewUrl,
  resolveProjectRepos,
  resolveRepoPath,
  type ServerWorkSessionInput,
} from "./channel-status-model";

describe("channel-status-model (US-005 status popover)", () => {
  it("extracts US-xxx story ids from free text (not used for cwd matching)", () => {
    expect(extractStoryId("working on US-003 now")).toBe("US-003");
    expect(extractStoryId("US_012")).toBe("US-012");
    expect(extractStoryId("no story here")).toBeNull();
  });

  it("computes story rollup from prd passes", () => {
    const rollup = computeStoryRollup(
      { id: "p", storiesTotal: 99, storiesComplete: 1 },
      {
        userStories: [
          { id: "US-001", passes: true },
          { id: "US-002", passes: true },
          { id: "US-003", passes: false },
          { id: "US-004", passes: false },
        ],
      },
    );
    expect(rollup).toEqual({
      complete: 2,
      total: 4,
      label: "stories 2/4",
      percent: 50,
    });
  });

  it("falls back to project story counts when prd has no stories", () => {
    const rollup = computeStoryRollup(
      { id: "p", storiesTotal: 10, storiesComplete: 3 },
      null,
    );
    expect(rollup.label).toBe("stories 3/10");
    expect(rollup.percent).toBe(30);
  });

  it("resolves repo path and preview url from prd + metadata", () => {
    expect(
      resolveRepoPath({
        prdPath: "companies/indigo/projects/flagship/prd.json",
      }),
    ).toBe("companies/indigo/projects/flagship");
    expect(
      resolveRepoPath({
        repoPath: "/Users/corey/repo",
        prdPath: "companies/x/projects/y/prd.json",
      }),
    ).toBe("/Users/corey/repo");
    expect(
      resolvePreviewUrl({
        metadata: { previewUrl: "https://preview.example/app" },
      }),
    ).toBe("https://preview.example/app");
    expect(resolvePreviewUrl({ metadata: {} })).toBeNull();
  });

  it("builds live agent row label with explicit story + progress (never from cwd)", () => {
    const rollup = { complete: 2, total: 5, label: "stories 2/5", percent: 40 };
    const row = liveAgentRowFromSession(
      {
        project: "hq-desktop-app",
        company: "indigo",
        cwd: "/work/US-005/src",
        status: "running",
        tool: "claude",
        model: "opus",
        storyId: "US-005",
        serverSessionId: "sess_bound",
      },
      rollup,
      "US-001",
    );
    expect(row.storyId).toBe("US-005");
    expect(row.progressPercent).toBe(40);
    expect(row.label).toBe("Agent running · US-005 · 40%");
    // cwd US-005 must not win when storyId is absent — fall back to open story.
    const fromCwdOnly = liveAgentRowFromSession(
      {
        project: "hq-desktop-app",
        company: "indigo",
        cwd: "/work/US-005/src",
        status: "running",
        tool: "claude",
        serverSessionId: "sess_bound",
      },
      rollup,
      "US-001",
    );
    expect(fromCwdOnly.storyId).toBe("US-001");
  });

  it("picks first open story id from prd", () => {
    expect(
      firstOpenStoryId({
        userStories: [
          { id: "US-001", passes: true },
          { id: "US-002", passes: false },
        ],
      }),
    ).toBe("US-002");
  });

  it("builds full status model with project block + members + agents", () => {
    const model = buildChannelStatusModel({
      project: {
        id: "hq-desktop-app",
        title: "HQ Desktop",
        name: "HQ Desktop",
        company: "indigo",
        prdPath: "companies/indigo/projects/hq-desktop-app/prd.json",
        storiesTotal: 4,
        storiesComplete: 1,
      },
      companyLabel: "Indigo",
      prd: {
        branchName: "feature/hq-desktop-v2-chat",
        prdPath: "companies/indigo/projects/hq-desktop-app/prd.json",
        metadata: { previewUrl: "https://preview.example/hq" },
        userStories: [
          { id: "US-001", passes: true },
          { id: "US-002", passes: false },
          { id: "US-003", passes: false },
          { id: "US-004", passes: false },
        ],
      },
      // Unbound local session must be ignored (US-015 — no cwd matching).
      sessions: [
        {
          project: "hq-desktop-app",
          company: "indigo",
          cwd: "/Users/x/hq-desktop-app",
          status: "running",
          tool: "claude",
          model: "opus",
          startedAt: "2026-08-11T10:00:00Z",
        },
      ],
      liveSessions: [
        {
          sessionId: "sess_fleet",
          actorUid: "agent:fleet-1",
          actorType: "agent",
          displayName: "Fleet Bot",
          harness: "agent-box",
          taskId: "US-002",
          status: "active",
          turnCount: 3,
          lastTurnAt: "2026-08-11T10:00:00Z",
        },
      ],
      presence: [
        { actorUid: "prs_human", status: "online", actorType: "human" },
        { actorUid: "agent:fleet-1", status: "online", actorType: "agent" },
      ],
      members: [
        {
          personUid: "prs_human",
          displayName: "Corey",
          role: "owner",
        },
        {
          personUid: "agent:fleet-1",
          displayName: "Fleet Bot",
          role: "agent",
          isAgent: true,
        },
      ],
    });

    expect(model.stories.label).toBe("stories 1/4");
    expect(model.project.branch).toBe("feature/hq-desktop-v2-chat");
    expect(model.project.repo).toBe("companies/indigo/projects/hq-desktop-app");
    expect(model.project.repos).toEqual([
      {
        path: "companies/indigo/projects/hq-desktop-app",
        branch: "feature/hq-desktop-v2-chat",
      },
    ]);
    expect(model.project.previewUrl).toBe("https://preview.example/hq");
    expect(model.liveAgents.length).toBe(1);
    expect(model.liveAgents[0]?.label).toMatch(
      /^Agent running · US-002 · 25%$/,
    );
    expect(model.activeSessions).toHaveLength(1);
    expect(model.activeSessions[0]?.taskId).toBe("US-002");
    expect(model.activeSessions[0]?.online).toBe(true);
    expect(model.members.map((m) => m.displayName)).toEqual(["Corey"]);
    expect(model.members[0]?.online).toBe(true);
    expect(model.agents.some((a) => a.displayName === "Fleet Bot")).toBe(true);
    expect(model.agents.some((a) => a.statusIcon === "running")).toBe(true);
    expect(model.memberCount).toBe(2);
    expect(model.companyLabel).toBe("Indigo");
  });

  it("shows bound local sessions only when serverSessionId is set", () => {
    const unbound = buildChannelStatusModel({
      project: { id: "p", title: "P" },
      sessions: [
        {
          project: "p",
          company: "c",
          cwd: "/tmp/p",
          status: "running",
          tool: "claude",
        },
      ],
    });
    expect(unbound.liveAgents).toEqual([]);

    const bound = buildChannelStatusModel({
      project: { id: "p", title: "P" },
      sessions: [
        {
          project: "p",
          company: "c",
          cwd: "/tmp/p",
          status: "running",
          tool: "claude",
          serverSessionId: "sess_1",
          storyId: "US-009",
        },
      ],
    });
    expect(bound.liveAgents).toHaveLength(1);
    expect(bound.liveAgents[0]?.storyId).toBe("US-009");
  });

  it("formats project channel header title", () => {
    expect(projectChannelHeaderTitle("hq-desktop", "Indigo")).toBe(
      "# hq-desktop · Indigo · project channel",
    );
    expect(projectChannelHeaderTitle("#launch", null)).toBe(
      "# launch · Company · project channel",
    );
    expect(projectChannelHeaderParts("hq-desktop", "Indigo")).toEqual({
      title: "# hq-desktop",
      subtitle: "Indigo · project channel",
    });
  });

  it("passes the project description through the status model", () => {
    const model = buildChannelStatusModel({
      project: {
        id: "work-mesh-testing",
        title: "work-mesh-testing",
        description: "Live board for HQ Work mesh.",
      },
    });
    expect(model.project.description).toBe("Live board for HQ Work mesh.");
    expect(projectAboutBody(model.project.description)).toBe(
      "Live board for HQ Work mesh.",
    );
    expect(projectAboutBody("  ")).toBe("No description for this project.");
  });

  it("hides preview when no deploy url exists", () => {
    const model = buildChannelStatusModel({
      project: { id: "p", title: "P", company: "c" },
      prd: { branchName: "main", userStories: [] },
    });
    expect(model.project.previewUrl).toBeNull();
    expect(model.project.branch).toBe("main");
  });

  it("keeps multiple repos from the mesh project view", () => {
    const model = buildChannelStatusModel({
      project: { id: "work-mesh-testing", title: "work-mesh-testing" },
      prd: {
        repos: [
          { path: "repos/private/hq-pro", branch: "feature/a" },
          { path: "repos/private/hq-core-staging", branch: "feature/b" },
          { path: "repos/private/hq-pro", branch: "feature/c" },
        ],
      },
    });
    expect(model.project.repos).toHaveLength(3);
    expect(model.project.repo).toBe("repos/private/hq-pro");
    expect(model.project.branch).toBe("feature/a");
    expect(groupProjectRepos(model.project.repos)).toEqual([
      { path: "repos/private/hq-pro", branches: ["feature/a", "feature/c"] },
      { path: "repos/private/hq-core-staging", branches: ["feature/b"] },
    ]);
  });

  it("prefers mesh repos[] over the legacy single pair", () => {
    expect(
      resolveProjectRepos({
        repoPath: "repos/private/legacy",
        branchName: "main",
        repos: [{ path: "repos/private/hq-pro", branch: "feat/x" }],
      }),
    ).toEqual([{ path: "repos/private/hq-pro", branch: "feat/x" }]);
  });

  it("falls display grouping back to the legacy single pair", () => {
    expect(
      projectReposForDisplay({
        repos: [],
        repo: "repos/private/hq-pro",
        branch: "main",
      }),
    ).toEqual([{ path: "repos/private/hq-pro", branches: ["main"] }]);
  });
});

describe("active server sessions in the status popover (US-010)", () => {
  const NOW = Date.parse("2026-08-13T10:00:00.000Z");

  const session = (
    over: Partial<ServerWorkSessionInput> = {},
  ): ServerWorkSessionInput => ({
    sessionId: "sess_1",
    threadId: "thr_1",
    status: "active",
    harness: "claude-code",
    ownerUid: "agt_ralph",
    ownerType: "agent",
    progressSummary: "US-003 implementing popover",
    progressPercent: 60,
    lastActivityAt: "2026-08-13T09:18:00.000Z",
    createdAt: "2026-08-13T08:00:00.000Z",
    ...over,
  });

  it("regression: an active session at 60% shows principal and 60%", () => {
    const model = buildChannelStatusModel({
      project: { id: "proj_abc", title: "Channel Fabric" },
      serverSessions: [session()],
      nowMs: NOW,
    });
    expect(model.activeSessions).toHaveLength(1);
    const row = model.activeSessions[0];
    expect(row.principal).toBe("agt_ralph");
    expect(row.principalKind).toBe("agent");
    expect(row.percent).toBe(60);
    expect(row.context).toBe("US-003");
    expect(row.lastActivityLabel).toBe("last activity 42m ago");
  });

  it("shows no percent when the session never reported progress", () => {
    const rows = buildActiveSessionRows(
      [session({ progressPercent: null, progressSummary: null })],
      NOW,
    );
    expect(rows[0].percent).toBeNull();
    // Falls back to the harness for context when no story id is present.
    expect(rows[0].context).toBe("claude-code");
  });

  it("keeps a quiet never-expired session honest via its last-event timestamp", () => {
    // Sessions never auto-expire server-side — a 3-day-quiet open session
    // must read "last activity 3d ago", not look live.
    const rows = buildActiveSessionRows(
      [session({ lastActivityAt: "2026-08-10T10:00:00.000Z" })],
      NOW,
    );
    expect(rows[0].lastActivityLabel).toBe("last activity 3d ago");
  });

  it("derives human vs agent from ownerType or the uid prefix", () => {
    const rows = buildActiveSessionRows(
      [
        session({ ownerUid: "prs_stefan", ownerType: "human" }),
        session({ sessionId: "sess_2", ownerUid: "agt_izzy", ownerType: null }),
        session({
          sessionId: "sess_3",
          ownerUid: "prs_corey",
          ownerType: null,
        }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.principalKind)).toEqual([
      "human",
      "agent",
      "human",
    ]);
  });

  it("surfaces the blocked reason and clamps out-of-range percent", () => {
    const rows = buildActiveSessionRows(
      [
        session({
          blockedReason: "Waiting on vault grant",
          progressPercent: 240,
        }),
      ],
      NOW,
    );
    expect(rows[0].blockedReason).toBe("Waiting on vault grant");
    expect(rows[0].percent).toBe(100);
  });

  it("is absent-safe: sparse legacy rows still produce a row", () => {
    const rows = buildActiveSessionRows([{ threadId: "thr_legacy" }], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].principal).toBe("Unknown");
    expect(rows[0].percent).toBeNull();
    expect(rows[0].lastActivityLabel).toBe("last activity unknown");
    // No server sessions at all → empty section, never fabricated rows.
    expect(buildActiveSessionRows(undefined, NOW)).toEqual([]);
  });

  it("formats relative last-activity labels across minute/hour/day buckets", () => {
    const at = (iso: string | undefined) => formatLastActivity(iso, NOW);
    expect(at("2026-08-13T09:59:40.000Z")).toBe("last activity just now");
    expect(at("2026-08-13T09:18:00.000Z")).toBe("last activity 42m ago");
    expect(at("2026-08-13T07:00:00.000Z")).toBe("last activity 3h ago");
    expect(at("2026-08-08T10:00:00.000Z")).toBe("last activity 5d ago");
    expect(at(undefined)).toBe("last activity unknown");
    expect(at("not-a-date")).toBe("last activity unknown");
  });
});

describe("presence + live read (US-015)", () => {
  it("never invents online from timestamps — only the presence store", () => {
    expect(presenceOnlineFor(undefined, "prs_a")).toBe(false);
    expect(
      presenceOnlineFor(
        [{ actorUid: "prs_a", status: "offline" }],
        "prs_a",
      ),
    ).toBe(false);
    expect(
      presenceOnlineFor([{ actorUid: "prs_a", status: "online" }], "prs_a"),
    ).toBe(true);
  });

  it("builds active session rows from the live read with harness and turns", () => {
    const rows = buildLiveReadSessionRows(
      [
        {
          sessionId: "sess_1",
          actorUid: "prs_corey",
          actorType: "human",
          displayName: "Corey",
          harness: "claude-code",
          taskId: "US-015",
          turnCount: 4,
          lastTurnAt: "2026-08-13T09:18:00.000Z",
          status: "active",
        },
      ],
      Date.parse("2026-08-13T10:00:00.000Z"),
      [{ actorUid: "prs_corey", status: "online" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      principal: "Corey",
      principalKind: "human",
      harness: "claude-code",
      taskId: "US-015",
      turnCount: 4,
      online: true,
      lastActivityLabel: "last activity 42m ago",
    });
  });
});

describe("resolveMemberPillCount (header pill drift regression)", () => {
  it("adopts the model count after a real roster fetch", () => {
    expect(resolveMemberPillCount(5, { memberCount: 5 }, 6)).toBe(5);
  });

  it("keeps the previous metadata count when the roster fetch was empty (fixture fallback)", () => {
    // Opening + closing the popover with no roster data must NOT drift the
    // pill from the channel-metadata count (6) to the fixture count (5).
    expect(resolveMemberPillCount(0, { memberCount: 5 }, 6)).toBe(6);
  });

  it("stays null when there was never a count and no roster data", () => {
    expect(resolveMemberPillCount(0, { memberCount: 5 }, null)).toBeNull();
  });
});

describe("channel-status-model — member email preservation", () => {
  it("carries member email into the built StatusPersonRow", () => {
    const built = buildChannelStatusModel({
      project: { id: "chn_1", title: "#general" },
      members: [
        {
          personUid: "prs_marcus",
          displayName: "Marcus Chen",
          email: "marcus@example.com",
          role: "member",
        },
        { personUid: "prs_noemail", displayName: "No Email" },
      ],
    });
    const marcus = built.members.find((m) => m.personUid === "prs_marcus");
    const none = built.members.find((m) => m.personUid === "prs_noemail");
    expect(marcus?.email).toBe("marcus@example.com");
    expect(none?.email).toBeNull();
  });
});
