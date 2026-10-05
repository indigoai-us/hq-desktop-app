/**
 * Atlas ring layout, edge visibility, label rules and view transform math.
 *
 * Kind clusters sit on a ring (Console `layoutAtlas`, same hash packing);
 * pan and zoom are a single `translate/scale` on one SVG group so moving the
 * map never re-lays out nodes.
 */

import {
  ATLAS_RING_ORDER,
  districtLabel,
  objectSize,
  type AtlasDistrictType,
  type AtlasNode,
  type AtlasRefEdge,
} from "./atlas-model.js";

export const ATLAS_ORBIT = 420;
export const ATLAS_SQUASH = 0.77;
export const ATLAS_RECENT_MS = 2 * 86_400_000;
export const ATLAS_MIN_ZOOM = 0.15;
export const ATLAS_MAX_ZOOM = 6;

export type AtlasPlaced = AtlasNode & { x: number; y: number; r: number };

export type AtlasRegion = {
  type: AtlasDistrictType;
  label: string;
  x: number;
  y: number;
};

export type AtlasView = { x: number; y: number; k: number };

/** FNV-1a hash in [0, 1) — same function as the Console atlas. */
export function atlasHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * OWNER-R4: the web Atlas type colours (hq-console atlas-canvas.tsx). Each
 * section is tinted with its type colour and its dots use it too; no outline.
 */
export const ATLAS_TYPE_COLOR: Record<AtlasDistrictType, string> = {
  project: "#c8d0dc",
  knowledge: "#9db8a6",
  policy: "#c9b49a",
  repo: "#b7c0cc",
  worker: "#a8acc0",
  skill: "#c4b4ae",
};

/**
 * Section tints. The web colours above are near-greys (project and repo share
 * one hue), so on their own six sections read as one grey. These keep each
 * web colour's family at a stronger chroma, move repo to teal and worker to
 * olive so all six differ, and stay out of purple.
 */
export const ATLAS_TYPE_TINT: Record<AtlasDistrictType, string> = {
  project: "#7f9cc4",
  knowledge: "#6fae84",
  policy: "#c79a5f",
  repo: "#6fb0b4",
  worker: "#aaa45c",
  skill: "#c98a72",
};

/** Web per-type dot multipliers (hq-console company-atlas-layout.ts ATLAS_TUNE). */
const ATLAS_TYPE_DOTS: Record<AtlasDistrictType, number> = {
  project: 4.8,
  knowledge: 3.45,
  policy: 7.05,
  repo: 4.2,
  worker: 9.3,
  skill: 8.55,
};

/** The web lays the ring out at orbit 4000; this map uses ATLAS_ORBIT. */
const WEB_SCALE = ATLAS_ORBIT / 4000;

/**
 * Dot radius with the web size scale: square root of story total, else file
 * count, times the type's multiplier, scaled to this map. Most objects are
 * small dots; only large projects read as small circles.
 */
export function atlasRadius(n: Pick<AtlasNode, "count" | "stories"> & { type?: AtlasDistrictType }): number {
  const dots = ATLAS_TYPE_DOTS[n.type ?? "project"];
  return Math.max(1.5, (0.2 + Math.sqrt(objectSize(n) + 1) * 0.45 * 10 * dots) * WEB_SCALE);
}

