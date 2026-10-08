/**
 * Drawing the "Bring in your context" scene on a 2D canvas.
 *
 * A faithful port of the approved preview's drawCanvas (app.js): the ASCII
 * ground line and soil, the seed of gathering dust, the tree's branch cells
 * with their growth-front glow and bark, foliage clumps, coral-peach
 * blossoms, the company blossoms with hairline leaders, dust lifting from the
 * source rows into the growth front, ambient dust, and the settled sway.
 *
 * `drawScene` is a pure function of (layout, plan, t): it reads no clock and
 * no randomness. The layout (`buildSceneLayout`) is a pure function of the
 * window size, the plan and the rasterised tree. The component only advances
 * a clock and calls `drawScene`.
 */

import { clamp01, cubicIO, easeInOut, easeOut, hash2, lerp, mulberry32, smooth } from "./tree-math.js";
import { FONT_PX, branchCellAt, leafVersionAt, type TreeBox, type TreeRaster, type LimbSlot } from "./tree-model.js";
import { feedingRow, richnessValue, type ScenePlan } from "./scene-model.js";

/** Scene seconds of the intro beats, from the moment the step opens (preview T). */
export const INTRO = {
  wordmark: 0.15,
  kicker: 0.35,
  title: 0.53,
  body: 0.67,
  ground: [0.9, 1.9] as const,
  seed: [0.7, 1.3] as const,
  consent: 0.95,
} as const;

export const MONO_FONT = '"Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace';
export const SAFE = 48;

export interface SceneGeometry {
  W: number;
  H: number;
  colLeft: number;
  colTop: number;
  colW: number;
  hSize: number;
  rowsGap: number;
  groundY: number;
  footTop: number;
  box: TreeBox;
}

/** Column and tree box from the window size (preview layout()). */
export function sceneGeometry(W: number, H: number): SceneGeometry {
  const colLeft = Math.round(Math.max(56, Math.min(104, W * 0.068)));
  const colTop = Math.round(Math.max(84, H * 0.15));
  const colW = Math.round(Math.min(452, W * 0.335));
  const hSize = Math.round(Math.max(40, Math.min(56, W / 25, H / 16.4)));
  const rowsGap = Math.round(Math.max(28, Math.min(48, H * 0.048)));
  const groundY = Math.round(H - Math.max(92, H * 0.135));
  const colRight = colLeft + colW;
  const left = colRight + Math.max(64, W * 0.05);
  const right = W - Math.max(48, W * 0.04);
  return {
    W,
    H,
    colLeft,
    colTop,
    colW,
    hSize,
    rowsGap,
    groundY,
    footTop: groundY - 44,
    box: { sx: Math.round((left + right) / 2), gy: groundY, left, right, top: Math.max(70, H * 0.1) },
  };
}

interface Dust {
  x: number;
  y: number;
  v: number;
  ph: number;
  a: number;
  r: number;
}
interface SeedPt {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  dl: number;
  ph: number;
  a: number;
  r: number;
}
interface GroundGlyph {
  x: number;
  y: number;
  ch: string;
  a: number;
  d: number;
}
export interface FeedParticle {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  dep: number;
  fl: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  ph: number;
  a: number;
  r: number;
  coral: number | null;
}

export interface CalloutBase {
  lx: number;
  ly: number;
  side: "left" | "right" | "top";
}

export interface RowBox {
  x: number;
  y: number;
  w: number;
}

export interface SceneLayout {
  geo: SceneGeometry;
  raster: TreeRaster;
  feed: FeedParticle[];
  /** Per limb index of the plan. */
  callouts: CalloutBase[];
  crown: { minX: number; maxX: number; minY: number };
}

/** Layout pieces that only depend on the window and the reference tree. */
export interface StaticLayout {
  dust: Dust[];
  seed: SeedPt[];
  ground: GroundGlyph[];
  soil: GroundGlyph[];
}

