/**
 * Knowledge tree layout: structure, timing and ASCII rasterisation.
 *
 * Ported from the approved design preview
 * (workspace/previews/first-run-knowledge-tree/js/tree.js). The preview grew
 * one fixed tree for three companies with three projects each on a fixed
 * timeline. Here the tree is grown from whatever the scan has found so far:
 *
 *  - Every part of the tree has its own seeded random stream (`seedOf` of its
 *    slot), so adding a company never moves a limb that is already there, and
 *    the same data gives the same tree in every window.
 *  - Every part carries the second it starts to grow. Those seconds come from
 *    the scene model (scene-model.ts), which paces the scan's events, and
 *    from the tree's own geometry (a limb cannot start before the trunk has
 *    reached its fork). Fine twigs, leaves and blossoms wait for the scene's
 *    "richness" (how much the scan has found, capped) to pass their own
 *    threshold, so the crown fills in step with the counts and never past
 *    them.
 *  - The scale comes from a fixed reference tree, so the drawing never jumps
 *    in size as limbs arrive.
 *
 * The scene only ever adds data with start times at or after the moment it
 * arrives, so a regenerated tree draws exactly what the previous one drew
 * for every second already on screen.
 *
 * This module is pure: no DOM, no canvas, no clock.
 */

import { DEG, TAU, UP, angDiff, hash, hash2, invCubicIO, mulberry32, seedOf } from "./tree-math.js";

export const TREE_SEED = 20261008;

/** Cell pitch and glyph size of the ASCII grid (createSkyline: 11px cells, 10px mono). */
export const CELL = 11;
export const FONT_PX = 10;

/** Company limbs the tree can hold. More companies share the "other" limb. */
export const MAX_COMPANY_LIMBS = 5;
/** Project branches drawn per company limb. More projects only feed the crown. */
export const MAX_PROJECT_BRANCHES = 4;
/** Project branches drawn on the small "other" limb. */
export const MAX_OTHER_BRANCHES = 3;

export const TRUNK_DUR = 2.8;
export const LIMB_DUR = 2.0;
export const PROJECT_DUR = 1.5;
const TWIG3_DUR = 1.25;
const TWIG4_DUR = 1.05;

export type LimbSlot = number | "other";

export interface TreeLimbSpec {
  /** Company slot 0..MAX_COMPANY_LIMBS-1, or "other" for unattached projects. */
  slot: LimbSlot;
  /** Earliest second the limb may start (paced by the scene). */
  ready: number;
  /** When the limb withers (an emptied "other" limb); null or absent while it stays. */
  gone?: number | null;
  /** Each project branch on it, in arrival order: earliest start, and when it withers if it moved. */
  projects: ReadonlyArray<{ ready: number; gone?: number | null }>;
}

export interface TreeSpec {
  /** Earliest second the trunk may start; null while there is nothing to grow. */
  trunk: number | null;
  limbs: readonly TreeLimbSpec[];
  /** The second the scene's richness first reaches `theta` (0..1); Infinity if not yet. */
  richnessAt: (theta: number) => number;
}

interface Pt {
  x: number;
  y: number;
  a: number;
  w: number;
  s: number;
}

export type BranchKind = "trunk" | "root" | "limb" | "project" | "twig";

export interface Branch {
  id: number;
  pts: Pt[];
  len: number;
  t0: number;
  dur: number;
  kind: BranchKind;
  depth: number;
  /** Index into `TreeSpec.limbs`, or -1 for the trunk and roots. */
  limb: number;
  project: number;
  side: number;
  /** When this part withers (it moved, or its limb did); Infinity while it stays. */
  gone: number;
}

interface BranchOpts {
  x: number;
  y: number;
  ang: number;
  len: number;
  w0: number;
  w1: number;
  trop?: number;
  bend?: number;
  wob?: number;
  taper?: number;
  toward?: number;
}

export interface Clump {
  id: number;
  x: number;
  y: number;
  sig: number;
  w: number;
  tg: number;
  span: number;
  kind: "bud" | "leaf";
  sx: number;
  gone: number;
}

export interface Blossom {
  x: number;
  y: number;
  tg: number;
  limb: number;
  hue: number;
  key: number;
  gone: number;
}

export interface LimbAnchor {
  x: number;
  y: number;
  limb: number;
  slot: LimbSlot;
  tg: number;
  limbEnd: number;
  gone: number;
}

export interface ProjectAnchor {
  x: number;
  y: number;
  a: number;
  side: number;
  limb: number;
  project: number;
  done: number;
  gone: number;
}

export interface TreeModel {
  branches: Branch[];
  clumps: Clump[];
  blossoms: Blossom[];
  anchors: LimbAnchor[];
  projAnchors: ProjectAnchor[];
}

/** The crown is a dome (an ellipse in unit space); limbs, projects and twigs aim into it. */
export const CROWN = { x: 0.0, y: -0.6, rx: 0.54, ry: 0.36 } as const;

const crownPt = (phi: number, k: number) => ({
  x: CROWN.x + Math.cos(phi) * CROWN.rx * k,
  y: CROWN.y + Math.sin(phi) * CROWN.ry * k,
});
const aim = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.atan2(q.y - p.y, q.x - p.x);
const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(q.x - p.x, q.y - p.y);

/**
 * Company limb slots, filled in arrival order. The first is the leader up the
 * middle, then left, then right (the preview's three limbs), then two upper
 * limbs between them. One company still makes a balanced tree.
 */