/** Push apart dots of one section that overlap, keeping the hash layout's shape. */
function relaxSection(items: { x: number; y: number; r: number }[], gap = 7, rounds = 24): void {
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const min = a.r + b.r + gap + 0.01;
        if (d >= min) continue;
        if (d < 1e-6) {
          // Same spot: split along a fixed direction so the result stays deterministic.
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (min - d) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

export function layoutAtlas(nodes: AtlasNode[]): {
  placed: AtlasPlaced[];
  regions: AtlasRegion[];
} {
  const roots = nodes.filter((n) => !n.parentId);
  const regions: AtlasRegion[] = ATLAS_RING_ORDER.map((type, i) => {
    const a = -Math.PI / 2 + (i / ATLAS_RING_ORDER.length) * Math.PI * 2;
    return {
      type,
      label: districtLabel(type),
      x: Math.cos(a) * ATLAS_ORBIT,
      y: Math.sin(a) * ATLAS_ORBIT * ATLAS_SQUASH,
    };
  });
  const siblings = new Map<AtlasDistrictType, number>();
  for (const n of roots) siblings.set(n.type, (siblings.get(n.type) ?? 0) + 1);
  // Offsets from the section centre: the web hash scatter and pack size,
  // scaled to this map, then relaxed so no two dots overlap.
  const offsets = roots.map((n) => {
    const pack = (16 + 13 * Math.sqrt(siblings.get(n.type) ?? 1)) * 7.65 * WEB_SCALE;
    const rad = Math.sqrt(atlasHash(n.id)) * pack;
    const ang = atlasHash(`${n.id}b`) * Math.PI * 2;
    return { n, x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, r: atlasRadius(n) };
  });
  const reach = new Map<AtlasDistrictType, number>();
  for (const type of ATLAS_RING_ORDER) {
    const members = offsets.filter((o) => o.n.type === type);
    relaxSection(members);
    if (members.length) {
      reach.set(type, Math.max(40, Math.max(...members.map((o) => Math.hypot(o.x, o.y) + o.r)) + DISTRICT_PAD));
    }
  }
  // OWNER-R4: sections never overlap. Size the ring to its contents: the
  // smallest ring on which every pair of shaded sections keeps SECTION_GAP.
  // Small maps pull in toward the centre instead of floating far apart on
  // the full web orbit; crowded maps still widen.
  let scale = RING_MIN_SCALE;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const ra = reach.get(regions[i]!.type);
      const rb = reach.get(regions[j]!.type);
      if (ra === undefined || rb === undefined) continue;
      const apart = Math.hypot(regions[i]!.x - regions[j]!.x, regions[i]!.y - regions[j]!.y);
      scale = Math.max(scale, (ra + rb + SECTION_GAP) / apart);
    }
  }
  const centre = (region: AtlasRegion) => ({ x: region.x * scale, y: region.y * scale });
  const scaled = regions.map((region) => ({ ...region, ...centre(region) }));
  const placed = offsets.map(({ n, x, y, r }) => {
    const region = scaled.find((g) => g.type === n.type) as AtlasRegion;
    return { ...n, x: region.x + x, y: region.y + y, r };
  });
  return { placed, regions: scaled };
}

/** Graph edges plus `contains` edges from parentId. */
export function atlasEdges(graphEdges: AtlasRefEdge[] | undefined, nodes: AtlasNode[]): AtlasRefEdge[] {
  const out = [...(graphEdges ?? [])];
  for (const n of nodes) {
    if (n.parentId) out.push({ source: n.parentId, target: n.id, kind: "contains" });
  }
  return out;
}

/** Ids directly tied to `id`. */
export function atlasRelatedIds(id: string | null, edges: AtlasRefEdge[]): Set<string> {
  const out = new Set<string>();
  if (!id) return out;
  for (const e of edges) {
    if (e.source === id) out.add(e.target);
    else if (e.target === id) out.add(e.source);
  }
  return out;
}

/** Edges are hidden until something is hovered or selected. */
export function atlasVisibleEdges(
  edges: AtlasRefEdge[],
  selected: string | null,
  hovered: string | null,
): AtlasRefEdge[] {
  if (!selected && !hovered) return [];
  return edges.filter(
    (e) =>
      e.source === selected ||
      e.target === selected ||
      e.source === hovered ||
      e.target === hovered,
  );
}

/** One shaded section: a circle around every object in the section. */
export type AtlasDistrictShape = AtlasRegion & { r: number };

const DISTRICT_PAD = 14;
/** Space kept between two shaded sections. */
const SECTION_GAP = 10;
/** The ring never shrinks below this share of ATLAS_ORBIT. */
const RING_MIN_SCALE = 0.2;

/**
 * OWNER-D 7: the shaded area behind each section that has objects. Like the
 * web Atlas region model (centre plus radius per section), the radius grows
 * to enclose every object in the section with a little padding.
 */
