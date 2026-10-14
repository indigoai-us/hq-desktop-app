import { describe, expect, it } from "vitest";
import {
  ATLAS_ACTIVITY_DAYS,
  atlasHasActivityData,
  atlasProjectActivity,
  atlasRecency,
  atlasStoryFraction,
} from "./atlas-activity.js";
import { ATLAS_DOT_SOFT_CAP, atlasActivityRadius, atlasRadius, layoutAtlas } from "./atlas-layout.js";
import { smokeAtlasGraph, type AtlasNode } from "./atlas-model.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const DAY = 86_400_000;

const node = (id: string, type: AtlasNode["type"], touched?: number, extra: Partial<AtlasNode> = {}): AtlasNode => ({
  id,
  type,
  label: id,
  path: `${id}/`,
  folder: true,
  count: 1,
  touched,
  ...extra,
});

describe("project activity", () => {
  it("recency is 1 now, falls to 0 at the window edge, and is 0 for undated objects", () => {
    expect(atlasRecency(NOW, NOW)).toBe(1);
    expect(atlasRecency(NOW - 7 * DAY, NOW)).toBeCloseTo(0.5);
    expect(atlasRecency(NOW - ATLAS_ACTIVITY_DAYS * DAY, NOW)).toBe(0);
    expect(atlasRecency(undefined, NOW)).toBe(0);
  });

  it("scores a project by its own touch plus linked objects touched in the window", () => {
    const nodes = [
      node("p:busy", "project", NOW),
      node("p:idle", "project", NOW - 60 * DAY),
      node("r:fresh", "repo", NOW - DAY),
      node("k:old", "knowledge", NOW - 40 * DAY),
    ];
    const edges = [
      { source: "p:busy", target: "r:fresh", kind: "uses" as const },
      { source: "p:busy", target: "k:old", kind: "cites" as const },
      { source: "p:idle", target: "k:old", kind: "cites" as const },
    ];
    const score = atlasProjectActivity(nodes, edges, NOW);
    expect(score.get("p:busy")).toBe(10);
    expect(score.get("p:idle")).toBe(0);
    expect(score.has("r:fresh")).toBe(false);
  });

  it("sizes busier projects larger, idle ones small, and never past the soft cap", () => {
    expect(atlasActivityRadius(10)).toBeGreaterThan(atlasActivityRadius(0));
    expect(atlasActivityRadius(10_000)).toBeLessThan(ATLAS_DOT_SOFT_CAP);
    const nodes = [node("p:busy", "project", NOW), node("p:idle", "project", NOW - 60 * DAY)];
    const { placed } = layoutAtlas(nodes, { nowMs: NOW });
    const r = (id: string) => placed.find((p) => p.id === id)!.r;
    expect(r("p:busy")).toBeGreaterThan(r("p:idle"));
  });

  it("keeps the old size without a clock or without any dated project", () => {
    const big = node("p:big", "project", undefined, { stories: { done: 1, total: 40 } });
    expect(atlasHasActivityData([big])).toBe(false);
    expect(layoutAtlas([big], { nowMs: NOW }).placed[0]!.r).toBe(atlasRadius(big));
    expect(layoutAtlas(smokeAtlasGraph().nodes).placed.find((p) => p.type === "project")!.r).toBe(
      atlasRadius(smokeAtlasGraph().nodes.find((n) => n.type === "project")!),
    );
  });
});

describe("story ring", () => {
  it("is done over total, clamped, and absent without stories", () => {
    expect(atlasStoryFraction({ stories: { done: 7, total: 11 } })).toBeCloseTo(7 / 11);
    expect(atlasStoryFraction({ stories: { done: 0, total: 9 } })).toBe(0);
    expect(atlasStoryFraction({ stories: { done: 12, total: 9 } })).toBe(1);
    expect(atlasStoryFraction({ stories: { done: 0, total: 0 } })).toBeNull();
    expect(atlasStoryFraction({})).toBeNull();
  });
});
