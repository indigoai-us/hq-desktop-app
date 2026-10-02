import { describe, expect, it } from "vitest";
import {
  ATLAS_BORN_HIDDEN,
  ATLAS_TIMELINE_DAYS,
  ATLAS_TOUCH_FADED,
  atlasDailyCounts,
  atlasDayIndex,
  atlasHistogramHeights,
  atlasScrubLabel,
  atlasTimeOpacity,
} from "./atlas-timeline.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 12);

describe("atlas timeline (US-014)", () => {
  it("buckets thirty days ending today", () => {
    expect(atlasDayIndex(NOW, NOW)).toBe(ATLAS_TIMELINE_DAYS - 1);
    expect(atlasDayIndex(NOW - 29 * DAY, NOW)).toBe(0);
    expect(atlasDayIndex(NOW - 30 * DAY, NOW)).toBe(-1);
    expect(atlasDayIndex(NOW + DAY, NOW)).toBe(-1);
    expect(atlasDayIndex(undefined, NOW)).toBe(-1);
  });

  it("counts by created in Born mode and touched in Touched mode", () => {
    const nodes = [
      { created: NOW - 2 * DAY, touched: NOW },
      { created: NOW - 2 * DAY, touched: NOW - DAY },
      { created: NOW - 90 * DAY, touched: NOW },
    ];
    const born = atlasDailyCounts(nodes, "born", NOW);
    const touched = atlasDailyCounts(nodes, "touched", NOW);
    expect(born[27]).toBe(2);
    expect(born.reduce((a, b) => a + b, 0)).toBe(2);
    expect(touched[29]).toBe(2);
    expect(touched[28]).toBe(1);
  });

  it("scales bars to the busiest day and keeps empty days flat", () => {
    expect(atlasHistogramHeights([0, 1, 4])).toEqual([0, 25, 100]);
    expect(atlasHistogramHeights([0, 0])).toEqual([0, 0]);
  });

  it("reads Now at the live edge and a date when scrubbed back", () => {
    expect(atlasScrubLabel(null, NOW)).toBe("Now");
    expect(atlasScrubLabel(29, NOW)).toBe("Now");
    expect(atlasScrubLabel(0, NOW)).toBe("Sep 1");
  });

  it("fades objects by opacity only and leaves the map alone at now", () => {
    const nodes = [
      { id: "old", created: NOW - 60 * DAY, touched: NOW - 20 * DAY },
      { id: "new", created: NOW - DAY, touched: NOW },
      { id: "busy", created: NOW - 60 * DAY, touched: NOW - 11 * DAY },
      { id: "bare" },
    ];
    expect(atlasTimeOpacity(nodes, "born", null, NOW)).toBeNull();
    const tenDaysAgo = ATLAS_TIMELINE_DAYS - 1 - 10;
    const born = atlasTimeOpacity(nodes, "born", tenDaysAgo, NOW)!;
    expect(born.get("new")).toBe(ATLAS_BORN_HIDDEN);
    expect(born.has("old")).toBe(false);
    expect(born.has("bare")).toBe(false);
    const touched = atlasTimeOpacity(nodes, "touched", tenDaysAgo, NOW)!;
    expect(touched.has("busy")).toBe(false);
    expect(touched.get("old")).toBe(ATLAS_TOUCH_FADED);
    expect(touched.get("new")).toBe(ATLAS_BORN_HIDDEN);
  });
});
