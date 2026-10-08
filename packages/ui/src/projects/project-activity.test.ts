import { describe, expect, it } from "vitest";
import type { LiveReadResponse } from "@hq/core";
import {
  ACTIVE_PRESENCE_WINDOW_MS,
  projectActivity,
  projectIdMatches,
} from "./project-activity.js";
import { groupProjectsByPortfolioColumn, portfolioColumn, type Project } from "./projects-model.js";
import { sessionRefFromSessionEvent } from "./work-push.js";

const NOW = Date.parse("2026-10-06T19:30:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "in-proj-233",
    title: "hq-profile-attribution-emitter",
    description: "",
    company: "indigo",
    status: "active",
    prdPath: "companies/indigo/projects/hq-profile-attribution-emitter/prd.json",
    storiesTotal: 10,
    storiesComplete: 4,
    ...overrides,
  };
}

function live(
  projectId: string,
  lastTurnAgo: number,
  actorType: "human" | "agent" = "human",
  status = "active",
): LiveReadResponse {
  return {
    contractVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    participants: [
      {
        actorUid: actorType === "agent" ? "agt_1" : "prs_1",
        actorType,
        displayName: actorType === "agent" ? "desktop-dev" : "Corey",
        presence: "online",
        lastSeenAt: iso(lastTurnAgo),
        sessions: [
          {
            sessionId: "s1",
            harness: "claude-code",
            source: "hooks",
            contextStatus: "bound",
            projectId,
            status,
            startedAt: iso(lastTurnAgo + HOUR),
            lastTurnAt: iso(lastTurnAgo),
            turnCount: 3,
          },
        ],
      },
    ],
  };
}

describe("projectIdMatches", () => {
  it("matches the board id and the prd folder slug", () => {
    const p = project();
    expect(projectIdMatches(p, "in-proj-233")).toBe(true);
    expect(projectIdMatches(p, "HQ-Profile-Attribution-Emitter")).toBe(true);
    expect(projectIdMatches(p, "hq-profile")).toBe(false);
    expect(projectIdMatches(p, "")).toBe(false);
  });
});

describe("projectActivity presence", () => {
  it("is active with mesh presence 29 minutes ago", () => {
    const a = projectActivity(project(), { now: NOW, live: live("in-proj-233", 29 * MIN) });
    expect(a?.kind).toBe("presence");
    expect(a?.label).toBe("active · Corey, 29 min ago");
  });

  it("is quiet with mesh presence 31 minutes ago", () => {
    expect(projectActivity(project(), { now: NOW, live: live("in-proj-233", 31 * MIN) })).toBeNull();
  });

  it("honours a configured presence window", () => {
    const a = projectActivity(project(), {
      now: NOW,
      live: live("in-proj-233", 40 * MIN),
      presenceWindowMs: 45 * MIN,
    });
    expect(a?.kind).toBe("presence");
    expect(ACTIVE_PRESENCE_WINDOW_MS).toBe(30 * MIN);
  });

  it("resolves a session keyed by the folder slug", () => {
    const a = projectActivity(project(), {
      now: NOW,
      live: live("hq-profile-attribution-emitter", 4 * MIN),
    });
    expect(a?.label).toBe("active · Corey, 4 min ago");
  });

  it("labels agent sessions as lanes", () => {
    const a = projectActivity(project(), { now: NOW, live: live("in-proj-233", 2 * MIN, "agent") });
    expect(a).toMatchObject({ kind: "lane", label: "active · lane desktop-dev" });
  });

  it("never shows a raw presence id; resolves it to a name or '1 live session'", () => {
    const raw = live("in-proj-233", 4 * MIN);
    raw.participants[0].displayName = "prs_01KQ2TZQMA8078CHPDWBAFPN0Z";
    raw.participants[0].actorUid = "prs_01KQ2TZQMA8078CHPDWBAFPN0Z";
    const unnamed = projectActivity(project(), { now: NOW, live: raw });
    expect(unnamed?.label).toBe("active · 1 live session, 4 min ago");
    expect(unnamed?.label).not.toContain("prs_");

    const named = projectActivity(project(), {
      now: NOW,
      live: raw,
      nameFor: (uid) => (uid === "prs_01KQ2TZQMA8078CHPDWBAFPN0Z" ? "Corey Epstein" : null),
    });
    expect(named?.label).toBe("active · Corey Epstein, 4 min ago");
  });

  it("ignores ended sessions", () => {
    expect(
      projectActivity(project(), { now: NOW, live: live("in-proj-233", 2 * MIN, "human", "ended") }),
    ).toBeNull();
  });

  it("counts a work-mesh push keyed by project with a story id", () => {
    const marker = sessionRefFromSessionEvent(
      {
        kind: "session-event",
        projectId: "in-proj-233",
        storyId: "US-004",
        event: "turnStart",
        chatId: "c1",
        companyUid: "cmp_1",
        agent: "desktop-dev",
      },
      iso(MIN),
    );
    expect(marker.project).toBe("in-proj-233");
    const a = projectActivity(project(), { now: NOW, sessions: [marker] });
    expect(a).toMatchObject({ kind: "lane", label: "active · lane desktop-dev" });
  });
});