const LIMB_SLOTS = [
  { s: 1.0, phi: -100, k: 0.62, w0: 0.06, sector: [226, 318], kick: 0.2 },
  { s: 0.78, phi: 200, k: 0.62, w0: 0.066, sector: [150, 232], kick: -0.32 },
  { s: 0.9, phi: -18, k: 0.6, w0: 0.068, sector: [-42, 30], kick: 0.3 },
  { s: 0.86, phi: 230, k: 0.72, w0: 0.05, sector: [204, 252], kick: -0.16 },
  { s: 0.95, phi: -56, k: 0.7, w0: 0.05, sector: [-80, -36], kick: 0.16 },
] as const;

/** Where project branches fork off a company limb, and which part of its sector they reach for. */
const PROJECT_SLOTS = [
  { s: 0.34, f: 1 / 6 },
  { s: 0.58, f: 0.5 },
  { s: 0.8, f: 5 / 6 },
  { s: 0.68, f: 0.33 },
] as const;

/** The small "other" limb: low on the trunk, reaching out to the right, under the crown. */
const OTHER_LIMB = { s: 0.5, to: { x: 0.31, y: -0.27 }, w0: 0.034, kick: 0.22 } as const;
const OTHER_PROJECT_S = [0.5, 0.74, 0.95] as const;

function slotCode(slot: LimbSlot): number {
  return slot === "other" ? 99 : slot;
}

function makeBranch(R: () => number, o: BranchOpts): { pts: Pt[]; len: number } {
  const n = Math.max(10, Math.round(o.len / 0.004));
  const ds = o.len / n;
  let x = o.x;
  let y = o.y;
  let a = o.ang;
  const ph = R() * TAU;
  const fq = 0.6 + R() * 1.1;
  const pts: Pt[] = [{ x, y, a, w: o.w0, s: 0 }];
  for (let i = 1; i <= n; i += 1) {
    const u = i / n;
    a += (((o.bend ?? 0) * Math.cos(ph + u * fq * TAU)) / n) * 3;
    a += (R() - 0.5) * (o.wob ?? 0);
    a += (angDiff(o.toward ?? UP, a) * (o.trop ?? 0)) / n;
    x += Math.cos(a) * ds;
    y += Math.sin(a) * ds;
    const w = o.w0 + (o.w1 - o.w0) * Math.pow(u, o.taper ?? 0.8);
    pts.push({ x, y, a, w, s: i * ds });
  }
  return { pts, len: o.len };
}

/** Point, direction and width at fraction `s01` along a branch. */
export function branchAt(b: { pts: Pt[] }, s01: number): { x: number; y: number; a: number; w: number } {
  const f = Math.max(0, Math.min(1, s01)) * (b.pts.length - 1);
  const i = Math.min(b.pts.length - 2, Math.floor(f));
  const k = f - i;
  const p = b.pts[i]!;
  const q = b.pts[i + 1]!;
  return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, a: p.a + angDiff(q.a, p.a) * k, w: p.w + (q.w - p.w) * k };
}

/** Second at which a branch's growth front passes fraction `s01`. */
export function timeAt(b: { t0: number; dur: number }, s01: number): number {
  return b.t0 + b.dur * invCubicIO(Math.max(0, Math.min(1, s01)));
}

interface CanopyCandidate {
  x: number;
  y: number;
  r: number;
  rank: number;
  early: boolean;
  w: number;
  span: number;
  sx: number;
}

/**
 * Foliage clump centres, scattered through the whole dome with a minimum
 * spacing (seeded dart throwing). They do not depend on the data: a clump
 * shows once some branch reaches it and the richness passes its rank.
 */
let canopyCache: { seed: number; list: CanopyCandidate[] } | null = null;
function canopyCandidates(seed: number): CanopyCandidate[] {
  if (canopyCache?.seed === seed) return canopyCache.list;
  const R = mulberry32(seedOf(seed, 7));
  const rr = (a: number, b: number) => a + (b - a) * R();
  const list: CanopyCandidate[] = [];
  for (let i = 0; i < 6000 && list.length < 260; i += 1) {
    const ang = R() * TAU;
    const rad = Math.sqrt(R()) * 0.98;
    const x = CROWN.x + Math.cos(ang) * CROWN.rx * rad;
    const y = CROWN.y + Math.sin(ang) * CROWN.ry * rad * 1.02;
    const r = (R() < 0.25 ? rr(0.042, 0.058) : rr(0.022, 0.04)) * (1 - 0.22 * rad);
    const rank = R();
    const early = R() < 0.3;
    const w = rr(0.8, 1.4);
    const span = rr(0.9, 1.5);
    const sx = rr(1.05, 1.45);
    let ok = true;
    for (const q of list) {
      if (Math.hypot(q.x - x, q.y - y) < (q.r + r) * 0.98) {
        ok = false;
        break;
      }
    }
    if (ok) list.push({ x, y, r, rank, early, w, span, sx });
  }
  canopyCache = { seed, list };
  return list;
}

/**
 * Grow the tree for `spec`. Parts that cannot start yet (their data is not
 * in, or the richness has not reached them) are left out; a later spec with
 * more data adds them with start times in the future.
 */
