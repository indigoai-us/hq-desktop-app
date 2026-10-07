/**
 * Project dot sizing by recent activity, and the story progress ring.
 *
 * The graph carries one `touched` time per object, not a touch count, so a
 * project's activity is read from what is real: how recently the project
 * itself was touched, plus how many of its children and directly linked
 * objects were touched within ATLAS_ACTIVITY_DAYS. Pure functions.
 */

import type { AtlasNode, AtlasRefEdge } from "./atlas-model.js";

export const ATLAS_ACTIVITY_DAYS = 14;
const DAY = 86_400_000;
/** Weight of the project's own touch (fresh today) against one linked touch. */
const SELF_WEIGHT = 8;
const LINK_WEIGHT = 2;

/** Ids tied to each object by a graph edge or a parentId. */
export function atlasNeighbours(
  nodes: readonly Pick<AtlasNode, "id" | "parentId">[],
  edges: readonly AtlasRefEdge[] = [],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    let set = out.get(a);
    if (!set) out.set(a, (set = new Set()));
    set.add(b);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  for (const n of nodes) {
    if (n.parentId) {
      link(n.parentId, n.id);
      link(n.id, n.parentId);
    }
  }
  return out;
}

/** 1 when touched now, falling to 0 at ATLAS_ACTIVITY_DAYS; 0 when undated or older. */
export function atlasRecency(touched: number | undefined, nowMs: number): number {
  if (touched == null || !Number.isFinite(touched)) return 0;
  const days = Math.max(0, (nowMs - touched) / DAY);
  if (days >= ATLAS_ACTIVITY_DAYS) return 0;
  return 1 - days / ATLAS_ACTIVITY_DAYS;
}

/**
 * Activity score for each project: its own recency (weighted) plus each
 * linked object touched in the window. Projects with no recent activity
 * score 0. Other kinds are not scored.
 */
export function atlasProjectActivity(
  nodes: readonly AtlasNode[],
  edges: readonly AtlasRefEdge[] = [],
  nowMs: number,
): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const near = atlasNeighbours(nodes, edges);
  const out = new Map<string, number>();
  for (const n of nodes) {
    if (n.type !== "project") continue;
    let score = atlasRecency(n.touched, nowMs) * SELF_WEIGHT;
    for (const id of near.get(n.id) ?? []) {
      if (atlasRecency(byId.get(id)?.touched, nowMs) > 0) score += LINK_WEIGHT;
    }
    out.set(n.id, Math.round(score * 100) / 100);
  }
  return out;
}

/** True when any project in the graph carries a touched time (sizing by activity is meaningful). */
export function atlasHasActivityData(nodes: readonly Pick<AtlasNode, "type" | "touched">[]): boolean {
  return nodes.some((n) => n.type === "project" && n.touched != null);
}

/** Story progress for the ring, 0..1; null when the project has no stories. */
export function atlasStoryFraction(n: Pick<AtlasNode, "stories">): number | null {
  const s = n.stories;
  if (!s || !(s.total > 0)) return null;
  return Math.min(1, Math.max(0, s.done / s.total));
}

/** The ring sits just outside the dot, in world units. */
export const ATLAS_RING_GAP = 2.5;
/** Rings are hidden while the dot is smaller than this on screen (quiet at fit zoom). */
export const ATLAS_RING_MIN_PX = 3;

/** Story progress for a project card: done over total, or null when there are no stories. */
export interface AtlasStoryProgress {
  done: number;
  total: number;
  fraction: number;
  text: string;
}

export function atlasStoryProgress(n: Pick<AtlasNode, "stories">): AtlasStoryProgress | null {
  const fraction = atlasStoryFraction(n);
  if (fraction === null || !n.stories) return null;
  const done = Math.min(n.stories.done, n.stories.total);
  const total = n.stories.total;
  return { done, total, fraction, text: `${done} / ${total} ${total === 1 ? "story" : "stories"}` };
}
