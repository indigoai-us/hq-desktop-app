/**
 * Layout for the brief's Today strip. Pure, so lane packing, busy de-dup and
 * the axis fit are testable without the DOM.
 *
 * - Width comes from the real end time (30 minutes only when an event has
 *   no usable end).
 * - Busy placeholders that overlap a named event are dropped; the rest stay
 *   as unlabeled hatched blocks.
 * - Overlaps stack into lanes by interval-graph coloring (sorted by start,
 *   each event takes the lowest lane already free); three lanes show, the
 *   rest are counted in a "+N" chip.
 * - The axis fits the day's first and last event with 30 minutes of padding.
 */

import type { BriefCalendarEvent } from "./brief-types.js";

export const DEFAULT_EVENT_MS = 30 * 60_000;
export const AXIS_PAD_MS = 30 * 60_000;
export const MAX_LANES = 3;
/** Blocks narrower than this (percent of the axis) carry no label. */
export const TINY_PCT = 4.5;

export interface Span {
  start: number;
  end: number;
}

/** Start and end in ms; a missing or non-positive end becomes start + 30m. */
export function spanOf(e: Pick<BriefCalendarEvent, "start" | "end">): Span | null {
  const start = Date.parse(e.start);
  if (!Number.isFinite(start)) return null;
  const end = e.end ? Date.parse(e.end) : NaN;
  return { start, end: Number.isFinite(end) && end > start ? end : start + DEFAULT_EVENT_MS };
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** Busy blocks that overlap any named event are duplicates of it. */
export function dropCoveredBusy<T extends Pick<BriefCalendarEvent, "start" | "end" | "busy">>(events: readonly T[]): T[] {
  const named = events.filter((e) => !e.busy).map(spanOf).filter((s): s is Span => s != null);
  return events.filter((e) => {
    if (!e.busy) return true;
    const s = spanOf(e);
    return s != null && !named.some((n) => overlaps(s, n));
  });
}

/**
 * Lane per span (same order as given). Spans are visited by start time; each
 * takes the lowest lane whose last span has ended. Touching spans (one ends
 * as the next starts) share a lane.
 */
export function packLanes(spans: readonly Span[]): number[] {
  const order = spans.map((s, i) => ({ s, i })).sort((a, b) => a.s.start - b.s.start || b.s.end - a.s.end);
  const laneEnds: number[] = [];
  const lanes = new Array<number>(spans.length).fill(0);
  for (const { s, i } of order) {
    let lane = laneEnds.findIndex((end) => end <= s.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(s.end);
    } else {
      laneEnds[lane] = s.end;
    }
    lanes[i] = lane;
  }
  return lanes;
}

/** Axis bounds as fractional local hours of `day`, padded 30m, at least 4h wide. */
export function fitAxis(spans: readonly Span[], day: Date): { h0: number; h1: number } {
  if (!spans.length) return { h0: 8, h1: 18 };
  const midnight = new Date(day);
  midnight.setHours(0, 0, 0, 0);
  const toH = (ms: number) => (ms - midnight.getTime()) / 3_600_000;
  let h0 = Math.max(0, toH(Math.min(...spans.map((s) => s.start)) - AXIS_PAD_MS));
  let h1 = Math.min(24, toH(Math.max(...spans.map((s) => s.end)) + AXIS_PAD_MS));
  if (h1 - h0 < 4) {
    const grow = (4 - (h1 - h0)) / 2;
    h0 = Math.max(0, h0 - grow);
    h1 = Math.min(24, h1 + grow);
  }
  return { h0: Math.floor(h0 * 2) / 2, h1: Math.ceil(h1 * 2) / 2 };
}

/** Whole-hour tick marks for the axis, every 1 or 2 hours by span. */
export function axisTicks(h0: number, h1: number): number[] {
  const step = h1 - h0 > 9 ? 2 : 1;
  const out: number[] = [];
  for (let h = Math.ceil(h0 / step) * step; h <= h1; h += step) out.push(h);
  return out;
}

export interface PlacedEvent {
  e: BriefCalendarEvent;
  /** Left edge and width, percent of the axis. */
  x: number;
  w: number;
  lane: number;
  past: boolean;
  tiny: boolean;
}

export interface StripLayout {
  h0: number;
  h1: number;
  ticks: number[];
  items: PlacedEvent[];
  /** Events in lanes past the cap. */
  hidden: BriefCalendarEvent[];
  lanes: number;
  /** Now-line position, percent; null when now is off the axis. */
  nowX: number | null;
}

export function layoutStrip(events: readonly BriefCalendarEvent[], now: Date, maxLanes = MAX_LANES): StripLayout {
  const kept = dropCoveredBusy(events)
    .map((e) => ({ e, s: spanOf(e) }))
    .filter((x): x is { e: BriefCalendarEvent; s: Span } => x.s != null);
  const { h0, h1 } = fitAxis(kept.map((k) => k.s), now);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const pct = (ms: number) => ((((ms - midnight.getTime()) / 3_600_000) - h0) / (h1 - h0)) * 100;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const lanes = packLanes(kept.map((k) => k.s));
  const items: PlacedEvent[] = [];
  const hidden: BriefCalendarEvent[] = [];
  kept.forEach((k, i) => {
    if (lanes[i]! >= maxLanes) {
      hidden.push(k.e);
      return;
    }
    const x = clamp(pct(k.s.start));
    const w = Math.max(0.6, clamp(pct(k.s.end)) - x);
    items.push({ e: k.e, x, w, lane: lanes[i]!, past: k.s.end <= now.getTime(), tiny: w < TINY_PCT });
  });
  const nx = pct(now.getTime());
  return {
    h0,
    h1,
    ticks: axisTicks(h0, h1),
    items,
    hidden,
    lanes: Math.max(1, Math.min(maxLanes, Math.max(0, ...lanes.map((l) => l + 1)))),
    nowX: nx >= 0 && nx <= 100 ? nx : null,
  };
}

/** "7:30–8 AM", "11 AM–12:30 PM" in local time. */
export function rangeText(e: Pick<BriefCalendarEvent, "start" | "end">): string {
  const s = spanOf(e);
  if (!s) return "";
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const h = d.getHours() % 12 || 12;
    const m = d.getMinutes();
    return { t: m ? `${h}:${String(m).padStart(2, "0")}` : `${h}`, ap: d.getHours() >= 12 ? "PM" : "AM" };
  };
  const a = fmt(s.start);
  const b = fmt(s.end);
  return a.ap === b.ap ? `${a.t}–${b.t} ${b.ap}` : `${a.t} ${a.ap}–${b.t} ${b.ap}`;
}