export function buildStaticLayout(geo: SceneGeometry, raster: TreeRaster, crown: { minX: number; maxX: number }): StaticLayout {
  const { W, H } = geo;
  const R = mulberry32(77);
  const dust: Dust[] = [];
  const n = Math.round((W * H) / 5200);
  for (let i = 0; i < n; i += 1) {
    dust.push({ x: R() * W, y: R() * H, v: 3 + R() * 7, ph: R() * 6.283, a: 0.05 + R() * R() * 0.32, r: R() < 0.08 ? 1.6 : 1 });
  }

  const RS = mulberry32(5);
  const seed: SeedPt[] = [];
  for (let i = 0; i < 96; i += 1) {
    const ang = RS() * 6.283;
    const far = 60 + RS() * 260;
    const g = (RS() + RS() + RS() - 1.5) / 0.5;
    const g2 = (RS() + RS() + RS() - 1.5) / 0.5;
    seed.push({
      sx: raster.sx + Math.cos(ang) * far * 1.3,
      sy: raster.gy - 40 + Math.sin(ang) * far * 0.6,
      tx: raster.sx + g * 5.2,
      ty: raster.gy - raster.cell * 0.9 + g2 * 2.6,
      dl: RS() * 0.7,
      ph: RS() * 6.283,
      a: 0.65 + RS() * 0.35,
      r: RS() < 0.22 ? 1.6 : 1.1,
    });
  }

  const ground: GroundGlyph[] = [];
  const soil: GroundGlyph[] = [];
  const CELLPX = raster.cell;
  const g = raster.groundRow;
  const x0 = Math.max(raster.sx - 520, crown.minX - 140);
  const x1 = Math.min(W - 24, crown.maxX + 150);
  const c0 = Math.round(x0 / CELLPX);
  const c1 = Math.round(x1 / CELLPX);
  const sc = Math.round(raster.sx / CELLPX - 0.5);
  for (let c = c0; c <= c1; c += 1) {
    const x = c * CELLPX + CELLPX / 2;
    const h = hash2(c * 1.3, 7.7);
    const d = Math.abs(c - sc);
    const edge = Math.min(1, (c - c0) / 14, (c1 - c) / 14);
    let ch = h < 0.62 ? "_" : h < 0.76 ? "." : h < 0.88 ? "," : "-";
    if (d <= 1) ch = "_";
    ground.push({ x, y: g * CELLPX + CELLPX / 2, ch, a: (0.2 + 0.42 * Math.exp(-((d / 26) ** 2))) * Math.max(0, edge), d });
    // soil specks under the line, densest near the trunk
    for (let r = 1; r <= 7; r += 1) {
      const hh = hash2(c * 2.9, r * 5.3);
      const near = Math.exp(-((d / (16 + r * 3)) ** 2));
      if (hh > 0.12 + 0.5 * near) continue;
      soil.push({
        x,
        y: (g + r) * CELLPX + CELLPX / 2,
        ch: hh < 0.2 ? ":" : hh < 0.42 ? "." : ",",
        a: (0.05 + 0.13 * near) * (1 - r / 9) * Math.max(0, edge),
        d,
      });
    }
  }
  return { dust, seed, ground, soil };
}

/**
 * Dust lifts from a row and flies into the tree, landing on a cell just as
 * that cell appears (createMarkEngine's converge, aimed at the growth front).
 * Each particle belongs to one tree cell and is fixed by that cell's hash, so
 * new data adds particles without moving any that are already in the air.
 * It leaves from the row that was feeding the tree when it took off.
 */