export function generateTree(spec: TreeSpec, seed: number = TREE_SEED): TreeModel {
  const B: Branch[] = [];
  const clumps: Clump[] = [];
  const blossoms: Blossom[] = [];
  const anchors: LimbAnchor[] = [];
  const projAnchors: ProjectAnchor[] = [];
  if (spec.trunk === null || !Number.isFinite(spec.trunk)) return { branches: B, clumps, blossoms, anchors, projAnchors };

  function add(
    R: () => number,
    o: BranchOpts,
    meta: {
      kind: BranchKind;
      depth: number;
      t0: number;
      dur: number;
      limb?: number;
      project?: number;
      side?: number;
      gone?: number;
    },
  ): Branch {
    const g = makeBranch(R, o);
    const b: Branch = {
      id: B.length,
      pts: g.pts,
      len: g.len,
      t0: meta.t0,
      dur: meta.dur,
      kind: meta.kind,
      depth: meta.depth,
      limb: meta.limb ?? -1,
      project: meta.project ?? -1,
      side: meta.side ?? 0,
      gone: meta.gone ?? Infinity,
    };
    B.push(b);
    return b;
  }

  // Trunk: short and stout with a slight lean, flared at the ground in rasterize().
  const RT = mulberry32(seedOf(seed, 1));
  const trunk = add(
    RT,
    { x: 0, y: 0, ang: UP + 0.09, len: 0.25, w0: 0.125, w1: 0.082, trop: 0.9, bend: 0.14, wob: 0.004, taper: 1 },
    { kind: "trunk", depth: 0, t0: spec.trunk, dur: TRUNK_DUR },
  );

  // Roots, hinted under the ground line.
  const RR = mulberry32(seedOf(seed, 2));
  const rrR = (a: number, b: number) => a + (b - a) * RR();
  for (let i = 0; i < 7; i += 1) {
    const side = i % 2 ? 1 : -1;
    const opts: BranchOpts = {
      x: side * rrR(0.01, 0.04),
      y: 0.004,
      ang: Math.PI / 2 - side * rrR(0.7, 1.35),
      len: rrR(0.08, 0.17),
      w0: rrR(0.014, 0.028),
      w1: 0.002,
      trop: 0,
      bend: 0.14,
      wob: 0.03,
    };
    add(RR, opts, { kind: "root", depth: 5, t0: spec.trunk + 0.55 + i * 0.2, dur: rrR(1.6, 2.2) });
  }

  const d3: Array<{ b: Branch; key: number }> = [];

  /** Fine twigs grow outward from the crown's centre and stay inside the dome. */
  function twig(
    R: () => number,
    parent: Branch,
    s: number,
    da: number,
    lenK: number,
    depth: 3 | 4,
    theta: number,
  ): Branch | null {
    const p = branchAt(parent, s);
    const radial = Math.atan2(p.y - CROWN.y + 0.08, p.x - CROWN.x);
    const ang = p.a + angDiff(radial, p.a) * 0.35 + da;
    let len = parent.len * lenK;
    for (let k = 0; k < 8; k += 1) {
      const ex = p.x + Math.cos(ang) * len;
      const ey = p.y + Math.sin(ang) * len;
      const e = Math.hypot((ex - CROWN.x) / CROWN.rx, (ey - CROWN.y) / CROWN.ry);
      if (e <= 1.0) break;
      len *= 0.82;
    }
    const opts: BranchOpts = {
      x: p.x,
      y: p.y,
      ang,
      len,
      w0: Math.max(0.003, p.w * 0.7),
      w1: 0.002,
      toward: radial,
      trop: 0.5,
      bend: 0.2,
      wob: 0.035,
    };
    const t0 = Math.max(spec.richnessAt(theta), timeAt(parent, s) + 0.05);
    // Draw the geometry either way, so the stream stays in step for siblings.
    const g = makeBranch(R, opts);
    if (!Number.isFinite(t0)) return null;
    const b: Branch = {
      id: B.length,
      pts: g.pts,
      len: g.len,
      t0,
      dur: depth === 3 ? TWIG3_DUR : TWIG4_DUR,
      kind: "twig",
      depth,
      limb: parent.limb,
      project: -1,
      side: 0,
      gone: parent.gone,
    };
    B.push(b);
    return b;
  }

  const projectBranches: Branch[] = [];

  spec.limbs.forEach((L, li) => {
    const code = slotCode(L.slot);
    const R = mulberry32(seedOf(seed, 10, code));
    const rr = (a: number, b: number) => a + (b - a) * R();
    const limbGone = L.gone ?? Infinity;
    let limb: Branch;
    if (L.slot === "other") {
      const p = branchAt(trunk, OTHER_LIMB.s);
      const dir = aim(p, OTHER_LIMB.to);
      limb = add(
        R,
        {
          x: p.x,
          y: p.y,
          ang: dir - OTHER_LIMB.kick,
          len: dist(p, OTHER_LIMB.to),
          w0: OTHER_LIMB.w0,
          w1: 0.008,
          toward: dir + OTHER_LIMB.kick * 0.4,
          trop: 2.0,
          bend: 0.08,
          wob: 0.01,
          taper: 0.75,
        },
        { kind: "limb", depth: 1, t0: Math.max(L.ready, timeAt(trunk, OTHER_LIMB.s) - 0.1), dur: LIMB_DUR * 0.8, limb: li, gone: limbGone },
      );
    } else {
      const S = LIMB_SLOTS[Math.max(0, Math.min(LIMB_SLOTS.length - 1, L.slot))]!;
      const p = branchAt(trunk, S.s);
      const target = crownPt(S.phi * DEG, S.k);
      const dir = aim(p, target);
      limb = add(
        R,
        {
          x: p.x,
          y: p.y,
          ang: dir + S.kick,
          len: dist(p, target) * 1.08,
          w0: S.w0,
          w1: 0.012,
          toward: dir - S.kick * 0.6,
          trop: 2.4,
          bend: 0.1,
          wob: 0.01,
          taper: 0.75,
        },
        { kind: "limb", depth: 1, t0: Math.max(L.ready, timeAt(trunk, S.s) - 0.1), dur: LIMB_DUR, limb: li, gone: limbGone },
      );
    }

    // The company's blossom, high on its limb, where the callout starts.
    const anchorS = L.slot === "other" ? 0.92 : 0.84;
    const ap = branchAt(limb, anchorS);
    anchors.push({ x: ap.x, y: ap.y, limb: li, slot: L.slot, tg: timeAt(limb, anchorS) + 0.2, limbEnd: timeAt(limb, 1), gone: limbGone });

    // Project branches, each reaching for its own part of the limb's sector.
    const cap = L.slot === "other" ? MAX_OTHER_BRANCHES : MAX_PROJECT_BRANCHES;
    L.projects.slice(0, cap).forEach((project, j) => {
      const ready = project.ready;
      const projectGone = Math.min(project.gone ?? Infinity, limbGone);
      const RP = mulberry32(seedOf(seed, 20, code, j));
      const rp = (a: number, b: number) => a + (b - a) * RP();
      let s: number;
      let opts: BranchOpts;
      let side: number;
      if (L.slot === "other") {
        s = OTHER_PROJECT_S[j]! + rp(-0.03, 0.03);
        const p = branchAt(limb, s);
        side = j % 2 ? 1 : -1;
        const dir = p.a + side * rp(0.55, 0.85) - 0.2;
        opts = { x: p.x, y: p.y, ang: dir, len: rp(0.07, 0.1), w0: p.w * 0.66, w1: 0.005, toward: dir - 0.3, trop: 1.2, bend: 0.16, wob: 0.018 };
      } else {
        const S = LIMB_SLOTS[Math.max(0, Math.min(LIMB_SLOTS.length - 1, L.slot))]!;
        const P = PROJECT_SLOTS[j]!;
        s = P.s + rp(-0.03, 0.03);
        const p = branchAt(limb, s);
        const span = S.sector[1] - S.sector[0];
        const phi = (S.sector[0] + span * P.f + rp(-8, 8)) * DEG;
        const target = crownPt(phi, rp(0.9, 1.0));
        const dir = aim(p, target);
        side = angDiff(dir, p.a) < 0 ? -1 : 1;
        opts = {
          x: p.x,
          y: p.y,
          ang: dir - side * 0.12,
          len: dist(p, target) * 0.82,
          w0: p.w * 0.66,
          w1: 0.006,
          toward: dir,
          trop: 1.6,
          bend: 0.16,
          wob: 0.018,
        };
      }
      const pb = add(RP, opts, {
        kind: "project",
        depth: 2,
        t0: Math.max(ready, timeAt(limb, s)),
        dur: PROJECT_DUR,
        limb: li,
        project: j,
        side,
        gone: projectGone,
      });
      projectBranches.push(pb);
      const pa = branchAt(pb, 0.92);
      projAnchors.push({ x: pa.x, y: pa.y, a: pa.a, side, limb: li, project: j, done: timeAt(pb, 1), gone: projectGone });
    });

    // Depth-3 twigs off the limb's end.
    const RW = mulberry32(seedOf(seed, 30, code));
    const rw = (a: number, b: number) => a + (b - a) * RW();
    const limbTwigs: Array<[number, number, number]> = [
      [1, -rw(0.3, 0.5), rw(0.3, 0.38)],
      [1, rw(0.3, 0.5), rw(0.28, 0.36)],
      [rw(0.86, 0.92), (RW() < 0.5 ? -1 : 1) * rw(0.6, 0.9), rw(0.24, 0.3)],
    ];
    limbTwigs.forEach(([s, da, lenK], i) => {
      const theta = 0.04 + 0.3 * RW();
      const b = twig(RW, limb, s, da, lenK, 3, theta);
      if (b) d3.push({ b, key: seedOf(code, 1, i) });
    });
  });

  // Depth-3 twigs off every project branch.
  for (const pb of projectBranches) {
    const code = slotCode(spec.limbs[pb.limb]!.slot);
    const R = mulberry32(seedOf(seed, 31, code, pb.project));
    const rr = (a: number, b: number) => a + (b - a) * R();
    const twigs: Array<[number, number, number]> = [
      [rr(0.36, 0.48), rr(0.55, 0.8), rr(0.42, 0.52)],
      [rr(0.6, 0.72), -rr(0.55, 0.8), rr(0.4, 0.5)],
      [1, -rr(0.25, 0.42), rr(0.38, 0.48)],
      [1, rr(0.25, 0.42), rr(0.36, 0.46)],
    ];
    twigs.forEach(([s, da, lenK], i) => {
      const theta = 0.08 + 0.34 * R();
      const b = twig(R, pb, s, da, lenK, 3, theta);
      if (b) d3.push({ b, key: seedOf(code, 2, pb.project, i) });
    });
  }

  // Depth-4 twigs off every depth-3 twig.
  const d4: Branch[] = [];
  for (const { b, key } of d3) {
    const R = mulberry32(seedOf(seed, 40, key));
    const rr = (a: number, c: number) => a + (c - a) * R();
    const twigs: Array<[number, number, number]> = [
      [rr(0.45, 0.6), (R() < 0.5 ? -1 : 1) * rr(0.5, 0.8), rr(0.42, 0.55)],
      [1, -rr(0.25, 0.45), rr(0.45, 0.6)],
      [1, rr(0.25, 0.45), rr(0.42, 0.58)],
    ];
    for (const [s, da, lenK] of twigs) {
      const theta = 0.4 + 0.42 * R();
      const t = twig(R, b, s, da, lenK, 4, theta);
      if (t) d4.push(t);
    }
  }

  // Foliage is a set of clumps, not loose leaves.
  const clump = (
    x: number,
    y: number,
    sig: number,
    w: number,
    tg: number,
    span: number,
    kind: "bud" | "leaf",
    sx: number,
    gone: number,
  ) => {
    if (!Number.isFinite(tg)) return;
    clumps.push({ id: clumps.length, x, y, sig, w, tg, span, kind, sx, gone });
  };
  // Small buds along each project branch.
  for (const pb of projectBranches) {
    const R = mulberry32(seedOf(seed, 50, slotCode(spec.limbs[pb.limb]!.slot), pb.project));
    for (const s of [0.5, 0.8, 1]) {
      const p = branchAt(pb, s);
      clump(p.x, p.y, 0.008, 0.85, timeAt(pb, s) + 0.25, 0.6, "bud", 1.05 + 0.4 * R(), pb.gone);
    }
  }
  // First small clumps at the depth-3 tips.
  for (const { b, key } of d3) {
    const R = mulberry32(seedOf(seed, 51, key));
    const p = branchAt(b, 1);
    clump(p.x, p.y, 0.01 + 0.004 * R(), 0.7 + 0.3 * R(), timeAt(b, 1) + 0.15, 1.0, "leaf", 1.05 + 0.4 * R(), b.gone);
  }
  // Twig ends stay leafy.
  for (const b of d4) {
    const p = branchAt(b, 1);
    clump(p.x, p.y, 0.009, 0.6, timeAt(b, 1) + 0.1, 0.8, "leaf", 1.05 + 0.4 * hash(b.pts[0]!.x * 91.7 + b.pts[0]!.y * 13.1), b.gone);
  }
  // The canopy: dome clumps that some branch reaches, in order of their rank.
  const carriers: Array<{ x: number; y: number; t: number; depth: number; gone: number }> = [];
  for (const b of B) {
    if (b.depth < 2 || b.depth > 4) continue;
    for (let i = 0; i < b.pts.length; i += 3) {
      const p = b.pts[i]!;
      carriers.push({ x: p.x, y: p.y, t: timeAt(b, p.s / b.len), depth: b.depth, gone: b.gone });
    }
  }
  if (carriers.length) {
    const reach2 = 0.075 * 0.075;
    for (const c of canopyCandidates(seed)) {
      const reaching = carriers
        .filter((k) => (k.x - c.x) ** 2 + (k.y - c.y) ** 2 <= reach2)
        .sort((p, q) => p.t - q.t);
      if (!reaching.length) continue;
      const carry = reaching[0]!.t;
      // The clump stays while the branches that reach it keep it covered, from
      // its first carrier on. A branch that only arrives after it withered
      // grows its own foliage; it never brings this clump back.
      let gone = -Infinity;
      for (const k of reaching) {
        if (k.t > gone && Number.isFinite(gone)) break;
        if (k.gone > gone) gone = k.gone;
      }
      // The threshold is the clump's own (never which branch is nearest, which
      // new data can change), so a clump's second never moves once known.
      const theta = c.early ? 0.16 + 0.2 * c.rank : 0.3 + 0.7 * c.rank;
      const tg = Math.max(carry + 0.2, spec.richnessAt(theta));
      clump(c.x, c.y, c.r * 0.6, c.w, tg, c.span, "leaf", c.sx, gone);
    }
  }

  // Coral-peach blossoms at the depth-3 tips, opening as the richness grows.
  for (const { b, key } of d3) {
    const R = mulberry32(seedOf(seed, 60, key));
    const has = R() < 0.85;
    const s = 0.75 + 0.25 * R();
    const g1 = (R() + R() + R() - 1.5) / 0.5;
    const g2 = (R() + R() + R() - 1.5) / 0.5;
    const theta = 0.26 + 0.74 * R();
    const hue = R();
    if (!has) continue;
    const tg = Math.max(timeAt(b, 1) + 0.1, spec.richnessAt(theta));
    if (!Number.isFinite(tg)) continue;
    const p = branchAt(b, s);
    blossoms.push({ x: p.x + g1 * 0.012, y: p.y + g2 * 0.01, tg, limb: b.limb, hue, key, gone: b.gone });
  }
  blossoms.sort((p, q) => p.tg - q.tg || p.key - q.key);

  return { branches: B, clumps, blossoms, anchors, projAnchors };
}

