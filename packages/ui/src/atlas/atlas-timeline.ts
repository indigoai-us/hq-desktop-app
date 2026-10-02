/**
 * Atlas time scrubber model (US-014).
 *
 * Thirty daily buckets ending today. Born mode counts objects by `created`;
 * Touched mode counts them by `touched`. Scrubbing back to a day fades the
 * map by opacity only: Born hides objects not yet created, Touched dims
 * objects not touched in the week ending that day. Pure arithmetic so the
 * map can recompute it every animation frame of playback.
 */

import type { AtlasNode } from "./atlas-model.js";
import { fmtCompactDate } from "./atlas-model.js";

export const ATLAS_TIMELINE_DAYS = 30;
const DAY = 86_400_000;
/** Touched mode keeps an object bright for this many days after a touch. */
export const ATLAS_TOUCH_WINDOW_DAYS = 7;
/** Opacity for objects outside the scrubbed moment. */
export const ATLAS_BORN_HIDDEN = 0.06;
export const ATLAS_TOUCH_FADED = 0.25;

export type AtlasTimeMode = "born" | "touched";

/** Start of the UTC day containing `ms`. */
export function atlasDayStart(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

/** Bucket index (0 = 29 days ago, 29 = today) or -1 when outside the window. */
export function atlasDayIndex(ms: number | undefined, nowMs: number): number {
  if (ms == null || !Number.isFinite(ms)) return -1;
  const diff = Math.floor((atlasDayStart(nowMs) - atlasDayStart(ms)) / DAY);
  if (diff < 0 || diff >= ATLAS_TIMELINE_DAYS) return -1;
  return ATLAS_TIMELINE_DAYS - 1 - diff;
}

function stamp(n: Pick<AtlasNode, "created" | "touched">, mode: AtlasTimeMode): number | undefined {
  return mode === "born" ? n.created : n.touched;
}

/** Daily counts for the histogram, oldest first. */
export function atlasDailyCounts(
  nodes: readonly Pick<AtlasNode, "created" | "touched">[],
  mode: AtlasTimeMode,
  nowMs: number,
): number[] {
  const out = new Array<number>(ATLAS_TIMELINE_DAYS).fill(0);
  for (const n of nodes) {
    const i = atlasDayIndex(stamp(n, mode), nowMs);
    if (i >= 0) out[i] += 1;
  }
  return out;
}

/** Bar heights in percent; the busiest day is 100, empty days are 0. */
export function atlasHistogramHeights(counts: readonly number[]): number[] {
  const max = Math.max(0, ...counts);
  if (!max) return counts.map(() => 0);
  return counts.map((c) => (c ? Math.max(6, Math.round((c / max) * 100)) : 0));
}

/** "Hot" bars: the top third of the busiest day. */
export function atlasHotDays(counts: readonly number[]): boolean[] {
  const max = Math.max(0, ...counts);
  return counts.map((c) => max > 0 && c >= max * 0.66);
}

/** End of the scrubbed day (inclusive cutoff) for a bucket index. */
export function atlasDayEnd(index: number, nowMs: number): number {
  const back = ATLAS_TIMELINE_DAYS - 1 - index;
  return atlasDayStart(nowMs) - back * DAY + DAY - 1;
}

/** Date readout: "Now" at the live edge, otherwise "Sep 14". */
export function atlasScrubLabel(index: number | null, nowMs: number): string {
  if (index == null || index >= ATLAS_TIMELINE_DAYS - 1) return "Now";
  return fmtCompactDate(atlasDayEnd(index, nowMs), nowMs) ?? "Now";
}

/**
 * Per-object opacity at a scrubbed day. Returns null at the live edge so the
 * map renders untouched. Objects with no timestamp stay visible.
 */
export function atlasTimeOpacity(
  nodes: readonly Pick<AtlasNode, "id" | "created" | "touched">[],
  mode: AtlasTimeMode,
  index: number | null,
  nowMs: number,
): Map<string, number> | null {
  if (index == null || index >= ATLAS_TIMELINE_DAYS - 1) return null;
  const cutoff = atlasDayEnd(index, nowMs);
  const out = new Map<string, number>();
  for (const n of nodes) {
    if (mode === "born") {
      if (n.created != null && n.created > cutoff) out.set(n.id, ATLAS_BORN_HIDDEN);
      continue;
    }
    if (n.created != null && n.created > cutoff) {
      out.set(n.id, ATLAS_BORN_HIDDEN);
      continue;
    }
    const t = n.touched;
    const fresh = t != null && t <= cutoff && t > cutoff - ATLAS_TOUCH_WINDOW_DAYS * DAY;
    if (!fresh) out.set(n.id, ATLAS_TOUCH_FADED);
  }
  return out;
}