export function buildFeed(raster: TreeRaster, plan: ScenePlan, rowBoxes: readonly RowBox[]): FeedParticle[] {
  const feed: FeedParticle[] = [];
  if (!plan.rows.length) return feed;
  const add = (tx: number, ty: number, tg: number, salt: number, coral: number | null) => {
    const h = (k: number) => hash2(tx * 0.731 + salt * 1.37 + k * 17.1, ty * 0.519 + k * 3.3 + salt);
    const arrive = tg - 0.04;
    let fl = 1.5 + h(1) * 0.9;
    let dep = arrive - fl;
    let row = feedingRow(plan, dep);
    if (row < 0) {
      row = 0;
      const earliest = plan.rows[0]!.appear + 0.45 + h(2) * 0.7;
      if (dep < earliest) {
        dep = earliest;
        fl = arrive - dep;
      }
    }
    if (fl < 0.9) return;
    const box = rowBoxes[row];
    if (!box) return;
    const sx = box.x + h(3) * box.w;
    const sy = box.y + (h(4) - 0.5) * 10;
    feed.push({
      sx,
      sy,
      tx,
      ty,
      dep,
      fl,
      c1x: sx + 30 + h(5) * 120,
      c1y: sy - 50 - h(6) * 110,
      c2x: tx - 60 - h(7) * 140,
      c2y: ty - 40 - h(8) * 160,
      ph: h(9) * 6.283,
      a: 0.6 + h(10) * 0.4,
      r: h(11) < 0.16 ? 1.6 : 1.1,
      coral,
    });
  };
  for (const c of raster.branches) {
    if (c.kind === "root") continue;
    if (!(c.halfC < 1 || Math.abs(c.rel) < 0.4)) continue;
    if (hash2(c.c * 5.31, c.r * 2.17) >= 0.24) continue;
    add(c.x, c.y, c.tg, 1, null);
  }
  for (const l of raster.leaves) {
    if (hash2(l.c * 3.71, l.r * 4.13) >= 0.085) continue;
    add(l.x, l.y, l.tg, 2, null);
  }
  for (const b of raster.blossoms) {
    add(b.x, b.y, b.tg, 3, b.hue);
    add(b.x, b.y, b.tg, 4, b.hue);
  }
  feed.sort((a, b) => a.dep - b.dep);
  return feed;
}

function nearLeaves(reference: TreeRaster, x0: number, x1: number, fn: (a: number, b: number) => number): number | null {
  let v: number | null = null;
  for (const l of reference.leaves) if (l.x >= x0 && l.x <= x1) v = v == null ? l.y : fn(v, l.y);
  return v;
}

/**
 * Botanical-plate callouts. The left and right limbs hang theirs below their
 * side of the crown, in the clear air beside the trunk; the leader's sits
 * above. Positions come from the full reference crown, so a label never
 * moves as the crown fills in. Inside a 48px safe margin.
 */
export function buildCallouts(
  raster: TreeRaster,
  reference: TreeRaster,
  W: number,
  widths: readonly number[],
): CalloutBase[] {
  return raster.anchors.map((a, i) => {
    const w = widths[i] ?? 120;
    const slot: LimbSlot = a.slot;
    if (slot === 0 || slot === 4) {
      const top = nearLeaves(reference, a.x - 20, a.x + 90, Math.min);
      const lx = Math.min(a.x + 34, W - SAFE - w);
      return { lx, ly: (top == null ? a.y - 60 : top) - 36, side: "top" };
    }
    if (slot === 3) {
      const top = nearLeaves(reference, a.x - 90, a.x + 20, Math.min);
      const lx = Math.max(a.x - 34 - w, SAFE);
      return { lx, ly: (top == null ? a.y - 60 : top) - 30, side: "top" };
    }
    if (slot === "other") {
      return { lx: Math.min(a.x + 26, W - SAFE - w), ly: Math.min(a.y + 30, raster.gy - 28), side: "right" };
    }
    const low = nearLeaves(reference, a.x - 70, a.x + 70, Math.max);
    const ly = Math.min((low == null ? a.y + 40 : low) + 22, raster.gy - 40);
    const lx = slot === 1 ? Math.max(a.x - 22, SAFE + w) : Math.min(a.x + 22, W - SAFE - w);
    return { lx, ly, side: slot === 1 ? "left" : "right" };
  });
}

// ── sway ────────────────────────────────────────────────────────────────────

/** Small while growing, a full slow sway once settled (or once a failed scan stops). */
export function swayAmp(plan: ScenePlan, t: number): number {
  const rest = plan.settle ?? (plan.failure ? plan.lastBeat : null);
  return 0.35 + (rest === null ? 0 : 0.65 * smooth((t - rest + 1) / 4));
}

