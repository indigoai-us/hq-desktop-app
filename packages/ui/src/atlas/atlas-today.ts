/**
 * Today panel (inspector idle state): what changed today, from real data.
 * An object counts when its last-modified time falls on today (UTC, the same
 * day boundary as the timeline). The graph has no per-story timestamps, so
 * stories finished today cannot be listed. Pure functions.
 */

import type { AtlasNode } from "./atlas-model.js";
import { atlasDayStart } from "./atlas-timeline.js";

/** Rows shown before "Show N more". */
export const ATLAS_TODAY_PAGE = 5;

/** Objects changed today: projects first, then most recent, then by name. */
export function atlasTodayChanges(nodes: readonly AtlasNode[], nowMs: number): AtlasNode[] {
  const start = atlasDayStart(nowMs);
  return nodes
    .filter((n) => n.touched != null && n.touched >= start && n.touched <= nowMs)
    .sort(
      (a, b) =>
        Number(b.type === "project") - Number(a.type === "project") ||
        (b.touched ?? 0) - (a.touched ?? 0) ||
        a.label.localeCompare(b.label),
    );
}

/** "just now", "12 min ago", "3 h ago". */
export function atlasAgo(ms: number, nowMs: number): string {
  const min = Math.floor(Math.max(0, nowMs - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}
