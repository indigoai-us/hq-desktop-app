import { describe, expect, it } from "vitest";
import { atlasAgo, atlasTodayChanges } from "./atlas-today.js";
import type { AtlasNode } from "./atlas-model.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const n = (id: string, type: AtlasNode["type"], touched?: number): AtlasNode => ({ id, type, label: id, path: id, folder: false, count: 1, touched });

describe("Today panel contents", () => {
  it("lists objects changed today, projects first, then newest", () => {
    const nodes = [
      n("k-new", "knowledge", NOW - 60_000),
      n("p-old-today", "project", Date.UTC(2026, 8, 30, 1)),
      n("p-new", "project", NOW - 5 * 60_000),
      n("yesterday", "project", Date.UTC(2026, 8, 29, 23, 59)),
      n("future", "repo", NOW + 60_000),
      n("undated", "repo"),
    ];
    expect(atlasTodayChanges(nodes, NOW).map((x) => x.id)).toEqual(["p-new", "p-old-today", "k-new"]);
  });

  it("is empty on a quiet day", () => {
    expect(atlasTodayChanges([n("old", "project", NOW - 3 * 86_400_000)], NOW)).toEqual([]);
  });

  it("says how long ago in plain words", () => {
    expect(atlasAgo(NOW - 10_000, NOW)).toBe("just now");
    expect(atlasAgo(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(atlasAgo(NOW - 3 * 3_600_000 - 1, NOW)).toBe("3 h ago");
  });
});