/** The tree the preview drew (three companies, three projects each, a full crown): the scale reference. */
export function referenceSpec(): TreeSpec {
  return {
    trunk: 0,
    limbs: [0, 1, 2].map((slot) => ({ slot, ready: 0, projects: [{ ready: 0 }, { ready: 0 }, { ready: 0 }] })),
    richnessAt: () => 0,
  };
}

// ── rasterisation ───────────────────────────────────────────────────────────

export interface TreeBox {
  /** Seed x in px. */
  sx: number;
  /** Ground y in px. */
  gy: number;
  left: number;
  right: number;
  top: number;
}

export interface BranchCell {
  c: number;
  r: number;
  x: number;
  y: number;
  rank: number;
  tg: number;
  rel: number;
  halfC: number;
  fk: number;
  depth: number;
  kind: BranchKind;
  t0: number;
  line: string;
  edge: string;
  bark: string;
  h: number;
  gone: number;
  /**
   * The earlier glyph this cell showed before a later, stronger part (a limb
   * grown through a twig) took it: drawn until `tg`, so new data never
   * removes a glyph that is already on screen.
   */
  under: BranchCell | null;
  /** Foliage covers this twig glyph from this second on (Infinity: never). */
  hiddenAt: number;
  /** min(tg, under.tg): when anything in this cell first shows. Branch lists are sorted on it. */
  first: number;
}

