import { describe, expect, it, vi } from "vitest";
import {
  ATLAS_RECENT_MS,
  atlasEdges,
  atlasLabelIds,
  atlasRadius,
  atlasRelatedIds,
  atlasVisibleEdges,
  frameAll,
  layoutAtlas,
  zoomAt,
} from "./atlas-layout.js";
import {
  ATLAS_RING_ORDER,
  atlasFooterLine,
  detailFromPrd,
  parseAtlasGraph,
  smokeAtlasGraph,
} from "./atlas-model.js";
import { atlasEndpoint, createAtlasCache } from "./atlas-cache.js";

const NOW = Date.UTC(2026, 8, 30, 12);

describe("atlas layout", () => {
  it("places six kind clusters on a ring in the fixed order", () => {
    const { regions, placed } = layoutAtlas(smokeAtlasGraph().nodes);
    expect(regions.map((r) => r.label)).toEqual([
      "Projects",
      "Repos",
      "Workers",
      "Skills",
      "Policies",
      "Knowledge",
    ]);
    expect(regions.map((r) => r.type)).toEqual([...ATLAS_RING_ORDER]);
    expect(placed).toHaveLength(smokeAtlasGraph().nodes.length);
    expect(regions[0].y).toBeLessThan(0);
    expect(Math.abs(regions[0].x)).toBeLessThan(1e-6);
  });

  it("sizes circles from story count, then file count", () => {
    expect(atlasRadius({ count: 1, stories: { done: 0, total: 9 } })).toBeGreaterThan(
      atlasRadius({ count: 4 }),
    );
    expect(atlasRadius({ count: 16 })).toBeGreaterThan(atlasRadius({ count: 1 }));
  });

  it("hides edges until hover or selection", () => {
    const graph = smokeAtlasGraph();
    const edges = atlasEdges(graph.edges, graph.nodes);
    expect(atlasVisibleEdges(edges, null, null)).toEqual([]);
    const rail = "project:projects/hq-desktop-console-rail/";
    expect(atlasVisibleEdges(edges, rail, null)).toHaveLength(3);
    expect(atlasVisibleEdges(edges, null, "repo:repos/private/hq-pro/")).toHaveLength(1);
  });

  it("labels only selected, hovered, related, and recently touched objects", () => {
    const placed = [
      { id: "a", touched: NOW - ATLAS_RECENT_MS - 1 },
      { id: "b", touched: NOW - 1000 },
      { id: "c" },
      { id: "d" },
      { id: "e" },
    ];
    const ids = atlasLabelIds({
      placed,
      selected: "c",
      hovered: "d",
      related: new Set(["e"]),
      nowMs: NOW,
    });
    expect([...ids].sort()).toEqual(["b", "c", "d", "e"]);
    expect(atlasRelatedIds("x", [{ source: "x", target: "y", kind: "uses" }])).toEqual(
      new Set(["y"]),
    );
  });

  it("frames all circles inside the viewport and zooms around the cursor", () => {
    const { placed } = layoutAtlas(smokeAtlasGraph().nodes);
    const view = frameAll(placed, 800, 600);
    for (const p of placed) {
      const sx = p.x * view.k + view.x;
      const sy = p.y * view.k + view.y;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(800);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(600);
    }
    const zoomed = zoomAt(view, 100, 50, 2);
    const wx = (100 - view.x) / view.k;
    expect(wx * zoomed.k + zoomed.x).toBeCloseTo(100);
  });
});

describe("atlas model", () => {
  it("parses the Console atlas body and drops unknown kinds", () => {
    const graph = parseAtlasGraph({
      company: "Indigo",
      nodes: [
        { id: "project:projects/a/", type: "project", label: "a", path: "projects/a/", folder: true, count: 3, stories: { done: 1, total: 4 } },
        { id: "x", type: "person", label: "nope" },
      ],
      edges: [{ source: "project:projects/a/", target: "repo:r/", kind: "uses" }, { source: 1 }],
    });
    expect(graph?.nodes).toHaveLength(1);
    expect(graph?.nodes[0].stories).toEqual({ done: 1, total: 4 });
    expect(graph?.edges).toHaveLength(1);
    expect(parseAtlasGraph([])).toBeNull();
  });

  it("reads PRD goal and stories with the Console rules", () => {
    const detail = detailFromPrd({
      metadata: { goal: "Ship it" },
      branchName: "feat/x",
      userStories: [{ id: "US-1", title: "One", passes: true }, { id: "US-2" }],
    });
    expect(detail?.goal).toBe("Ship it");
    expect(detail?.branch).toBe("feat/x");
    expect(detail?.stories?.map((s) => s.title)).toEqual(["One", "US-2"]);
  });

  it("writes the Born / Touched / Inside footer", () => {
    expect(
      atlasFooterLine(
        { created: Date.UTC(2026, 6, 16), touched: NOW, count: 14, folder: true },
        NOW,
      ),
    ).toBe("Born Jul 16 · Touched Sep 30 · 14 inside");
  });
});

describe("atlas cache", () => {
  it("builds the Console company atlas URL", () => {
    expect(atlasEndpoint("https://hq.computer/", "cmp_1")).toBe(
      "https://hq.computer/api/companies/cmp_1/atlas",
    );
  });

  it("serves cached graphs per company and refreshes in the background", async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const fetcher = vi.fn(async (uid: string) => smokeAtlasGraph(uid));
    const cache = createAtlasCache({ fetcher, storage });
    expect(cache.cached("a")).toBeNull();
    const [one, two] = await Promise.all([cache.refresh("a"), cache.refresh("a")]);
    expect(one).toBe(two);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.cached("a")?.company).toBe("a");
    expect(cache.cached("b")).toBeNull();

    const again = createAtlasCache({ fetcher, storage });
    expect(again.cached("a")?.nodes.length).toBe(smokeAtlasGraph().nodes.length);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a body that does not parse instead of caching it", async () => {
    const cache = createAtlasCache({ fetcher: async () => ({ nope: true }) });
    await expect(cache.refresh("a")).rejects.toThrow(/did not parse/);
    expect(cache.cached("a")).toBeNull();
  });
});