export function atlasDistrictShapes(
  placed: Pick<AtlasPlaced, "type" | "x" | "y" | "r">[],
  regions: AtlasRegion[],
): AtlasDistrictShape[] {
  const out: AtlasDistrictShape[] = [];
  for (const region of regions) {
    const members = placed.filter((n) => n.type === region.type);
    if (!members.length) continue;
    const reach = Math.max(
      ...members.map((n) => Math.hypot(n.x - region.x, n.y - region.y) + n.r),
    );
    out.push({ ...region, r: Math.max(40, reach + DISTRICT_PAD) });
  }
  return out;
}

/** Screen box of a section name, drawn centred above its shaded area. */
export function atlasDistrictLabel(
  shape: AtlasDistrictShape,
  view: AtlasView,
  measure: (text: string) => number,
): AtlasScreenLabel {
  const cx = shape.x * view.k + view.x;
  const y = (shape.y - shape.r) * view.k + view.y - 6;
  const w = measure(shape.label);
  return {
    id: `district:${shape.type}`,
    text: shape.label,
    x: cx,
    y,
    box: { left: cx - w / 2, top: y - 12, right: cx + w / 2, bottom: y + 4 },
  };
}

/** Label size on screen (design standard body size); labels never scale with zoom. */
export const ATLAS_LABEL_PX = 13;
/** From this zoom up, every object may carry a label when there is room. */
export const ATLAS_LABEL_ALL_ZOOM = 1;
/** Below that zoom, at most this many labels for objects nobody is looking at. */
export const ATLAS_FIT_LABEL_CAP = 16;
const LABEL_GAP = 4;
/** Dots smaller than this on screen do not block a label. */
const DOT_OBSTACLE_PX = 2.5;
const LABEL_HEIGHT = 16;

export interface AtlasScreenLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  box: { left: number; top: number; right: number; bottom: number };
}

/**
 * OWNER-D 4 (AUDIT-3-19): which labels to draw, in screen space, at a fixed
 * readable size. Ranked hovered, selected, related, then by significance:
 * touched in the last two days first, then most recently touched, then larger
 * objects (size comes from the object's item count). With an object
 * selected, only it, its relations and recent objects are labelled; the same
 * holds while hovering below ATLAS_LABEL_ALL_ZOOM. Below
 * ATLAS_LABEL_ALL_ZOOM, at most ATLAS_FIT_LABEL_CAP labels go to objects
 * nobody is looking at. A label is kept only when it fits inside the map and
 * does not overlap a label already kept or another object's dot, so crowded maps show the most
 * significant names and the rest appear on hover or as the map zooms in.
 */