/** The glyph a branch cell shows at second t, or null (not grown yet, or under foliage). */
export function branchCellAt(cell: BranchCell, t: number): BranchCell | null {
  let shown: BranchCell | null = cell;
  if (t < cell.tg) shown = cell.under && t >= cell.under.tg ? cell.under : null;
  if (!shown || t >= shown.hiddenAt) return null;
  return shown;
}

export interface LeafCell {
  c: number;
  r: number;
  x: number;
  y: number;
  tg: number;
  ch: string;
  a: number;
  h: number;
  bud: boolean;
  key: number;
  gone: number;
  /** A limb grows through this cell at this second, and the leaf gives way (Infinity: never). */
  until: number;
  /** The glyph over time: each entry holds from its `tg` until the next one's. */
  versions: LeafVersion[];
}

export interface LeafVersion {
  tg: number;
  ch: string;
  a: number;
  x: number;
  y: number;
  bud: boolean;
  gone: number;
}

/** The glyph a leaf cell shows at second t (null before it opens or after a limb grows through). */
export function leafVersionAt(leaf: LeafCell, t: number): LeafVersion | null {
  if (t < leaf.tg || t >= leaf.until) return null;
  let shown: LeafVersion | null = null;
  for (const v of leaf.versions) {
    if (v.tg > t) break;
    shown = v;
  }
  return shown;
}

