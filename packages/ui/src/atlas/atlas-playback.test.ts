import { describe, expect, it } from "vitest";
import {
  ATLAS_PLAYBACK_TOTAL_MS,
  ATLAS_TIMELINE_DAYS,
  atlasBiggestChanges,
  atlasDayEnd,
  atlasPlaybackCaption,
  atlasPlaybackIndex,
  atlasPlaybackStart,
  atlasPlaybackStepMs,
} from "./atlas-timeline.js";
import type { AtlasNode } from "./atlas-model.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const DAY = 86_400_000;
const last = ATLAS_TIMELINE_DAYS - 1;

describe("timeline playback", () => {
  it("plays the whole timeline in 20 to 30 seconds", () => {
    const step = atlasPlaybackStepMs(ATLAS_TIMELINE_DAYS);
    expect(step * ATLAS_TIMELINE_DAYS).toBeGreaterThanOrEqual(20_000);
    expect(step * ATLAS_TIMELINE_DAYS).toBeLessThanOrEqual(30_000);
    expect(Math.abs(step * ATLAS_TIMELINE_DAYS - ATLAS_PLAYBACK_TOTAL_MS)).toBeLessThan(ATLAS_TIMELINE_DAYS);
    expect(atlasPlaybackStepMs(1)).toBeLessThanOrEqual(1_200);
    expect(atlasPlaybackStepMs(100_000)).toBeGreaterThanOrEqual(120);
  });

  it("starts at the first day from the live edge, or resumes from a scrubbed day", () => {
    expect(atlasPlaybackStart(null)).toBe(0);
    expect(atlasPlaybackStart(last)).toBe(0);
    expect(atlasPlaybackStart(12)).toBe(12);
  });

  it("steps one day per step and stops at the end", () => {
    const step = 800;
    expect(atlasPlaybackIndex(0, 0, step)).toBe(0);
    expect(atlasPlaybackIndex(0, 799, step)).toBe(0);
    expect(atlasPlaybackIndex(0, 800, step)).toBe(1);
    expect(atlasPlaybackIndex(10, 800 * 5 + 1, step)).toBe(15);
    expect(atlasPlaybackIndex(0, 800 * last, step)).toBeNull();
    expect(atlasPlaybackIndex(0, 1e9, step)).toBeNull();
  });
});

describe("the day's biggest changes", () => {
  const day10 = atlasDayEnd(10, NOW) - 3_600_000;
  const n = (id: string, extra: Partial<AtlasNode>): AtlasNode => ({ id, type: "project", label: id, path: id, folder: true, count: 1, ...extra });
  const nodes = [
    n("small", { touched: day10, count: 2 }),
    n("big", { touched: day10, count: 40 }),
    n("stories", { touched: day10, stories: { done: 1, total: 90 } }),
    n("mid", { touched: day10, count: 9 }),
    n("other day", { touched: day10 - DAY, count: 999 }),
    n("born", { created: day10, touched: NOW, count: 3 }),
  ];

  it("names up to three objects touched that day, largest first", () => {
    expect(atlasBiggestChanges(nodes, "touched", 10, NOW)).toEqual(["stories", "big", "mid"]);
    expect(atlasBiggestChanges(nodes, "touched", 10, NOW, 9)).toHaveLength(3);
    expect(atlasBiggestChanges(nodes, "touched", 3, NOW)).toEqual([]);
  });

  it("uses the born date in Born mode", () => {
    expect(atlasBiggestChanges(nodes, "born", 10, NOW)).toEqual(["born"]);
  });

  it("writes a plain caption, and none for a quiet day", () => {
    expect(atlasPlaybackCaption(["a", "b", "c"], "touched")).toBe("Changed: a, b and c");
    expect(atlasPlaybackCaption(["a"], "born")).toBe("New: a");
    expect(atlasPlaybackCaption([], "touched")).toBe("");
  });
});