export function atlasScreenLabels(input: {
  placed: Pick<AtlasPlaced, "id" | "label" | "touched" | "x" | "y" | "r">[];
  selected: string | null;
  hovered: string | null;
  related: Set<string>;
  nowMs: number;
  view: AtlasView;
  width: number;
  height: number;
  measure: (text: string) => number;
  /** Boxes item labels must never cover (section names). */
  reserved?: AtlasScreenLabel["box"][];
}): AtlasScreenLabel[] {
  const { view, width, height } = input;
  const recent = (n: { touched?: number }) =>
    n.touched !== undefined && input.nowMs - n.touched <= ATLAS_RECENT_MS;
  const all = view.k >= ATLAS_LABEL_ALL_ZOOM;
  const rank = (n: (typeof input.placed)[number]): number => {
    if (n.id === input.hovered) return 0;
    if (n.id === input.selected) return 1;
    if (input.related.has(n.id)) return 2;
    if (recent(n)) return 3;
    // A selection is a deliberate focus: only it, its relations and recent
    // objects keep a name. Hovering alone never blanks a zoomed-in map.
    if (input.selected) return -1;
    return all || !input.hovered ? 4 : -1;
  };
  const candidates = input.placed
    .map((n) => ({ n, r: rank(n) }))
    .filter((c) => c.r >= 0)
    .sort(
      (a, b) =>
        a.r - b.r ||
        (b.n.touched ?? -Infinity) - (a.n.touched ?? -Infinity) ||
        b.n.r - a.n.r ||
        a.n.id.localeCompare(b.n.id),
    );
  const kept: AtlasScreenLabel[] = [];
  // Labels carry no outline, so one drawn across another object's dot would
  // be unreadable. Dots on screen that are big enough to matter are obstacles.
  const dots: (AtlasScreenLabel["box"] & { id: string })[] = [];
  for (const n of input.placed) {
    const rr = n.r * view.k;
    if (rr < DOT_OBSTACLE_PX) continue;
    const cx = n.x * view.k + view.x;
    const cy = n.y * view.k + view.y;
    if (cx + rr < 0 || cy + rr < 0 || cx - rr > width || cy - rr > height) continue;
    dots.push({ id: n.id, left: cx - rr, top: cy - rr, right: cx + rr, bottom: cy + rr });
  }
  let ambient = 0;
  for (const { n, r } of candidates) {
    if (r >= 3 && !all && ambient >= ATLAS_FIT_LABEL_CAP) break;
    const cx = n.x * view.k + view.x;
    const cy = n.y * view.k + view.y;
    const rr = n.r * view.k;
    const w = input.measure(n.label);
    // Right of the dot first, then left, above and below.
    const spots = [
      { x: cx + rr + 5, y: cy + 4, left: cx + rr + 5 },
      { x: cx - rr - 5 - w, y: cy + 4, left: cx - rr - 5 - w },
      { x: cx - w / 2, y: cy - rr - 6, left: cx - w / 2 },
      { x: cx - w / 2, y: cy + rr + 16, left: cx - w / 2 },
    ];
    const taken = [...(input.reserved ?? []), ...kept.map((k) => k.box)];
    for (const spot of spots) {
      const box = { left: spot.left, top: spot.y - 12, right: spot.left + w, bottom: spot.y - 12 + LABEL_HEIGHT };
      if (box.left < 0 || box.top < 0 || box.right > width || box.bottom > height) continue;
      const hit = taken.some(
        (k) =>
          box.left < k.right + LABEL_GAP &&
          k.left < box.right + LABEL_GAP &&
          box.top < k.bottom + LABEL_GAP &&
          k.top < box.bottom + LABEL_GAP,
      );
      if (hit) continue;
      // A dot stacked on this object's own dot cannot be avoided, so it does not block.
      const own = { left: cx - rr, top: cy - rr, right: cx + rr, bottom: cy + rr };
      const onDot = dots.some(
        (d) =>
          d.id !== n.id &&
          box.left < d.right && d.left < box.right && box.top < d.bottom && d.top < box.bottom &&
          !(own.left < d.right && d.left < own.right && own.top < d.bottom && d.top < own.bottom),
      );
      if (onDot) continue;
      if (r >= 3) ambient += 1;
      kept.push({ id: n.id, text: n.label, x: spot.x, y: spot.y, box });
      break;
    }
  }
  return kept;
}

export function clampZoom(k: number): number {
  return Math.min(ATLAS_MAX_ZOOM, Math.max(ATLAS_MIN_ZOOM, k));
}

/** View that fits every placed circle inside a `width × height` viewport. */
export function frameAll(
  placed: Pick<AtlasPlaced, "x" | "y" | "r">[],
  width: number,
  height: number,
  pad = 48,
): AtlasView {
  if (!placed.length || width <= 0 || height <= 0) {
    return { x: width / 2, y: height / 2, k: 1 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - p.r);
    minY = Math.min(minY, p.y - p.r);
    maxX = Math.max(maxX, p.x + p.r);
    maxY = Math.max(maxY, p.y + p.r);
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const k = clampZoom(Math.min((width - pad * 2) / w, (height - pad * 2) / h));
  return {
    k,
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  };
}

/** Zoom by `factor` keeping screen point (sx, sy) fixed. */
export function zoomAt(view: AtlasView, sx: number, sy: number, factor: number): AtlasView {
  const k = clampZoom(view.k * factor);
  const ratio = k / view.k;
  return { k, x: sx - (sx - view.x) * ratio, y: sy - (sy - view.y) * ratio };
}

export function viewTransform(view: AtlasView): string {
  return `translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`;
}