export interface BlossomCell {
  x: number;
  y: number;
  tg: number;
  hue: number;
  limb: number;
  i: number;
  ch: string;
  key: number;
  gone: number;
}

export interface TreeRaster {
  cell: number;
  scale: number;
  sx: number;
  gy: number;
  groundRow: number;
  treeH: number;
  /** Sorted by tg. */
  branches: BranchCell[];
  /** Sorted by tg. */
  leaves: LeafCell[];
  /** Sorted by tg. */
  blossoms: BlossomCell[];
  anchors: LimbAnchor[];
  projAnchors: ProjectAnchor[];
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
}

function modelBounds(model: TreeModel): Bounds {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  for (const b of model.branches) {
    if (b.kind === "root") continue;
    for (const p of b.pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
    }
  }
  for (const k of model.clumps) {
    if (k.x - k.sig * 2.2 * k.sx < minX) minX = k.x - k.sig * 2.2 * k.sx;
    if (k.x + k.sig * 2.2 * k.sx > maxX) maxX = k.x + k.sig * 2.2 * k.sx;
    if (k.y - k.sig * 2.2 < minY) minY = k.y - k.sig * 2.2;
  }
  return { minX, maxX, minY };
}

let referenceBounds: { seed: number; bounds: Bounds } | null = null;
function referenceBoundsFor(seed: number): Bounds {
  if (referenceBounds?.seed === seed) return referenceBounds.bounds;
  const bounds = modelBounds(generateTree(referenceSpec(), seed));
  referenceBounds = { seed, bounds };
  return bounds;
}

/** px per unit, from the reference tree, so the drawing never changes size as limbs arrive. */
export function treeScale(box: TreeBox, seed: number = TREE_SEED): number {
  const b = referenceBoundsFor(seed);
  return Math.max(
    40,
    Math.min((box.gy - box.top) / -b.minY, (box.sx - box.left) / -b.minX, (box.right - box.sx) / b.maxX),
  );
}

function glyphFor(dx: number, dy: number, h: number): string {
  // Orientation of a stroke in screen space, 0..180 degrees.
  let o = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (o < 0) o += 180;
  if (o >= 180) o -= 180;
  if (o >= 74 && o <= 106) return "|";
  if (o > 22 && o < 74) return "/";
  if (o > 106 && o < 158) return "\\";
  return h < 0.3 ? "~" : "-";
}

