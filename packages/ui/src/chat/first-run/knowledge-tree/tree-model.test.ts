import { describe, expect, it } from "vitest";

import { createSceneClock } from "./scene-clock.js";
import {
  buildCallouts,
  buildFeed,
  buildStaticLayout,
  drawScene,
  lastScheduled,
  sceneGeometry,
  type DrawContext,
  type SceneLayout,
} from "./scene-renderer.js";
import { planScene, treeSpecFor, type TimedScanEvent } from "./scene-model.js";
import { parseScanEvent, type ScanEvent } from "./scan-stream.js";
import {
  MAX_COMPANY_LIMBS,
  branchCellAt,
  crownExtents,
  generateTree,
  rasterizeTree,
  referenceSpec,
  treeScale,
  type TreeSpec,
} from "./tree-model.js";

const spec = (limbs: TreeSpec["limbs"], trunk: number | null = 0): TreeSpec => ({
  trunk,
  limbs,
  richnessAt: (theta) => (theta <= 0.5 ? 4 + theta * 10 : Infinity),
});

describe("tree model", () => {
  it("is deterministic: the same spec and seed give the same tree", () => {
    const s = spec([{ slot: 0, ready: 2, projects: [{ ready: 3 }] }]);
    expect(generateTree(s)).toEqual(generateTree(s));
    expect(JSON.stringify(generateTree(s, 7))).not.toBe(JSON.stringify(generateTree(s, 8)));
  });

  it("adding a limb or a project never moves the parts already grown", () => {
    const before = generateTree(spec([{ slot: 0, ready: 2, projects: [{ ready: 3 }] }]));
    const after = generateTree(
      spec([
        { slot: 0, ready: 2, projects: [{ ready: 3 }, { ready: 5 }] },
        { slot: 1, ready: 4, projects: [{ ready: 6 }] },
      ]),
    );
    const pick = (m: typeof before, kind: string) =>
      m.branches.filter((b) => b.kind === kind && b.limb <= 0 && b.project <= 0).map((b) => ({ pts: b.pts, t0: b.t0, dur: b.dur }));
    for (const kind of ["trunk", "root", "limb"]) expect(pick(after, kind)).toEqual(pick(before, kind));
    const firstProject = (m: typeof before) => m.branches.find((b) => b.kind === "project" && b.limb === 0 && b.project === 0);
    expect(firstProject(after)?.pts).toEqual(firstProject(before)?.pts);
  });

  it("nothing grows before the trunk is ready, and nothing grows before its own data", () => {
    const empty = generateTree(spec([], null));
    expect(empty.branches.every((b) => !Number.isFinite(b.t0))).toBe(true);
    const m = generateTree(spec([{ slot: 0, ready: 9, projects: [{ ready: 12 }] }], 1));
    const limb = m.branches.find((b) => b.kind === "limb")!;
    const project = m.branches.find((b) => b.kind === "project")!;
    expect(limb.t0).toBeGreaterThanOrEqual(9);
    expect(project.t0).toBeGreaterThanOrEqual(12);
  });

  it("a withering project or limb passes its second to everything grown from it", () => {
    const m = generateTree(spec([{ slot: "other", ready: 2, gone: 20, projects: [{ ready: 3, gone: 15 }] }]));
    const project = m.branches.filter((b) => b.kind === "project");
    expect(project.length).toBeGreaterThan(0);
    for (const b of project) expect(b.gone).toBeLessThanOrEqual(15);
    for (const b of m.branches.filter((x) => x.kind === "twig" && x.limb === 0 && x.project === 0)) expect(b.gone).toBeLessThanOrEqual(15);
    for (const b of m.branches.filter((x) => x.limb === 0)) expect(b.gone).toBeLessThanOrEqual(20);
    expect(m.branches.filter((b) => b.kind === "trunk").every((b) => b.gone === Infinity)).toBe(true);
  });

  it("foliage that withered stays withered when a later branch reaches it", () => {
    // Projects that wither, then later projects on the same limbs: the later
    // branches reach some of the same canopy clumps.
    const before = spec([
      { slot: 0, ready: 1, projects: [{ ready: 2, gone: 12 }, { ready: 2, gone: 12 }] },
      { slot: 1, ready: 1, projects: [{ ready: 2, gone: 12 }, { ready: 2, gone: 12 }] },
    ]);
    const after = spec([
      { slot: 0, ready: 1, projects: [{ ready: 2, gone: 12 }, { ready: 2, gone: 12 }, { ready: 40 }, { ready: 40 }] },
      { slot: 1, ready: 1, projects: [{ ready: 2, gone: 12 }, { ready: 2, gone: 12 }, { ready: 40 }, { ready: 40 }] },
    ]);
    const canopy = (m: ReturnType<typeof generateTree>) =>
      new Map(m.clumps.filter((k) => k.kind === "leaf").map((k) => [`${k.x.toFixed(6)},${k.y.toFixed(6)}`, k]));
    const was = canopy(generateTree(before));
    const now = canopy(generateTree(after));
    let withered = 0;
    for (const [at, k] of was) {
      if (!(k.gone < 40)) continue;
      const later = now.get(at);
      if (!later) continue;
      withered += 1;
      expect(later.gone).toBe(k.gone);
    }
    expect(withered).toBeGreaterThan(0);
  });

  it("the drawing keeps one scale from the reference tree, however much has arrived", () => {
    const box = sceneGeometry(1400, 920).box;
    const scale = treeScale(box);
    expect(rasterizeTree(generateTree(spec([], 0)), box).scale).toBe(scale);
    expect(rasterizeTree(generateTree(referenceSpec()), box).scale).toBe(scale);
    const big = spec(Array.from({ length: MAX_COMPANY_LIMBS }, (_, slot) => ({ slot, ready: 1, projects: [{ ready: 2 }, { ready: 2 }] })));
    expect(rasterizeTree(generateTree(big), box).scale).toBe(scale);
  });

  it("the tree stays inside its box at both reference window sizes", () => {
    for (const [W, H] of [
      [1400, 920],
      [1180, 760],
    ] as const) {
      const geo = sceneGeometry(W, H);
      const raster = rasterizeTree(generateTree(referenceSpec()), geo.box);
      const crown = crownExtents(raster);
      expect(crown.minX).toBeGreaterThanOrEqual(geo.box.left - raster.cell * 2);
      expect(crown.maxX).toBeLessThanOrEqual(geo.box.right + raster.cell * 2);
      expect(crown.minY).toBeGreaterThanOrEqual(geo.box.top - raster.cell * 2);
      expect(raster.branches.some((c) => branchCellAt(c, 1e6))).toBe(true);
    }
  });
});