export function swayAt(raster: TreeRaster, y: number, t: number, amp: number): number {
  if (y >= raster.gy) return 0;
  const h = clamp01((raster.gy - y) / raster.treeH);
  const k = Math.pow(h, 1.7);
  return amp * k * (2.1 * Math.sin(t * 0.52 + 0.4) + 0.7 * Math.sin(t * 1.21 + h * 2.6));
}

/** A part that moved (or whose limb emptied) fades out over 0.9 s. */
export const WITHER_DUR = 0.9;
export function witherAt(gone: number, t: number): number {
  return t <= gone ? 1 : 1 - smooth((t - gone) / WITHER_DUR);
}

export function coral(k: number): string {
  // #ff809f -> #ffb580
  const g = Math.round(128 + (181 - 128) * k);
  const b = Math.round(159 + (128 - 159) * k);
  return `rgb(255,${g},${b})`;
}

/** When a limb's callout starts (its limb has grown out). */
export function calloutTime(raster: TreeRaster, i: number): number {
  return (raster.anchors[i]?.limbEnd ?? Infinity) + 0.15;
}

/** Where a limb's callout sits at second t. The leader's starts low and rises with the crown. */
export function calloutGeom(
  layout: Pick<SceneLayout, "raster" | "callouts">,
  plan: ScenePlan,
  i: number,
  t: number,
): { ax: number; ay: number; lx: number; ly: number; side: CalloutBase["side"] } | null {
  const a = layout.raster.anchors[i];
  const base = layout.callouts[i];
  if (!a || !base) return null;
  if (base.side !== "top") return { ax: a.x, ay: a.y, lx: base.lx, ly: base.ly, side: base.side };
  const grow = smooth(richnessValue(plan, t) * 1.25);
  let topProj = a.y;
  for (const pa of layout.raster.projAnchors) if (pa.limb === a.limb && pa.y < topProj) topProj = pa.y;
  return { ax: a.x, ay: a.y, lx: base.lx, ly: lerp(Math.min(a.y - 64, topProj - 40), base.ly, grow), side: "top" };
}

// ── draw ────────────────────────────────────────────────────────────────────

export interface DrawContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
}

