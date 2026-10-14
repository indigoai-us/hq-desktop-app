import { describe, expect, it, vi } from "vitest";
import {
  activityFromCompanyTelemetry,
  activityBars,
  activityToCsv,
  lastActiveDaysAgo,
  lastActiveLabel,
  metadata,
  saveCsvViaDialog,
  sortMembers,
  type ActivityMember,
  type ActivitySnapshot,
} from "./activity-model.js";

describe("team list order and bars", () => {
  const member = (id: string, name: string, trend: number[], sessions = 1): ActivityMember => ({
    id,
    name,
    mark: name.slice(0, 2).toUpperCase(),
    bot: false,
    live: false,
    tokens: 0,
    sessions,
    stories: 0,
    deploys: 0,
    topSkill: "",
    outcomesPerMillion: null,
    spendUsd: null,
    trend,
  });
  const ada = member("a", "Ada", [5, 0, 0, 0]); // last active 3 days ago
  const bo = member("b", "bo", [0, 0, 0, 9]); // today
  const cy = member("c", "Cy", [0, 0, 4, 0], 2); // yesterday
  const dee = member("d", "Dee", [0, 0, 4, 0], 5); // yesterday, more sessions
  const old = member("e", "Eve", []); // no trend cached

  it("reads the last active day from the trend", () => {
    expect(lastActiveDaysAgo([5, 0, 0, 0])).toBe(3);
    expect(lastActiveDaysAgo([0, 0, 0, 9])).toBe(0);
    expect(lastActiveDaysAgo([0, 0])).toBeNull();
    expect(lastActiveDaysAgo(undefined)).toBeNull();
    expect(lastActiveLabel(0)).toBe("Today");
    expect(lastActiveLabel(1)).toBe("Yesterday");
    expect(lastActiveLabel(6)).toBe("6d ago");
    expect(lastActiveLabel(6, true)).toBe("Live now");
    expect(lastActiveLabel(null)).toBeNull();
  });

  it("sorts by recent activity: live first, then last active day, then sessions", () => {
    const ids = (rows: ActivityMember[]) => rows.map((m) => m.id);
    expect(ids(sortMembers([ada, old, cy, bo, dee], "recent"))).toEqual(["b", "d", "c", "a", "e"]);
    expect(ids(sortMembers([ada, old, cy, bo, dee], "recent", new Set(["a"])))).toEqual(["a", "b", "d", "c", "e"]);
  });

  it("sorts by name without regard to case", () => {
    expect(sortMembers([cy, bo, ada], "name").map((m) => m.name)).toEqual(["Ada", "bo", "Cy"]);
  });

  it("draws one bar per day in the range, idle days flat", () => {
    expect(activityBars([0, 10, 100], 5)).toEqual([0, 0, 0, 12, 100]);
    expect(activityBars(undefined, 3)).toEqual([0, 0, 0]);
    expect(activityBars([1, 2, 3, 4], 2)).toEqual([75, 100]);
  });
});

describe("activity export", () => {
  const snapshot: ActivitySnapshot = {
    members: [
      {
        id: "a",
        name: "Ada",
        mark: "AD",
        bot: false,
        live: false,
        tokens: 1200,
        sessions: 2,
        stories: 1,
        deploys: 0,
        topSkill: "/review",
        outcomesPerMillion: 1.2,
        spendUsd: 3,
      },
    ],
    updatedLabel: "",
  };

  it("writes a csv header and the member row", () => {
    const csv = activityToCsv(snapshot, "30d");
    expect(csv.split("\n")[0]).toContain("tokens");
    expect(csv).toContain("Ada");
    expect(csv).toContain("30d");
  });

  it("saves through the OS save dialog", async () => {
    const write = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => ({ write, close }),
    }));
    const result = await saveCsvViaDialog("activity.csv", "a,b", {
      showSaveFilePicker,
    } as unknown as typeof globalThis);
    expect(result).toBe("saved");
    expect(showSaveFilePicker).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("a,b");
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats a dismissed dialog as cancelled", async () => {
    const showSaveFilePicker = vi.fn(async () => {
      throw new DOMException("nope", "AbortError");
    });
    const result = await saveCsvViaDialog("activity.csv", "a", {
      showSaveFilePicker,
    } as unknown as typeof globalThis);
    expect(result).toBe("cancelled");
  });
});

describe("activity scroll budget", () => {
  it("keeps dropped frames inside one percent", () => {
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBeLessThanOrEqual(0.01);
    expect(metadata.performanceBudget.worstFrameMs).toBeLessThanOrEqual(33);
  });
});

describe("activity from company telemetry", () => {
  // Shape hq-pro GET /v1/telemetry/company returns in production (2026-10-05):
  // a flat `members` list with token maps, `team.daily`, and `identities`.
  // The page used to require `perMember` and showed "Could not load activity."
  const production = {
    companyUid: "cmp_test",
    from: "2026-09-06",
    to: "2026-10-05",
    team: {
      daily: [
        { date: "2026-10-05", tokensByModel: { "claude-opus-5-5": { inputTokens: 5, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } } },
        { date: "2026-10-04", tokensByModel: { "claude-opus-5-5": { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } } },
      ],
      totals: {},
    },
    coverage: { attributed: 3, unattributed: 1, ratio: 0.75 },
    members: [
      {
        personUid: "prs_ada",
        skills: { deploy: 2, handoff: 7 },
        tokensByModel: {
          "claude-opus-5-5": { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 400 },
          unknown: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        },
        outcomes: { byType: { prMerged: 1, storyCompleted: 2, deploySucceeded: 3 }, total: 6 },
        efficiency: 2,
        services: { github: 4 },
        events: 50,
        distinctSessions: 3,
        trend: [0, 10, 20],
      },
      { personUid: "agt_idle", skills: {}, tokensByModel: {}, events: 0, distinctSessions: 0 },
    ],
    identities: {
      persons: { prs_ada: { uid: "prs_ada", name: "Ada Lovelace", email: "ada@example.com" } },
      agents: {},
    },
  };

  it("reads the production members shape instead of failing", () => {
    const snap = activityFromCompanyTelemetry(production);
    expect(snap.members).toHaveLength(1);
    const ada = snap.members[0];
    expect(ada.name).toBe("Ada Lovelace");
    expect(ada.email).toBe("ada@example.com");
    expect(ada.tokens).toBe(1000);
    expect(ada.sessions).toBe(3);
    expect(ada.topSkill).toBe("handoff");
    expect(ada.stories).toBe(2);
    expect(ada.deploys).toBe(3);
    expect(ada.tokensByModel).toEqual([{ model: "claude-opus-5-5", total: 1000 }]);
    expect(ada.services).toEqual([{ service: "github", count: 4 }]);
    expect(ada.trend).toEqual([0, 10, 20]);
  });

  it("still reads the legacy perMember shape", () => {
    const snap = activityFromCompanyTelemetry({
      perMember: [
        {
          personUid: "prs_bo",
          label: "Bo",
          totals: {
            tokensByModel: [{ model: "m", input: 1, output: 2, cacheCreation: 3, cacheRead: 4 }],
            skills: { bySkill: [{ skill: "plan", count: 1 }] },
            distinctSessions: 1,
            events: 1,
          },
        },
      ],
    });
    expect(snap.members[0]).toMatchObject({ name: "Bo", tokens: 10, topSkill: "plan" });
  });

  it("fails a body with no member list", () => {
    expect(() => activityFromCompanyTelemetry({ team: {} })).toThrow(/no members list/);
  });
});