describe("projectActivity recent work", () => {
  it("prd change 23h ago is active, 25h ago is not", () => {
    expect(
      projectActivity(project({ prdModifiedAt: iso(23 * HOUR) }), { now: NOW })?.label,
    ).toBe("stories updated 23h ago");
    expect(projectActivity(project({ prdModifiedAt: iso(25 * HOUR) }), { now: NOW })).toBeNull();
  });

  it("story moved to review 23h ago is active, 25h ago is not", () => {
    const moved = (ago: number) => ({
      now: NOW,
      storyMoves: [{ projectId: "in-proj-233", status: "review", at: iso(ago) }],
    });
    expect(projectActivity(project(), moved(23 * HOUR))?.kind).toBe("story");
    expect(projectActivity(project(), moved(25 * HOUR))).toBeNull();
  });

  it("story moved to done does not count", () => {
    expect(
      projectActivity(project(), {
        now: NOW,
        storyMoves: [{ projectId: "in-proj-233", status: "done", at: iso(HOUR) }],
      }),
    ).toBeNull();
  });

  it("commit 3h ago is active, 25h ago is not", () => {
    const commit = (ago: number) => ({
      now: NOW,
      commits: [{ projectId: "hq-profile-attribution-emitter", at: iso(ago) }],
    });
    expect(projectActivity(project(), commit(3 * HOUR))?.label).toBe("last commit 3h ago");
    expect(projectActivity(project(), commit(25 * HOUR))).toBeNull();
  });

  it("live presence outranks a fresher prd write", () => {
    const a = projectActivity(project({ prdModifiedAt: iso(MIN) }), {
      now: NOW,
      live: live("in-proj-233", 10 * MIN),
    });
    expect(a?.kind).toBe("presence");
  });
});

describe("portfolio placement", () => {
  it("lands in Active on mesh presence alone, with no story change", () => {
    const p = project({ prdModifiedAt: iso(10 * 24 * HOUR) });
    const activity = projectActivity(p, { now: NOW, live: live("in-proj-233", 5 * MIN) });
    expect(portfolioColumn(p, activity !== null)).toBe("active");
    const groups = groupProjectsByPortfolioColumn([p], [], (proj) =>
      portfolioColumn(proj, projectActivity(proj, { now: NOW, live: live("in-proj-233", 5 * MIN) }) !== null),
    );
    expect(groups.active).toHaveLength(1);
  });

  it("started project with no recent activity stays In progress", () => {
    const p = project({ prdModifiedAt: iso(3 * 24 * HOUR) });
    expect(portfolioColumn(p, projectActivity(p, { now: NOW }) !== null)).toBe("in-progress");
  });

  it("complete project stays Complete even with activity", () => {
    const p = project({ storiesComplete: 10, prdModifiedAt: iso(MIN) });
    expect(portfolioColumn(p, projectActivity(p, { now: NOW }) !== null)).toBe("complete");
  });
});