/** Draw the frame for scene second t. */
export function drawScene(c: DrawContext, layout: SceneLayout, stat: StaticLayout, plan: ScenePlan, t: number): void {
  const { W, H } = layout.geo;
  const tree = layout.raster;
  const CELLPX = tree.cell;
  c.clearRect(0, 0, W, H);
  const amp = swayAmp(plan, t);
  const trunkT0 = plan.trunk ?? Infinity;

  // Blooms: a soft white light behind the seed, later behind the crown.
  const seedOn = easeInOut(clamp01((t - INTRO.seed[0]) / INTRO.seed[1]));
  if (seedOn > 0) {
    const g = c.createRadialGradient(tree.sx, tree.gy - 8, 0, tree.sx, tree.gy - 8, 70);
    const a = 0.24 * seedOn * (1 - 0.7 * smooth((t - trunkT0 - 0.85) / 3));
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(tree.sx - 80, tree.gy - 90, 160, 170);
  }
  const rich = richnessValue(plan, t);
  const crownOn = smooth(rich * 1.4 - 0.2);
  if (crownOn > 0) {
    const cx = (layout.crown.minX + layout.crown.maxX) / 2;
    const cy = tree.gy - tree.treeH * 0.66;
    const rad = (layout.crown.maxX - layout.crown.minX) * 0.62;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, `rgba(255,255,255,${0.05 * crownOn})`);
    g.addColorStop(0.55, `rgba(255,214,200,${0.022 * crownOn})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  }

  c.font = `${FONT_PX}px ${MONO_FONT}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = "#fff";

  // Ground line draws outward from the seed.
  const gOn = clamp01((t - INTRO.ground[0]) / INTRO.ground[1]);
  if (gOn > 0) {
    const reachCells = easeOut(gOn) * 60;
    for (const g of stat.ground) {
      const k = clamp01(reachCells - g.d * 1.2);
      if (k <= 0) continue;
      const fl = 0.9 + 0.1 * Math.sin(t * 1.6 + g.x * 0.07);
      c.globalAlpha = g.a * k * fl;
      c.fillText(g.ch, g.x, g.y);
    }
    for (const s of stat.soil) {
      const k = clamp01(reachCells * 0.8 - s.d * 1.4);
      if (k <= 0) continue;
      c.globalAlpha = s.a * k;
      c.fillText(s.ch, s.x, s.y);
    }
  }

  // Branches (sorted by when anything in the cell first shows).
  const thickTrunk = 0.16 + 0.84 * easeOut(clamp01((t - trunkT0 - 0.4) / 13));
  for (const slot of tree.branches) {
    if (t < slot.first) break;
    const cell = branchCellAt(slot, t);
    if (!cell) continue;
    const wither = witherAt(cell.gone, t);
    if (wither <= 0) continue;
    let thick = 1;
    if (cell.depth === 0) thick = thickTrunk;
    else if (cell.depth === 1) thick = 0.3 + 0.7 * easeOut(clamp01((t - cell.t0 - 0.6) / 11));
    // the base flare widens with the trunk, so the taper stays smooth while it grows
    const half = cell.fk > 1 ? (cell.halfC / cell.fk) * (1 + (cell.fk - 1) * thick * thick) : cell.halfC;
    const showR = Math.max(0.62, thick * half);
    const off = Math.abs(cell.rel) * cell.halfC;
    if (cell.halfC >= 0.75 && off > showR + 0.05) continue;
    const age = t - cell.tg;
    const fade = clamp01(age / 0.35);
    let a: number;
    let ch: string;
    if (cell.kind === "root") {
      const below = (cell.y - tree.gy) / (CELLPX * 9);
      a = 0.24 * (1 - clamp01(below));
      ch = cell.line;
    } else if (cell.halfC >= 0.75) {
      const isEdge = off > showR - 0.85;
      const light = 1 - (cell.rel + 1) / 2; // lit from the left
      if (isEdge) {
        ch = cell.edge;
        a = 0.52 + 0.34 * light;
      } else {
        ch = cell.bark;
        a = 0.14 + 0.3 * light;
      }
    } else {
      ch = cell.line;
      a = cell.depth <= 1 ? 0.78 : cell.depth === 2 ? 0.7 : cell.depth === 3 ? 0.56 : 0.44;
    }
    // growth front: freshly grown cells burn bright for a moment
    const hot = cell.kind === "root" ? 0 : Math.max(0, 1 - age / 0.7);
    const flick = 0.9 + 0.1 * Math.sin(t * 1.6 + cell.c * 0.7 + cell.r * 0.4);
    c.globalAlpha = Math.min(1, (a * flick + hot * 0.5) * fade) * wither;
    const dx = cell.kind === "root" ? 0 : swayAt(tree, cell.y, t, amp);
    c.fillText(ch, cell.x + dx, cell.y);
  }

  // Foliage.
  for (const l of tree.leaves) {
    if (t < l.tg) break;
    const v = leafVersionAt(l, t);
    if (!v) continue;
    const wither = witherAt(v.gone, t);
    if (wither <= 0) continue;
    const e = easeOut(clamp01((t - l.tg) / 0.5));
    const tw = 0.82 + 0.18 * Math.sin(t * 1.9 + l.h * 40);
    c.globalAlpha = v.a * e * tw * (v.bud ? 0.9 : 1) * wither;
    const dx = swayAt(tree, v.y, t, amp) + Math.sin(t * 1.4 + l.h * 30) * 0.35 * amp;
    c.fillText(v.ch, v.x + dx, v.y + (1 - e) * 3);
  }

  // Blossoms, coral-peach.
  for (const b of tree.blossoms) {
    if (t < b.tg) break;
    const wither = witherAt(b.gone, t);
    if (wither <= 0) continue;
    const e = easeOut(clamp01((t - b.tg) / 0.6)) * wither;
    const x = b.x + swayAt(tree, b.y, t, amp);
    const g = c.createRadialGradient(x, b.y, 0, x, b.y, 9);
    g.addColorStop(0, `rgba(255,170,150,${0.2 * e})`);
    g.addColorStop(1, "rgba(255,170,150,0)");
    c.fillStyle = g;
    c.globalAlpha = 1;
    c.fillRect(x - 9, b.y - 9, 18, 18);
    c.fillStyle = coral(b.hue);
    c.globalAlpha = (0.8 + 0.2 * Math.sin(t * 1.3 + b.i)) * e + Math.max(0, 1 - (t - b.tg) / 0.5) * 0.4 * wither;
    c.fillText(b.ch, x, b.y + (1 - e) * 3);
  }
  c.fillStyle = "#fff";

  // Company blossoms + callout leaders.
  drawCallouts(c, layout, plan, t, amp);

  // Seed: dust gathers into a small glowing cluster on the ground.
  const seedFade = 1 - smooth((t - trunkT0 - 0.4) / 2.2);
  if (t > INTRO.seed[0] - 0.3 && seedFade > 0) {
    for (const p of stat.seed) {
      const u = cubicIO(clamp01((t - INTRO.seed[0] - p.dl * 0.6) / 1.1));
      const wx = Math.sin(t * 0.35 + p.ph) * 18 * (1 - u);
      const wy = Math.cos(t * 0.3 + p.ph * 1.3) * 12 * (1 - u);
      const x = lerp(p.sx, p.tx, u) + wx;
      const y = lerp(p.sy, p.ty, u) + wy;
      const appear = clamp01((t - INTRO.seed[0] + 0.3) / 0.6);
      const tw = 0.75 + 0.25 * Math.sin(t * 2 + p.ph);
      c.globalAlpha = appear * (0.25 + 0.75 * u) * p.a * tw * seedFade;
      c.beginPath();
      c.arc(x, y, p.r, 0, 6.283);
      c.fill();
    }
  }

  // Feed: dust lifting from the rows into the growth front.
  for (const p of layout.feed) {
    if (p.dep > t) break; // sorted by departure
    const u0 = (t - p.dep) / p.fl;
    if (u0 <= 0 || u0 >= 1.04) continue;
    for (let k = 0; k < 3; k += 1) {
      const uu = u0 - k * 0.014;
      if (uu <= 0 || uu >= 1) continue;
      const u = cubicIO(uu);
      const m = 1 - u;
      const tx = p.tx + swayAt(tree, p.ty, t, amp);
      const ty = p.ty;
      let x = m * m * m * p.sx + 3 * m * m * u * p.c1x + 3 * m * u * u * p.c2x + u * u * u * tx;
      let y = m * m * m * p.sy + 3 * m * m * u * p.c1y + 3 * m * u * u * p.c2y + u * u * u * ty;
      const wob = Math.sin(Math.PI * u);
      x += Math.sin(t * 1.1 + p.ph) * 10 * wob;
      y += Math.cos(t * 0.9 + p.ph * 1.3) * 7 * wob;
      const inA = smooth(uu / 0.12);
      const outA = 1 - smooth((uu - 0.9) / 0.1);
      const tw = 0.75 + 0.25 * Math.sin(t * 2 + p.ph);
      c.globalAlpha = p.a * inA * outA * tw * (k === 0 ? 1 : k === 1 ? 0.4 : 0.18);
      if (p.coral !== null) c.fillStyle = coral(p.coral);
      c.beginPath();
      c.arc(x, y, k === 0 ? p.r : 0.8, 0, 6.283);
      c.fill();
      if (p.coral !== null) c.fillStyle = "#fff";
    }
  }

  // Ambient dust, drifting up.
  const dOn = clamp01(t / 1.2);
  for (const p of stat.dust) {
    let y = (p.y - t * p.v) % H;
    if (y < 0) y += H;
    const x = p.x + Math.sin(t * 0.3 + p.ph) * 14;
    const tw = 0.75 + 0.25 * Math.sin(t * 1.7 + p.ph * 3);
    c.globalAlpha = p.a * tw * dOn;
    c.beginPath();
    c.arc(x, y, p.r, 0, 6.283);
    c.fill();
  }
  c.globalAlpha = 1;
}

function drawCallouts(c: DrawContext, layout: SceneLayout, plan: ScenePlan, t: number, amp: number): void {
  const tree = layout.raster;
  for (let i = 0; i < tree.anchors.length; i += 1) {
    const tc = calloutTime(tree, i);
    if (t < tc - 0.6) continue;
    const g = calloutGeom(layout, plan, i, t);
    if (!g) continue;
    const wither = witherAt(tree.anchors[i]!.gone, t);
    if (wither <= 0) continue;
    const other = tree.anchors[i]!.slot === "other";
    const ax = g.ax + swayAt(tree, g.ay, t, amp);
    const ay = g.ay;
    // the company's blossom
    const bu = easeOut(clamp01((t - tc + 0.6) / 0.8)) * (other ? 0.6 : 1) * wither;
    const glow = c.createRadialGradient(ax, ay, 0, ax, ay, 22);
    glow.addColorStop(0, `rgba(255,160,150,${0.32 * bu})`);
    glow.addColorStop(1, "rgba(255,160,150,0)");
    c.globalAlpha = 1;
    c.fillStyle = glow;
    c.fillRect(ax - 22, ay - 22, 44, 44);
    c.fillStyle = coral(0.25 + (i % 3) * 0.3);
    c.globalAlpha = bu;
    c.font = `13px ${MONO_FONT}`;
    c.fillText("*", ax, ay + 1);
    c.font = `${FONT_PX}px ${MONO_FONT}`;
    c.globalAlpha = bu * 0.7;
    c.fillText(".", ax - tree.cell, ay);
    c.fillText(".", ax + tree.cell, ay);
    c.fillText("'", ax, ay - tree.cell);
    c.fillText(",", ax, ay + tree.cell);
    c.fillStyle = "#fff";
    // hairline leader: anchor -> elbow -> label
    const lu = easeOut(clamp01((t - tc) / 0.8));
    if (lu <= 0) continue;
    const sway = swayAt(tree, g.ly, t, amp) * 0.5;
    const dirY = g.ly > ay ? 1 : -1;
    const p0x = ax;
    const p0y = ay + dirY * 7;
    const p1x = g.side === "top" ? ax + (g.lx < ax ? -26 : 26) + sway : ax + sway * 0.5;
    const p1y = g.ly;
    const p2x = (g.side === "left" ? g.lx + 6 : g.lx - 6) + sway + (g.side === "top" && g.lx < ax ? 12 : 0);
    const L1 = Math.hypot(p1y - p0y, p1x - p0x);
    const L2 = Math.abs(p2x - p1x);
    const reach = lu * (L1 + L2);
    c.strokeStyle = `rgba(255,255,255,${(0.3 * wither).toFixed(3)})`;
    c.lineWidth = 1;
    c.globalAlpha = 1;
    c.beginPath();
    c.moveTo(p0x, p0y);
    if (reach <= L1) {
      c.lineTo(p0x + (p1x - p0x) * (reach / L1), p0y + (p1y - p0y) * (reach / L1));
    } else {
      c.lineTo(p1x, p1y);
      const k = (reach - L1) / (L2 || 1);
      c.lineTo(p1x + (p2x - p1x) * k, p1y);
    }
    c.stroke();
  }
}

/** The last second at which something scheduled still moves (before ambient only). */
export function lastScheduled(layout: Pick<SceneLayout, "raster" | "feed">, plan: ScenePlan): number {
  let last = plan.lastBeat;
  const tree = layout.raster;
  const settleOf = (tg: number, gone: number, pad: number) => (Number.isFinite(gone) ? Math.max(tg + pad, gone + WITHER_DUR) : tg + pad);
  for (const cell of tree.branches) last = Math.max(last, settleOf(cell.tg, cell.gone, 0.7));
  for (const l of tree.leaves) {
    const v = l.versions[l.versions.length - 1];
    if (v) last = Math.max(last, settleOf(v.tg, v.gone, 0.6));
  }
  for (const b of tree.blossoms) last = Math.max(last, settleOf(b.tg, b.gone, 0.6));
  for (const a of tree.anchors) last = Math.max(last, a.limbEnd + 1.2);
  const f = layout.feed[layout.feed.length - 1];
  if (f) last = Math.max(last, f.dep + f.fl * 1.04);
  return last;
}
