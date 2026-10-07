/**
 * Motion that shows work happening: one soft pulse on a project when its work
 * advanced, and faint trails from a project that is active now to the items
 * it most recently touched. Pure functions; the map draws them with CSS.
 *
 * There is no commit or task-finished event in the data Atlas receives. The
 * nearest real signals are used instead: a project's `touched` time moving
 * forward between two reads of the graph, and a live session on a project
 * changing task (its task id moves on) or going from working to idle.
 */

import type { AtlasNode, AtlasPresence, AtlasRefEdge } from "./atlas-model.js";
import { atlasNeighbours } from "./atlas-activity.js";
import { ATLAS_RECENT_MS } from "./atlas-layout.js";
import { atlasActiveNow } from "./atlas-timeline.js";

/** Most pulses drawn at once. */
export const ATLAS_PULSE_CAP = 12;
/** One pulse: a ring that expands and fades once. */
export const ATLAS_PULSE_MS = 1200;
/** Trails per active project, and on screen in total. */
export const ATLAS_TRAILS_PER_PROJECT = 5;
export const ATLAS_TRAIL_CAP = 12;

/** What a live actor was doing on an object, keyed `actor>node`. */
export type AtlasWorkState = Map<string, { signal?: string; idle: boolean }>;

export function atlasTouchedIndex(nodes: readonly Pick<AtlasNode, "id" | "touched">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of nodes) if (n.touched != null) out.set(n.id, n.touched);
  return out;
}

export function atlasWorkState(presence: readonly AtlasPresence[]): AtlasWorkState {
  const out: AtlasWorkState = new Map();
  for (const p of presence) {
    if (p.unplaced) continue;
    out.set(`${p.actorUid ?? p.name}>${p.nodeId}`, { signal: p.signal, idle: p.idle === true });
  }
  return out;
}

/**
 * Projects that get one pulse: touched later than in the previous read, or a
 * live session on them moved off its task or went idle. Nothing pulses on the
 * first read (no previous state). Most recently touched first, capped.
 */
export function atlasPulseIds(input: {
  nodes: readonly AtlasNode[];
  prevTouched: ReadonlyMap<string, number> | null;
  presence: readonly AtlasPresence[];
  prevWork: AtlasWorkState | null;
  cap?: number;
}): string[] {
  const projects = new Map(input.nodes.filter((n) => n.type === "project").map((n) => [n.id, n]));
  const hit = new Set<string>();
  if (input.prevTouched) {
    for (const n of projects.values()) {
      const before = input.prevTouched.get(n.id);
      if (before != null && n.touched != null && n.touched > before) hit.add(n.id);
    }
  }
  if (input.prevWork) {
    const now = atlasWorkState(input.presence);
    for (const [key, was] of input.prevWork) {
      const nodeId = key.slice(key.indexOf(">") + 1);
      if (!projects.has(nodeId) || was.idle) continue;
      const is = now.get(key);
      if (!is) continue;
      const finished = is.idle || (was.signal != null && was.signal !== "" && is.signal !== was.signal);
      if (finished) hit.add(nodeId);
    }
  }
  return [...hit]
    .sort((a, b) => (projects.get(b)?.touched ?? 0) - (projects.get(a)?.touched ?? 0) || a.localeCompare(b))
    .slice(0, input.cap ?? ATLAS_PULSE_CAP);
}

export type AtlasTrail = { from: string; to: string };

/**
 * Trails from each project active now (someone live on it, or touched in the
 * live window) to its linked items touched within ATLAS_RECENT_MS, newest
 * first: at most ATLAS_TRAILS_PER_PROJECT per project and ATLAS_TRAIL_CAP in
 * all. An idle map has none.
 */
export function atlasTrails(input: {
  nodes: readonly AtlasNode[];
  edges?: readonly AtlasRefEdge[];
  live: ReadonlySet<string>;
  nowMs: number;
  /** Only objects drawn on the map can carry a trail. */
  drawn?: { has(id: string): boolean };
}): AtlasTrail[] {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const near = atlasNeighbours(input.nodes, input.edges ?? []);
  const fresh = (n: AtlasNode | undefined) =>
    n?.touched != null && n.touched <= input.nowMs && input.nowMs - n.touched <= ATLAS_RECENT_MS;
  const onMap = (id: string) => !input.drawn || input.drawn.has(id);
  const active = input.nodes
    .filter((n) => n.type === "project" && onMap(n.id) && atlasActiveNow(n, input.nowMs, input.live))
    .sort((a, b) => (b.touched ?? 0) - (a.touched ?? 0) || a.id.localeCompare(b.id));
  const out: AtlasTrail[] = [];
  for (const p of active) {
    const targets = [...(near.get(p.id) ?? [])]
      .map((id) => byId.get(id))
      .filter((n): n is AtlasNode => fresh(n) && onMap(n!.id))
      .sort((a, b) => (b.touched ?? 0) - (a.touched ?? 0) || a.id.localeCompare(b.id))
      .slice(0, ATLAS_TRAILS_PER_PROJECT);
    for (const t of targets) {
      if (out.length >= ATLAS_TRAIL_CAP) return out;
      out.push({ from: p.id, to: t.id });
    }
  }
  return out;
}

/** True when motion may run: motion on, no reduced-motion preference, page visible. */
export function atlasMotionAllowed(motion: boolean): boolean {
  if (!motion) return false;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  return true;
}
