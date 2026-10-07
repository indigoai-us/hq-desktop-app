import { describe, expect, it, vi } from "vitest";
import {
  activityFromCompanyTelemetry,
  activityToCsv,
  dayBars,
  metadata,
  saveCsvViaDialog,
  type ActivitySnapshot,
} from "./activity-model.js";

describe("activity day strip", () => {
  it("draws 30 days and dims weekends when the range is 30d", () => {
    const now = new Date(2026, 9, 1, 12);
    const bars = dayBars("30d", [], now);
    expect(bars).toHaveLength(30);
    expect(bars[bars.length - 1]?.today).toBe(true);
    for (const bar of bars) {
      const date = new Date(`${bar.iso}T12:00:00`);
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      expect(bar.weekend).toBe(weekend);
    }
    expect(bars.some((bar) => bar.weekend)).toBe(true);
    expect(bars.some((bar) => !bar.weekend)).toBe(true);
  });

  it("scales bar height from the cached weights", () => {
    const bars = dayBars("7d", [10, 20, 40, 0, 5, 8, 16], new Date(2026, 9, 1));
    expect(bars).toHaveLength(7);
    expect(Math.max(...bars.map((bar) => bar.heightPct))).toBe(100);
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
    live: [],
    pulse: [],
    dayWeights: [],
    attributedPct: 90,
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
    expect(snap.dayWeights).toEqual([2, 10]);
    expect(snap.attributedPct).toBe(75);
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