function fixtureLog(): TimedScanEvent[] {
  const raw: Array<[number, Record<string, unknown>]> = [
    [10, { type: "start", sources: [{ id: "hq", label: "HQ companies" }, { id: "repos", label: "Code repositories" }] }],
    [10.1, { type: "source", id: "hq", status: "scanning" }],
    [10.2, { type: "company", id: "a", name: "Alpha", basis: "hq-company" }],
    [10.3, { type: "company", id: "b", name: "Beta", basis: "hq-company" }],
    [10.4, { type: "source", id: "hq", status: "done", counts: { companies: 2 } }],
    [10.5, { type: "source", id: "repos", status: "scanning" }],
    [10.6, { type: "project", id: "p_000000000001", name: "one", company: "a", basis: "repo" }],
    [10.7, { type: "project", id: "p_000000000002", name: "two", company: null, basis: "repo" }],
    [10.8, { type: "source", id: "repos", status: "done", counts: { repos: 2 } }],
    [11, { type: "done", report: "/tmp/r.json", summary: { companies: 2, projects: 2 } }],
  ];
  return raw.map(([at, e]) => ({ at, event: parseScanEvent({ v: 1, ...e }) as ScanEvent }));
}

/** A canvas stand-in that records every call and assignment, rounded so the log compares cleanly. */
function recorder(): { ctx: DrawContext; calls: string[] } {
  const calls: string[] = [];
  const fmt = (v: unknown) => (typeof v === "number" ? v.toFixed(3) : String(v));
  const fn = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}(${args.map(fmt).join(",")})`);
  };
  const target: Record<string, unknown> = {
    clearRect: fn("clearRect"),
    fillRect: fn("fillRect"),
    fillText: fn("fillText"),
    beginPath: fn("beginPath"),
    arc: fn("arc"),
    fill: fn("fill"),
    moveTo: fn("moveTo"),
    lineTo: fn("lineTo"),
    stroke: fn("stroke"),
    createRadialGradient: (...args: unknown[]) => {
      calls.push(`gradient(${args.map(fmt).join(",")})`);
      return { addColorStop: (o: number, c: string) => calls.push(`stop(${fmt(o)},${c})`) };
    },
  };
  const ctx = new Proxy(target, {
    set(obj, key, value) {
      calls.push(`${String(key)}=${typeof value === "object" ? "gradient" : fmt(value)}`);
      obj[key as string] = value;
      return true;
    },
  }) as unknown as DrawContext;
  return { ctx, calls };
}

function layoutFor(W: number, H: number) {
  const plan = planScene({ scanStart: 10, events: fixtureLog(), failure: null });
  const geo = sceneGeometry(W, H);
  const reference = rasterizeTree(generateTree(referenceSpec()), geo.box);
  const crown = crownExtents(reference);
  const stat = buildStaticLayout(geo, reference, crown);
  const raster = rasterizeTree(generateTree(treeSpecFor(plan)), geo.box);
  const rows = plan.rows.map((_, i) => ({ x: geo.colLeft, y: geo.colTop + 200 + i * geo.rowsGap, w: geo.colW }));
  const layout: SceneLayout = {
    geo,
    raster,
    feed: buildFeed(raster, plan, rows),
    callouts: buildCallouts(raster, reference, W, raster.anchors.map(() => 120)),
    crown: crownExtents(raster),
  };
  return { plan, layout, stat };
}

describe("scene renderer", () => {
  it("draws the same frame for the same second, every time", () => {
    const one = layoutFor(1400, 920);
    const two = layoutFor(1400, 920);
    expect(two.layout).toEqual(one.layout);
    const settle = lastScheduled(one.layout, one.plan);
    expect(Number.isFinite(settle)).toBe(true);
    for (const t of [0.5, 11, 14, 18, settle + 1]) {
      const a = recorder();
      const b = recorder();
      drawScene(a.ctx, one.layout, one.stat, one.plan, t);
      drawScene(b.ctx, two.layout, two.stat, two.plan, t);
      expect(a.calls.length).toBeGreaterThan(0);
      expect(b.calls).toEqual(a.calls);
    }
  });

  it("the tree has drawn more by the time it settles than early on", () => {
    const { plan, layout, stat } = layoutFor(1180, 760);
    const glyphs = (t: number) => {
      const r = recorder();
      drawScene(r.ctx, layout, stat, plan, t);
      return r.calls.filter((c) => c.startsWith("fillText(")).length;
    };
    expect(glyphs(lastScheduled(layout, plan) + 1)).toBeGreaterThan(glyphs(11));
  });
});

describe("scene clock", () => {
  it("leaves out time spent hidden", () => {
    let ms = 1000;
    let hidden = false;
    const listeners = new Set<() => void>();
    const doc = {
      get hidden() {
        return hidden;
      },
      addEventListener: (_: "visibilitychange", fn: () => void) => listeners.add(fn),
      removeEventListener: (_: "visibilitychange", fn: () => void) => listeners.delete(fn),
    };
    const clock = createSceneClock({ nowMs: () => ms, doc });
    ms += 2000;
    expect(clock.now()).toBe(2);
    hidden = true;
    listeners.forEach((fn) => fn());
    ms += 5000;
    expect(clock.now()).toBe(2);
    hidden = false;
    listeners.forEach((fn) => fn());
    ms += 1000;
    expect(clock.now()).toBe(3);
    clock.dispose();
    expect(listeners.size).toBe(0);
  });
});
