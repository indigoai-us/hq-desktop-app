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

/** Circle radius grows with story count, else file count. */
export function atlasRadius(n: Pick<AtlasNode, "count" | "stories">): number {
  return 4 + Math.sqrt(objectSize(n)) * 3.2;
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
  const placed = roots.map((n) => {
    const region = regions.find((r) => r.type === n.type) as AtlasRegion;
    const pack = 22 + 16 * Math.sqrt(siblings.get(n.type) ?? 1);
    const rad = Math.sqrt(atlasHash(n.id)) * pack;
    const ang = atlasHash(`${n.id}b`) * Math.PI * 2;
    return {
      ...n,
      x: region.x + Math.cos(ang) * rad,
      y: region.y + Math.sin(ang) * rad,
      r: atlasRadius(n),
    };
  });
  return { placed, regions };
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

/** Label size on screen (design standard body size); labels never scale with zoom. */
export const ATLAS_LABEL_PX = 13;
/** From this zoom up, every object may carry a label when there is room. */
export const ATLAS_LABEL_ALL_ZOOM = 1;
/** Below that zoom, at most this many labels for objects nobody is looking at. */
export const ATLAS_FIT_LABEL_CAP = 8;
const LABEL_GAP = 4;
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
 * objects (size comes from the object's item count). With an object selected
 * or hovered, only it, its relations and recent objects are labelled. Below
 * ATLAS_LABEL_ALL_ZOOM, at most ATLAS_FIT_LABEL_CAP labels go to objects
 * nobody is looking at. A label is kept only when it fits inside the map and
 * does not overlap a label already kept, so crowded maps show the most
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
    return all || (!input.hovered && !input.selected) ? 4 : -1;
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
  let ambient = 0;
  for (const { n, r } of candidates) {
    if (r >= 3 && !all && ambient >= ATLAS_FIT_LABEL_CAP) break;
    const x = n.x * view.k + view.x + n.r * view.k + 5;
    const y = n.y * view.k + view.y + 4;
    const w = input.measure(n.label);
    const box = { left: x, top: y - 12, right: x + w, bottom: y - 12 + LABEL_HEIGHT };
    if (box.left < 0 || box.top < 0 || box.right > width || box.bottom > height) continue;
    const hit = kept.some(
      (k) =>
        box.left < k.box.right + LABEL_GAP &&
        k.box.left < box.right + LABEL_GAP &&
        box.top < k.box.bottom + LABEL_GAP &&
        k.box.top < box.bottom + LABEL_GAP,
    );
    if (hit) continue;
    if (r >= 3) ambient += 1;
    kept.push({ id: n.id, text: n.label, x, y, box });
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
