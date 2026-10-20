// Company levels (usage-only-pricing US-019): the level math, the once-only
// record and its storage.

import { describe, expect, it } from "vitest";
import {
  EMPTY_LEVEL_RECORD,
  MAX_LEVEL,
  USAGE_LEVELS,
  countsFromLines,
  levelForCents,
  levelLabel,
  levelProgress,
  levelStorageKey,
  levelThresholdText,
  loadLevelRecord,
  monthOf,
  nextLevel,
  nextLevelLine,
  observeMonth,
  saveLevelRecord,
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
    expect(new Set(USAGE_LEVELS.map((l) => l.name)).size).toBe(7);
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
    expect(levelLabel(4)).toBe("Level 4 · Momentum");
    expect(levelLabel(0)).toBe("No level yet");
    expect(nextLevel(4)?.name).toBe("Powerhouse");
    expect(nextLevel(7)).toBeNull();
    expect(nextLevelLine(4)).toBe("Next: Level 5 Powerhouse at a $1k month");
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

describe("observeMonth: highest month ever, once-only cards", () => {
  it("unlocks and announces the level a month reaches", () => {
    const { record, announce } = observeMonth(null, { month: "2026-10", cents: 6_000 });
    expect(record).toEqual({ bestCents: 6_000, bestMonth: "2026-10", level: 2, announced: 2 });
    expect(announce).toBe(2);
  });

  it("announces only the highest of several levels passed at once", () => {
    const { record, announce } = observeMonth(null, { month: "2026-10", cents: 60_000 });
    expect(announce).toBe(4);
    expect(record.announced).toBe(4);
  });

  it("does not announce again on the same level", () => {
    const first = observeMonth(null, { month: "2026-10", cents: 6_000 });
    const again = observeMonth(first.record, { month: "2026-10", cents: 7_000 });
    expect(again.announce).toBeNull();
    expect(again.record.bestCents).toBe(7_000);
  });

  it("keeps the level when a new month starts lower", () => {
    const october = observeMonth(null, { month: "2026-10", cents: 120_000 });
    const november = observeMonth(october.record, { month: "2026-11", cents: 300 });
    expect(november.record).toEqual({ bestCents: 120_000, bestMonth: "2026-10", level: 5, announced: 5 });
    expect(november.announce).toBeNull();
  });

  it("announces the next level when a later month beats the best", () => {
    const october = observeMonth(null, { month: "2026-10", cents: 120_000 });
    const december = observeMonth(october.record, { month: "2026-12", cents: 510_000 });
    expect(december.announce).toBe(6);
    expect(december.record.bestMonth).toBe("2026-12");
  });

  it("never lowers a stored level, even if the stored best is lower", () => {
    const { record, announce } = observeMonth({ bestCents: 0, bestMonth: null, level: 3, announced: 3 }, { month: "2026-10", cents: 2_000 });
    expect(record.level).toBe(3);
    expect(announce).toBeNull();
  });

  it("has nothing to announce below $10", () => {
    expect(observeMonth(EMPTY_LEVEL_RECORD, { month: "2026-10", cents: 999 }).announce).toBeNull();
  });
});

describe("level storage", () => {
  it("round-trips a record per person and account", () => {
    const s = memory();
    const rec = { bestCents: 60_000, bestMonth: "2026-10", level: 4, announced: 4 };
    expect(saveLevelRecord(s, "prs_a", "cmp_1", rec)).toBe(true);
    expect(loadLevelRecord(s, "prs_a", "cmp_1")).toEqual(rec);
    expect(loadLevelRecord(s, "prs_b", "cmp_1")).toBeNull();
    expect(loadLevelRecord(s, "prs_a", "personal")).toBeNull();
    expect([...s.data.keys()]).toEqual([levelStorageKey("prs_a", "cmp_1")]);
    expect(levelStorageKey("prs_a", "cmp_1")).toBe("hq.usage.levels.v1.prs_a.cmp_1");
  });

  it("ignores unreadable records and clamps levels", () => {
    const s = memory();
    s.data.set(levelStorageKey("prs_a", "x"), "{not json");
    expect(loadLevelRecord(s, "prs_a", "x")).toBeNull();
    s.data.set(levelStorageKey("prs_a", "y"), JSON.stringify({ bestCents: -1, level: 2, announced: 2 }));
    expect(loadLevelRecord(s, "prs_a", "y")).toBeNull();
    s.data.set(levelStorageKey("prs_a", "z"), JSON.stringify({ bestCents: 5, level: 99, announced: 99 }));
    expect(loadLevelRecord(s, "prs_a", "z")?.level).toBe(7);
  });

  it("reports a refused write and survives no storage", () => {
    const refusing: LevelStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(saveLevelRecord(refusing, "prs_a", "c", EMPTY_LEVEL_RECORD)).toBe(false);
    expect(saveLevelRecord(null, "prs_a", "c", EMPTY_LEVEL_RECORD)).toBe(false);
    expect(loadLevelRecord(null, "prs_a", "c")).toBeNull();
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
