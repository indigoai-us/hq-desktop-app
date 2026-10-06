import { describe, expect, it, vi } from "vitest";
import {
  ATLAS_RECENT_MS,
  atlasEdges,
  atlasScreenLabels,
  atlasDistrictShapes,
  atlasDistrictLabel,
  ATLAS_LABEL_ALL_ZOOM,
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
  it("lists the six kind clusters in the fixed order and packs them around the largest", () => {
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
    // Packed, not on a fixed ring: the largest section sits at the centre and
    // every other one is within reach of it.
    const shapes = atlasDistrictShapes(placed, regions);
    const largest = shapes.reduce((a, b) => (b.r > a.r ? b : a));
    expect(Math.hypot(largest.x, largest.y)).toBeLessThan(1e-6);
    const span = Math.max(...shapes.map((d) => Math.hypot(d.x, d.y) + d.r));
    expect(span).toBeLessThan(shapes.reduce((sum, d) => sum + d.r * 2, 0));
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

  it("with an object selected, labels only selected, hovered, related, and recently touched objects at fit", () => {
    const at = (id: string, x: number, touched?: number) => ({ id, label: id, x, y: 0, r: 4, touched });
    const placed = [at("a", 0, NOW - ATLAS_RECENT_MS - 1), at("b", 100, NOW - 1000), at("c", 200), at("d", 300), at("e", 400), at("f", 500)];
    const labels = atlasScreenLabels({
      placed,
      selected: "c",
      hovered: "d",
      related: new Set(["e"]),
      nowMs: NOW,
      view: { x: 20, y: 100, k: 0.5 },
      width: 2000,
      height: 400,
      measure: () => 20,
    });
    expect(labels.map((l) => l.id).sort()).toEqual(["b", "c", "d", "e"]);
    expect(atlasRelatedIds("x", [{ source: "x", target: "y", kind: "uses" }])).toEqual(
      new Set(["y"]),
    );
  });

  it("keeps labels readable and non-overlapping, preferring recent then larger objects (OWNER-D 4)", () => {
    const { placed } = layoutAtlas(smokeAtlasGraph().nodes);
    for (const [w, h] of [[1440, 900], [1000, 700], [640, 420]]) {
      const view = frameAll(placed, w, h);
      const labels = atlasScreenLabels({
        placed,
        selected: null,
        hovered: null,
        related: new Set(),
        nowMs: NOW,
        view,
        width: w,
        height: h,
        measure: (t) => t.length * 8,
      });
      for (const [i, a] of labels.entries()) {
        expect(a.box.left).toBeGreaterThanOrEqual(0);
        expect(a.box.right).toBeLessThanOrEqual(w);
        for (const b of labels.slice(i + 1)) {
          const overlap =
            a.box.left < b.box.right && b.box.left < a.box.right && a.box.top < b.box.bottom && b.box.top < a.box.bottom;
          expect(overlap, `${a.id} × ${b.id} at ${w}`).toBe(false);
        }
      }
    }
    // Crowded: two objects on top of each other at the map's left edge, so only
    // the right-hand spot fits; the more recent one wins it.
    const crowd = [
      { id: "old", label: "old", x: 0, y: 0, r: 9, touched: NOW - 5000 },
      { id: "new", label: "new", x: 1, y: 1, r: 2, touched: NOW - 10 },
    ];
    const args = { selected: null, hovered: null, related: new Set<string>(), nowMs: NOW, width: 500, height: 500, measure: () => 40 };
    expect(atlasScreenLabels({ ...args, placed: crowd, view: { x: 0, y: 100, k: 1 } }).map((l) => l.id)).toEqual(["new"]);
    // Hover reveals a hidden label, ahead of everything else.
    expect(atlasScreenLabels({ ...args, placed: crowd, hovered: "old", view: { x: 0, y: 100, k: 1 } }).map((l) => l.id)).toEqual(["old"]);
  });

  it("names the hovered object even when every label spot touches a neighbour's dot", () => {
    // A packed section: four neighbours sit right, left, above and below the
    // hovered dot, so each of its label spots covers one of their dots.
    const packed = [
      { id: "h", label: "h", x: 250, y: 250, r: 5 },
      { id: "e", label: "e", x: 275, y: 246, r: 5 },
      { id: "w", label: "w", x: 225, y: 246, r: 5 },
      { id: "n", label: "n", x: 250, y: 233, r: 5 },
      { id: "s", label: "s", x: 250, y: 266, r: 5 },
    ].map((n) => ({ ...n, type: "knowledge" as const }));
    const labels = atlasScreenLabels({
      placed: packed,
      selected: null,
      hovered: "h",
      related: new Set(),
      nowMs: NOW,
      view: { x: 0, y: 0, k: 1 },
      width: 500,
      height: 500,
      measure: () => 40,
    });
    expect(labels.map((l) => l.id)).toContain("h");
  });

  describe("owner 2026-10-05: only recent projects are named until a project is hovered", () => {
    type T = "project" | "knowledge" | "policy" | "repo" | "worker" | "skill";
    const at = (id: string, type: T, x: number, touched?: number) => ({ id, type, label: id, x, y: 0, r: 4, touched });
    const placed = [
      at("p-old", "project", 0, NOW - 90 * 86_400_000),
      at("p-new", "project", 100, NOW - 1000),
      at("p-mid", "project", 200, NOW - 10 * 86_400_000),
      at("k-recent", "knowledge", 300, NOW - 10),
      at("pol", "policy", 400, NOW - 10),
      at("repo", "repo", 500, NOW - 10),
      at("w", "worker", 600, NOW - 10),
      at("s", "skill", 700, NOW - 10),
    ];
    const edges = [
      { source: "p-old", target: "repo", kind: "uses" as const },
      { source: "p-old", target: "k-recent", kind: "cites" as const },
      { source: "p-old", target: "pol", kind: "cites" as const },
    ];
    const base = { placed, nowMs: NOW, view: { x: 20, y: 100, k: 0.5 }, width: 2000, height: 400, measure: () => 20 };

    it("idle labels are all projects, ordered by recency", () => {
      const labels = atlasScreenLabels({ ...base, selected: null, hovered: null, related: new Set() });
      expect(labels.map((l) => l.id)).toEqual(["p-new", "p-mid", "p-old"]);
    });

    it("idle state at fit zoom names no knowledge, policy, repo, worker or skill", () => {
      const { placed: real } = layoutAtlas(smokeAtlasGraph().nodes);
      const types = new Map(real.map((n) => [n.id, n.type]));
      const view = frameAll(real, 1440, 900);
      const fit = { ...view, k: Math.min(view.k, ATLAS_LABEL_ALL_ZOOM * 0.5) };
      const labels = atlasScreenLabels({
        placed: real,
        selected: null,
        hovered: null,
        related: new Set(),
        nowMs: NOW,
        view: fit,
        width: 1440,
        height: 900,
        measure: (t) => t.length * 8,
      });
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((l) => types.get(l.id) === "project")).toBe(true);
    });

    it("hovering a project names it and its related repo, knowledge and policy", () => {
      const labels = atlasScreenLabels({ ...base, selected: null, hovered: "p-old", related: atlasRelatedIds("p-old", edges) });
      const ids = labels.map((l) => l.id);
      expect(ids.slice(0, 4).sort()).toEqual(["k-recent", "p-old", "pol", "repo"].sort());
      expect(labels.find((l) => l.id === "p-old")?.rank).toBe(0);
      expect(ids).not.toContain("w");
      expect(ids).not.toContain("s");
      // Recent projects keep their names; idle older ones step back.
      expect(ids).toContain("p-new");
      expect(ids).not.toContain("p-mid");
    });

    it("selecting a project keeps its related items named", () => {
      const labels = atlasScreenLabels({ ...base, selected: "p-old", hovered: null, related: atlasRelatedIds("p-old", edges) });
      expect(labels.map((l) => l.id).sort()).toEqual(["k-recent", "p-new", "p-old", "pol", "repo"]);
    });

    it("hovering a non-project item names that item", () => {
      const labels = atlasScreenLabels({ ...base, selected: null, hovered: "w", related: new Set() });
      expect(labels[0]?.id).toBe("w");
      expect(labels.map((l) => l.id)).not.toContain("s");
    });

    it("zoomed in past the label-all zoom, other sections may be named again", () => {
      const labels = atlasScreenLabels({ ...base, view: { x: 20, y: 100, k: ATLAS_LABEL_ALL_ZOOM }, width: 4000, selected: null, hovered: null, related: new Set() });
      expect(labels.map((l) => l.id)).toContain("w");
    });
  });

  it("reveals more labels as the map zooms in (OWNER-D 4)", () => {
    const { placed } = layoutAtlas(smokeAtlasGraph().nodes);
    const base = { selected: null, hovered: null, related: new Set<string>(), nowMs: NOW, measure: (t: string) => t.length * 8 };
    // Start below the label-all zoom: the ring is sized to its contents, so a
    // small map can already frame at or above that zoom.
    const fitK = Math.min(frameAll(placed, 1000, 700).k, ATLAS_LABEL_ALL_ZOOM * 0.5);
    const centre = placed[0]!;
    const fit = { x: 500 - centre.x * fitK, y: 350 - centre.y * fitK, k: fitK };
    const atFit = atlasScreenLabels({ ...base, placed, view: fit, width: 1000, height: 700 });
    // Zoomed in on the first object, with a viewport large enough to hold its district.
    const target = placed[0]!;
    const k = ATLAS_LABEL_ALL_ZOOM * 1.5;
    const zoomed = atlasScreenLabels({
      ...base,
      placed,
      view: { x: 500 - target.x * k, y: 350 - target.y * k, k },
      width: 1000,
      height: 700,
    });
    const shown = new Set(atFit.map((l) => l.id));
    expect(zoomed.some((l) => !shown.has(l.id))).toBe(true);
  });

  it("shades one area per section with objects, enclosing them, and keeps item labels off section names (OWNER-D 7)", () => {
    const { placed, regions } = layoutAtlas(smokeAtlasGraph().nodes);
    const shapes = atlasDistrictShapes(placed, regions);
    const types = new Set(placed.map((n) => n.type));
    expect(shapes.map((d) => d.type).sort()).toEqual([...types].sort());
    for (const d of shapes) {
      for (const n of placed.filter((p) => p.type === d.type)) {
        expect(Math.hypot(n.x - d.x, n.y - d.y) + n.r).toBeLessThanOrEqual(d.r);
      }
    }
    const view = frameAll(placed, 1000, 700);
    const measure = (t: string) => t.length * 8;
    const reserved = shapes.map((d) => atlasDistrictLabel(d, view, measure).box);
    const labels = atlasScreenLabels({ placed, selected: null, hovered: null, related: new Set(), nowMs: NOW, view, width: 1000, height: 700, measure, reserved });
    for (const l of labels) {
      for (const r of reserved) {
        expect(l.box.left < r.right && r.left < l.box.right && l.box.top < r.bottom && r.top < l.box.bottom).toBe(false);
      }
    }
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
