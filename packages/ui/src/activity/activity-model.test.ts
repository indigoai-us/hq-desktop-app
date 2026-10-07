import { describe, expect, it, vi } from "vitest";
import {
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
