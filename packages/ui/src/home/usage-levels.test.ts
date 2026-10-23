// Company levels (usage-only-pricing US-019): the level math, the server
// history read, and the once-only card record and its storage.

import { describe, expect, it } from "vitest";
import {
  MAX_LEVEL,
  USAGE_LEVELS,
  bestOfMonths,
  countsFromLines,
  levelForCents,
  levelLabel,
  levelProgress,
  levelStorageKey,
  levelThresholdText,
  loadCardRecord,
  monthOf,
  nextLevel,
  nextLevelLine,
  readUsageHistory,
  saveCardRecord,
  teamDoneLine,
  type LevelStorage,
} from "./usage-levels";

function memory(): LevelStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("levels", () => {
  it("has seven levels at the owner's thresholds, each with a short name", () => {
    expect(USAGE_LEVELS.map((l) => l.cents)).toEqual([1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000]);
    expect(USAGE_LEVELS.map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Owner pick, Corey, 2026-10-20 ("Build theme").
    expect(USAGE_LEVELS.map((l) => l.name)).toEqual(["Sketch", "Prototype", "Launch", "Scale", "Engine", "Flagship", "Landmark"]);
    for (const l of USAGE_LEVELS) expect(l.name).not.toMatch(/—/);
    expect(MAX_LEVEL).toBe(7);
  });

  it("reaches a level at its threshold, not a cent before", () => {
    expect(levelForCents(0)).toBe(0);
    expect(levelForCents(999)).toBe(0);
    expect(levelForCents(1_000)).toBe(1);
    expect(levelForCents(4_999)).toBe(1);
    expect(levelForCents(5_000)).toBe(2);
    expect(levelForCents(10_000)).toBe(3);
    expect(levelForCents(49_999)).toBe(3);
    expect(levelForCents(50_000)).toBe(4);
    expect(levelForCents(100_000)).toBe(5);
    expect(levelForCents(500_000)).toBe(6);
    expect(levelForCents(999_999)).toBe(6);
    expect(levelForCents(1_000_000)).toBe(7);
    expect(levelForCents(25_000_000)).toBe(7);
  });

  it("treats missing or broken totals as no level", () => {
    expect(levelForCents(null)).toBe(0);
    expect(levelForCents(undefined)).toBe(0);
    expect(levelForCents(Number.NaN)).toBe(0);
  });

  it("names the level, the next one and the thresholds plainly", () => {
    expect(levelLabel(4)).toBe("Level 4 · Scale");
    expect(levelLabel(0)).toBe("No level yet");
    expect(nextLevel(4)?.name).toBe("Engine");
    expect(nextLevel(7)).toBeNull();
    expect(nextLevelLine(4)).toBe("Next: Level 5 Engine at a $1k month");
    expect(nextLevelLine(7)).toBe("Top level reached");
    expect(levelThresholdText(1_000)).toBe("$10");
    expect(levelThresholdText(50_000)).toBe("$500");
    expect(levelThresholdText(100_000)).toBe("$1k");
    expect(levelThresholdText(1_000_000)).toBe("$10k");
  });

  it("measures progress from the current level's threshold to the next", () => {
    expect(levelProgress(0, 0)).toBe(0);
    expect(levelProgress(500, 0)).toBe(0.5);
    expect(levelProgress(50_000, 4)).toBe(0);
    expect(levelProgress(75_000, 4)).toBe(0.5);
    expect(levelProgress(2_000_000, 7)).toBe(1);
  });

  it("reads the month from a statement period", () => {
    expect(monthOf("2026-10-01")).toBe("2026-10");
    expect(monthOf("2026-11-01T00:00:00Z")).toBe("2026-11");
    expect(monthOf("")).toBeNull();
    expect(monthOf(null)).toBeNull();
  });
});

describe("card record storage", () => {
  it("round-trips the shown level per person and account, and stores nothing about spend", () => {
    const s = memory();
    expect(saveCardRecord(s, "prs_a", "cmp_1", { announced: 4 })).toBe(true);
    expect(loadCardRecord(s, "prs_a", "cmp_1")).toEqual({ announced: 4 });
    expect(loadCardRecord(s, "prs_b", "cmp_1")).toBeNull();
    expect(loadCardRecord(s, "prs_a", "personal")).toBeNull();
    expect([...s.data.keys()]).toEqual([levelStorageKey("prs_a", "cmp_1")]);
    expect(levelStorageKey("prs_a", "cmp_1")).toBe("hq.usage.levels.v1.prs_a.cmp_1");
    expect(JSON.parse(s.data.get(levelStorageKey("prs_a", "cmp_1")) ?? "")).toEqual({ announced: 4 });
  });

  it("reads only the shown level from a record an earlier build wrote", () => {
    const s = memory();
    s.data.set(levelStorageKey("prs_a", "old"), JSON.stringify({ bestCents: 61_000, bestMonth: "2026-09", level: 4, announced: 4 }));
    expect(loadCardRecord(s, "prs_a", "old")).toEqual({ announced: 4 });
  });

  it("ignores unreadable records and clamps levels", () => {
    const s = memory();
    s.data.set(levelStorageKey("prs_a", "x"), "{not json");
    expect(loadCardRecord(s, "prs_a", "x")).toBeNull();
    s.data.set(levelStorageKey("prs_a", "y"), JSON.stringify({ announced: -2 }));
    expect(loadCardRecord(s, "prs_a", "y")).toBeNull();
    s.data.set(levelStorageKey("prs_a", "n"), "null");
    expect(loadCardRecord(s, "prs_a", "n")).toBeNull();
    s.data.set(levelStorageKey("prs_a", "z"), JSON.stringify({ announced: 99 }));
    expect(loadCardRecord(s, "prs_a", "z")?.announced).toBe(7);
  });

  it("reports a refused write and survives no storage", () => {
    const refusing: LevelStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(saveCardRecord(refusing, "prs_a", "c", { announced: 1 })).toBe(false);
    expect(saveCardRecord(null, "prs_a", "c", { announced: 1 })).toBe(false);
    expect(loadCardRecord(null, "prs_a", "c")).toBeNull();
  });
});

describe("what the team got done", () => {
  it("names up to three meters with counts, in order", () => {
    expect(teamDoneLine({ "agent-run": 1240, "member-sync": 3100, "hq-mcp-call": 820, "integration-call": 40 })).toBe(
      "1,240 agent runs, 3,100 syncs and 820 HQ MCP calls",
    );
    expect(teamDoneLine({ "member-sync": 1 })).toBe("1 sync");
    expect(teamDoneLine({ "agent-run": 0, "integration-call": 12 })).toBe("12 app calls");
    expect(teamDoneLine({})).toBe("");
    expect(teamDoneLine(null)).toBe("");
  });

  it("reads counts from billed statement lines only", () => {
    expect(
      countsFromLines([
        { key: "agent-run", billed: true, usage: 12 },
        { key: "member-sync", billed: false, usage: 99 },
        { key: "storage", usage: null },
        "junk",
      ]),
    ).toEqual({ "agent-run": 12 });
  });
});

describe("usage history (GET /v1/billing/usage/history)", () => {
  it("reads every month with a readable figure, and marks the closed ones", () => {
    expect(
      readUsageHistory({
        months: [
          { month: "2026-08", usageCents: 0, complete: false },
          { month: "2026-09", usageCents: 61_000, complete: true },
          { month: "2026-10", usageCents: 2_000, complete: false },
          { month: "2026-07", usageCents: -5, complete: true },
          { month: "2026-7", usageCents: 100, complete: true },
          { month: "2026-06", usageCents: "100", complete: true },
          null,
        ],
      }),
    ).toEqual({
      months: [
        { month: "2026-08", cents: 0 },
        { month: "2026-09", cents: 61_000 },
        { month: "2026-10", cents: 2_000 },
      ],
      closed: [{ month: "2026-09", cents: 61_000 }],
    });
  });

  it("treats a body that is not a history as a failed read", () => {
    expect(readUsageHistory(null)).toBeNull();
    expect(readUsageHistory("nope")).toBeNull();
    expect(readUsageHistory({ months: "nope" })).toBeNull();
    expect(readUsageHistory({})).toBeNull();
    expect(readUsageHistory({ months: [] })).toEqual({ months: [], closed: [] });
  });

  it("picks the month with the most usage across the returned months", () => {
    expect(
      bestOfMonths([
        { month: "2026-08", cents: 6_000 },
        { month: "2026-09", cents: 61_000 },
        { month: "2026-10", cents: 2_000 },
      ]),
    ).toEqual({ month: "2026-09", cents: 61_000 });
    // A tie keeps the earlier month; empty, zero and missing months have no best.
    expect(bestOfMonths([{ month: "2026-09", cents: 500 }, { month: "2026-10", cents: 500 }])?.month).toBe("2026-09");
    expect(bestOfMonths([{ month: "2026-09", cents: 0 }, null, undefined])).toBeNull();
    expect(bestOfMonths([])).toBeNull();
    expect(levelForCents(bestOfMonths([{ month: "2026-09", cents: 1_000_000 }])?.cents)).toBe(7);
  });
});