/** Map the unit-space tree onto the character grid at a window size. */
export function rasterizeTree(model: TreeModel, box: TreeBox, opts: { cell?: number; scale?: number; seed?: number } = {}): TreeRaster {
  const CELLPX = opts.cell ?? CELL;
  const scale = opts.scale ?? treeScale(box, opts.seed);
  const B = model.branches;
  const gcol = Math.round(box.sx / CELLPX - 0.5);
  const sx = gcol * CELLPX + CELLPX / 2;
  const groundRow = Math.round(box.gy / CELLPX - 0.5);
  const gy = groundRow * CELLPX + CELLPX / 2;
  const px = (x: number) => sx + x * scale;
  const py = (y: number) => gy - CELLPX * 0.5 + y * scale;
  const ref = referenceBoundsFor(opts.seed ?? TREE_SEED);

  const cells = new Map<number, BranchCell>();
  const key = (c: number, r: number) => c * 4096 + r;

  for (const b of B) {
    const pts = b.pts;
    const isRoot = b.kind === "root";
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      const segLen = Math.hypot(q.x - p.x, q.y - p.y) * scale;
      const steps = Math.max(1, Math.ceil(segLen / (CELLPX * 0.22)));
      for (let k = 0; k < steps; k += 1) {
        const f = k / steps;
        const ux = p.x + (q.x - p.x) * f;
        const uy = p.y + (q.y - p.y) * f;
        const s01 = (p.s + (q.s - p.s) * f) / b.len;
        let w = (p.w + (q.w - p.w) * f) * scale;
        let fk = 1;
        if (b.kind === "trunk") {
          const kk = Math.max(0, 1 - s01 / 0.2);
          fk = 1 + 0.5 * kk * kk * (3 - 2 * kk) * kk;
          w *= fk;
        }
        const X = px(ux);
        const Y = py(uy);
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const dl = Math.hypot(dx, dy) || 1;
        const tx = dx / dl;
        const ty = dy / dl;
        const nx = -ty;
        const ny = tx;
        const half = w / 2;
        // width change along the branch, for edge orientation
        const dw = ((q.w - p.w) * scale) / (dl * scale || 1);
        const tg = timeAt(b, s01);
        const thin = half < CELLPX * 0.75;
        const reach = thin ? 0 : Math.ceil(half / CELLPX) + 1;
        const c0 = Math.round(X / CELLPX - 0.5);
        const r0 = Math.round(Y / CELLPX - 0.5);
        for (let dc = -reach; dc <= reach; dc += 1) {
          for (let dr = -reach; dr <= reach; dr += 1) {
            const c = c0 + dc;
            const r = r0 + dr;
            if (!isRoot && r >= groundRow) continue;
            if (isRoot && r <= groundRow) continue;
            const cx = c * CELLPX + CELLPX / 2;
            const cy = r * CELLPX + CELLPX / 2;
            const ox = cx - X;
            const oy = cy - Y;
            const perp = ox * nx + oy * ny;
            const d = Math.hypot(ox, oy);
            if (!thin && d > half + CELLPX * 0.15) continue;
            const k2 = key(c, r);
            const prev = cells.get(k2);
            // a withering part never hides a living one
            const rank = b.depth * 1000 + d + (Number.isFinite(b.gone) ? 500 : 0);
            // A weaker candidate that shows earlier stays as the glyph under it.
            if (prev && prev.rank <= rank && (tg >= prev.tg || (prev.under && tg >= prev.under.tg))) continue;
            const rel = thin ? 0 : Math.max(-1, Math.min(1, perp / Math.max(1, half)));
            const halfC = half / CELLPX;
            const sideSign = perp < 0 ? -1 : 1;
            const ex = tx + nx * sideSign * dw * 0.5;
            const ey = ty + ny * sideSign * dw * 0.5;
            const hsh = hash2(c, r);
            const line = glyphFor(tx, ty, hsh);
            let edge = glyphFor(ex, ey, hsh);
            if (edge === "|" && hash2(c * 3.1, r * 0.7) < 0.34) edge = sideSign < 0 ? "(" : ")";
            let bark: string;
            const streak = hash2(c * 1.7, Math.floor(r / 3) * 2.3);
            if (line === "|") bark = streak < 0.5 ? "|" : streak < 0.72 ? ":" : streak < 0.86 ? "'" : ".";
            else bark = streak < 0.65 ? line : streak < 0.85 ? ":" : ".";
            const cand: BranchCell = {
              c,
              r,
              x: cx,
              y: cy,
              rank,
              tg,
              rel,
              halfC,
              fk,
              depth: b.depth,
              kind: b.kind,
              t0: b.t0,
              line,
              edge,
              bark,
              h: hsh,
              gone: b.gone,
              under: null,
              hiddenAt: Infinity,
              first: tg,
            };
            if (prev && prev.rank <= rank) {
              // weaker but earlier: it shows until the stronger glyph grows in
              prev.under = cand;
              prev.first = Math.min(prev.tg, tg);
              continue;
            }
            if (prev) {
              // stronger: whatever showed earlier stays under it until it grows in
              const earlier = [prev, prev.under]
                .filter((x): x is BranchCell => !!x && x.tg < tg)
                .sort((p, q) => p.tg - q.tg)[0];
              if (earlier) {
                cand.under = { ...earlier, under: null, first: earlier.tg };
                cand.first = earlier.tg;
              }
            }
            cells.set(k2, cand);
          }
        }
      }
    }
  }

  // Foliage: sum each clump's density onto the grid. A cell's glyph is a
  // function of the clumps that have opened there by second t: it appears
  // once their summed density passes the threshold, and the strongest open
  // clump owns it (its light, its sub-cell offset). Each change is a version
  // with its own second, so a clump that arrives later only ever adds
  // versions after it opens and never changes a glyph already on screen.
  interface Contribution {
    k: Clump;
    v: number;
    q: number;
    dx: number;
    dy: number;
    open: number;
  }
  const field = new Map<number, { c: number; r: number; x: number; y: number; list: Contribution[] }>();
  for (const k of model.clumps) {
    const X = px(k.x);
    const Y = py(k.y);
    const sy = k.sig * scale;
    const sxp = sy * k.sx;
    const c0 = Math.floor((X - sxp * 3) / CELLPX);
    const c1 = Math.ceil((X + sxp * 3) / CELLPX);
    const r0 = Math.floor((Y - sy * 3) / CELLPX);
    const r1 = Math.ceil((Y + sy * 3) / CELLPX);
    for (let c = c0; c <= c1; c += 1) {
      for (let r = r0; r <= Math.min(r1, groundRow - 1); r += 1) {
        const cx = c * CELLPX + CELLPX / 2;
        const cy = r * CELLPX + CELLPX / 2;
        const dx = (cx - X) / sxp;
        const dy = (cy - Y) / sy;
        const q = (dx * dx + dy * dy) / 2;
        if (q > 4.5) continue;
        const k2 = key(c, r);
        let f = field.get(k2);
        if (!f) {
          f = { c, r, x: cx, y: cy, list: [] };
          field.set(k2, f);
        }
        // clumps open from their core outward
        const h = hash2(c * 0.37, r * 1.9);
        const open = k.tg + k.span * Math.min(1, Math.sqrt(q) / 2.1) * (0.65 + 0.35 * h);
        f.list.push({ k, v: k.w * Math.exp(-q), q, dx, dy, open });
      }
    }
  }
  const leafList: LeafCell[] = [];
  for (const f of field.values()) {
    // soft, irregular outer edge of the whole crown
    const ux = ((f.x - sx) / scale - CROWN.x) / CROWN.rx;
    const uy = ((f.y - gy + CELLPX * 0.5) / scale - CROWN.y) / CROWN.ry;
    const phi = Math.atan2(uy, ux);
    const e = Math.hypot(ux, uy) / (1.08 + 0.07 * Math.sin(phi * 3 + 1.3) + 0.05 * Math.sin(phi * 5 + 0.4));
    const env = 1 - Math.max(0, Math.min(1, (e - 0.9) / 0.22));
    const h = hash2(f.c * 0.37, f.r * 1.9);
    const pick = (set: string, salt: number) => set[Math.floor(hash2(f.c * 7.7 + salt, f.r * 3.3) * set.length)] ?? ".";
    const top = Math.max(-1, Math.min(1, -uy));
    f.list.sort((p, q) => p.open - q.open || p.k.x - q.k.x || p.k.y - q.k.y);
    const versions: LeafVersion[] = [];
    let sum = 0;
    let best: Contribution | null = null;
    let gone = -Infinity;
    for (const item of f.list) {
      sum += item.v;
      if (!best || item.v > best.v) best = item;
      if (item.k.gone > gone) gone = item.k.gone;
      // Clumps outside the dome (the small "other" limb) keep their own density.
      const d = sum * (e > 1.2 ? 1 : env) + (h - 0.5) * 0.1;
      if (d < 0.44) continue;
      const gl = Math.hypot(best.dx, best.dy) || 1;
      const facing = ((-0.55 * best.dx - 0.83 * best.dy) / gl) * Math.min(1, gl / 1.2);
      const lit = Math.max(0, Math.min(1, 0.5 + 0.32 * facing + 0.18 * top));
      let ch: string;
      let a: number;
      if (d > 0.88) {
        ch = lit > 0.58 ? pick("**+*", 1) : lit > 0.4 ? pick(":*:", 2) : pick(":.:", 6);
        a = 0.82;
      } else if (d > 0.56) {
        ch = lit > 0.58 ? pick("*:'", 3) : pick(":.'", 4);
        a = 0.6;
      } else {
        ch = pick(".,'`.", 5);
        a = 0.3;
      }
      if (best.k.kind === "bud") a *= 0.9;
      const version: LeafVersion = {
        tg: item.open,
        ch,
        a: Math.min(0.95, a * (0.5 + 0.8 * lit) + h * 0.06),
        x: f.x + (hash(best.k.x * 991 + best.k.y * 37) - 0.5) * 5,
        y: f.y + (hash(best.k.x * 113 + best.k.y * 577) - 0.5) * 4,
        bud: best.k.kind === "bud",
        gone,
      };
      const last = versions[versions.length - 1];
      if (last && last.ch === version.ch && last.a === version.a && last.x === version.x && last.gone === version.gone) continue;
      if (last && last.tg === version.tg) versions[versions.length - 1] = version;
      else versions.push(version);
    }
    const first = versions[0];
    if (!first) continue;
    const br = cells.get(key(f.c, f.r));
    // never paint over a limb: a leaf in its path shows until the limb grows in
    const until = br && br.depth <= 2 && br.halfC > 0.6 ? br.tg : Infinity;
    if (until <= first.tg) continue;
    leafList.push({
      c: f.c,
      r: f.r,
      x: first.x,
      y: first.y,
      tg: first.tg,
      ch: first.ch,
      a: first.a,
      h,
      bud: first.bud,
      key: key(f.c, f.r),
      gone: versions[versions.length - 1]!.gone,
      until,
      versions,
    });
    // foliage hides the twig under it, from when it opens
    if (br && br.depth >= 3) br.hiddenAt = Math.min(br.hiddenAt, first.tg);
    if (br?.under && br.under.depth >= 3) br.under.hiddenAt = Math.min(br.under.hiddenAt, first.tg);
  }

  const branchList = Array.from(cells.values());
  branchList.sort((a, b) => a.first - b.first || a.c - b.c || a.r - b.r);
  leafList.sort((a, b) => a.tg - b.tg || a.key - b.key);

  const blossoms: BlossomCell[] = model.blossoms.map((bl, i) => ({
    x: px(bl.x),
    y: py(bl.y),
    tg: bl.tg,
    hue: bl.hue,
    limb: bl.limb,
    i,
    ch: hash(bl.key * 0.0001 + 3.7) < 0.8 ? "*" : "+",
    key: bl.key,
    gone: bl.gone,
  }));
  const anchors = model.anchors.map((a) => ({ ...a, x: px(a.x), y: py(a.y) }));
  const projAnchors = model.projAnchors.map((a) => ({ ...a, x: px(a.x), y: py(a.y) }));

  return {
    cell: CELLPX,
    scale,
    sx,
    gy,
    groundRow,
    treeH: -ref.minY * scale,
    branches: branchList,
    leaves: leafList,
    blossoms,
    anchors,
    projAnchors,
  };
}

/** Crown extents in px of a raster's leaves (the reference tree's, for callouts and the ground). */
export function crownExtents(raster: TreeRaster): { minX: number; maxX: number; minY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  for (const l of raster.leaves) {
    if (l.x < minX) minX = l.x;
    if (l.x > maxX) maxX = l.x;
    if (l.y < minY) minY = l.y;
  }
  if (!Number.isFinite(minX)) return { minX: raster.sx, maxX: raster.sx, minY: raster.gy - raster.treeH };
  return { minX, maxX, minY };
}
