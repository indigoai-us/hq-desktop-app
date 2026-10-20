/**
 * Pure helpers for the Fleet recovery card: the 24h gate (the same rule the
 * catalogue's measure() applies), the verdict-first title, the 48h curve
 * geometry (line, red area clipped to the incident window, fix pins), the
 * 5-capped stuck list, and the read-only inspect prompt. No Date.now, no
 * toLocale*: `now` is an input and times are formatted by the component.
 */

import { humanTitle } from "./brief-distill.js";
import type { BriefFleetIncident } from "./brief-types.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Logical chart box; the SVG stretches it to the card, strokes stay 1px. */
export const CHART = { w: 240, h: 96, top: 6, bottom: 4, left: 2, right: 2 } as const;

/** How many hours of the stuck curve the card shows. */
export const FLEET_WINDOW_HOURS = 48;

/** At most five named agents; the rest fold into a "+N more" row. */
export const FLEET_LIST_CAP = 5;

/** The rule behind the verdict, shown in the title's peek. */
export const VERDICT_RULE =
  "Healing = stuck falling after the fix but above 2%. Healed = under 2%. Plateaued = flat for 2 hours. Relapsing = recovered agents re-stuck.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Shown while the incident is open or closed within the last 24 hours; the
 * same gate as the catalogue entry, so the card and the picker agree. An
 * unparseable end date counts as still open.
 */
export function fleetRecoveryVisible(fi: BriefFleetIncident | null | undefined, nowIso: string): boolean {
  if (!fi) return false;
  const nowMs = Date.parse(nowIso);
  const ended = fi.incidentEnd ? Date.parse(fi.incidentEnd) : NaN;
  if (Number.isFinite(ended) && Number.isFinite(nowMs) && nowMs - ended > DAY_MS) return false;
  return true;
}

/** "Healing · 4 agents still stuck", "Healed · no agent still stuck". Verdict first, count second, never a total. */
export function verdictTitle(fi: Pick<BriefFleetIncident, "verdict" | "stillStuck">): string {
  const stuck = fi.stillStuck.length;
  return `${cap(fi.verdict)} · ${stuck ? `${plural(stuck, "agent")} still stuck` : "no agent still stuck"}`;
}

export interface FleetPin {
  x: number;
  at: number;
  /** The fix as a plain to-do ("Free the disk on setup boxes"), never a PR reference. */
  label: string;
  index: number;
}

export interface FleetGeometry {
  from: number;
  to: number;
  /** Y ceiling: the highest stuck count in the window, at least 1. */
  max: number;
  /** The whole curve across the window. */
  line: string;
  /** The area under the curve, only between incident start and end (or now); null when there is no start. */
  area: string | null;
  /** Incident window as x coordinates, clipped to the chart. */
  incident: { x0: number; x1: number } | null;
  pins: FleetPin[];
  points: { x: number; y: number; at: number; stuck: number }[];
  /** Baseline y (zero stuck). */
  baseY: number;
  x(at: number): number;
  y(stuck: number): number;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Stuck count at any time: the first value before the series, the last after it, linear between. */
function valueAt(series: readonly { at: number; stuck: number }[], t: number): number {
  if (!series.length) return 0;
  if (t <= series[0]!.at) return series[0]!.stuck;
  const last = series[series.length - 1]!;
  if (t >= last.at) return last.stuck;
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1]!;
    const b = series[i]!;
    if (t <= b.at) {
      const f = b.at === a.at ? 1 : (t - a.at) / (b.at - a.at);
      return a.stuck + (b.stuck - a.stuck) * f;
    }
  }
  return last.stuck;
}

/**
 * The 48h curve ending at `now`. The series is sorted and sampled at its own
 * points plus the window and incident edges, so the red area has clean edges
 * where the incident starts and ends.
 */
export function fleetGeometry(fi: BriefFleetIncident, nowIso: string, hours = FLEET_WINDOW_HOURS): FleetGeometry {
  const to = Date.parse(nowIso);
  const from = to - hours * HOUR_MS;
  const series = fi.series
    .map((p) => ({ at: Date.parse(p.at), stuck: Math.max(0, Number(p.stuck) || 0) }))
    .filter((p) => Number.isFinite(p.at))
    .sort((a, b) => a.at - b.at);
  const start = fi.incidentStart ? Date.parse(fi.incidentStart) : NaN;
  const endRaw = fi.incidentEnd ? Date.parse(fi.incidentEnd) : NaN;
  const end = Number.isFinite(endRaw) ? endRaw : to;

  const stamps = new Set<number>([from, to]);
  for (const p of series) if (p.at > from && p.at < to) stamps.add(p.at);
  if (Number.isFinite(start) && start > from && start < to) stamps.add(start);
  if (end > from && end < to) stamps.add(end);
  const times = [...stamps].sort((a, b) => a - b);
  const samples = times.map((at) => ({ at, stuck: valueAt(series, at) }));
  const max = Math.max(1, ...samples.map((s) => s.stuck), ...series.filter((p) => p.at >= from && p.at <= to).map((p) => p.stuck));

  const innerW = CHART.w - CHART.left - CHART.right;
  const innerH = CHART.h - CHART.top - CHART.bottom;
  const x = (at: number) => CHART.left + (to === from ? 0 : Math.min(1, Math.max(0, (at - from) / (to - from)))) * innerW;
  const y = (stuck: number) => CHART.top + (1 - Math.min(1, Math.max(0, stuck / max))) * innerH;
  const baseY = y(0);

  const points = samples.map((s) => ({ x: x(s.at), y: y(s.stuck), at: s.at, stuck: s.stuck }));
  const line = points.map((p, i) => `${i ? "L" : "M"}${fmt(p.x)} ${fmt(p.y)}`).join(" ");

  let area: string | null = null;
  let incident: FleetGeometry["incident"] = null;
  if (Number.isFinite(start) && start <= to && end >= from) {
    const s0 = Math.max(from, start);
    const s1 = Math.min(to, end);
    const inside = points.filter((p) => p.at >= s0 && p.at <= s1);
    if (inside.length) {
      incident = { x0: x(s0), x1: x(s1) };
      area = `M${fmt(incident.x0)} ${fmt(baseY)} ${inside.map((p) => `L${fmt(p.x)} ${fmt(p.y)}`).join(" ")} L${fmt(incident.x1)} ${fmt(baseY)} Z`;
    }
  }

  const pins: FleetPin[] = fi.fixes
    .map((f, index) => ({ at: Date.parse(f.at), label: humanTitle(f.label).text, index }))
    .filter((f) => Number.isFinite(f.at) && f.at >= from && f.at <= to)
    .sort((a, b) => a.at - b.at)
    .map((f) => ({ x: x(f.at), at: f.at, label: f.label, index: f.index }));

  return { from, to, max, line, area, incident, pins, points, baseY, x, y };
}

/** The highest stuck count in the series, with when; null for an empty series. */
export function peakOf(series: readonly { at: string; stuck: number }[]): { stuck: number; at: string } | null {
  let best: { stuck: number; at: string } | null = null;
  for (const p of series) if (!best || p.stuck > best.stuck) best = { stuck: p.stuck, at: p.at };
  return best;
}

export type StuckAgent = BriefFleetIncident["stillStuck"][number];

/** Longest stuck first (unknown since last), then by name; five shown, the rest for the "+N more" peek. */
export function stuckList(agents: readonly StuckAgent[], max = FLEET_LIST_CAP): { shown: StuckAgent[]; rest: StuckAgent[] } {
  const sinceMs = (a: StuckAgent) => (a.since ? Date.parse(a.since) : NaN);
  const sorted = [...agents].sort((a, b) => {
    const sa = sinceMs(a);
    const sb = sinceMs(b);
    const fa = Number.isFinite(sa);
    const fb = Number.isFinite(sb);
    if (fa !== fb) return fa ? -1 : 1;
    if (fa && fb && sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
  return { shown: sorted.slice(0, max), rest: sorted.slice(max) };
}

/** "40h", "3d", "20 min": how long an agent has been stuck. Empty when unknown. */
export function stuckFor(since: string | null | undefined, nowMs: number): string {
  if (!since) return "";
  const ms = nowMs - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const h = Math.floor(ms / HOUR_MS);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Read-only diagnosis of one stuck agent. Nothing is restarted or changed. */
export function inspectPrompt(agent: StuckAgent, fi: Pick<BriefFleetIncident, "verdict">): string {
  const since = agent.since ? ` since ${agent.since}` : "";
  return (
    `Inspect fleet agent "${agent.name}" read-only. It has been stuck (${agent.reason})${since}; the fleet is ${fi.verdict}. ` +
    "Through HQ, read its status, setup phase and recent logs, tell me why it is stuck and what would unstick it, then stop. " +
    "Do not change, restart, redeploy or message anything."
  );
}

/** The prompt key for one agent's dot in `prompts`; the writer may supply it, else the built-in prompt is used. */
export function agentPromptKey(incidentId: string, agentName: string): string {
  return `${incidentId}:${agentName}`;
}

/* ------------------------------------------------------------------------
   Layout helpers for the redesigned card (hero number, slim chart, open rows).
   Pure and pixel-based: the component measures the plot and hands the size in,
   so labels are placed once and never drawn on top of each other.
   ------------------------------------------------------------------------ */

/** Mono caps label metrics (var(--b-code), 10px, .08em): one glyph's advance in px. */
export const MONO_CHAR_PX = 6.8;

/** The rendered width of a mono caps label, in px. */
export function monoWidth(text: string, charPx = MONO_CHAR_PX): number {
  return Math.ceil(text.length * charPx);
}

/** An age is "old" (the warm tint) once an agent has been stuck a day or more. */
export const OLD_STUCK_MS = 24 * HOUR_MS;

export function stuckOld(since: string | null | undefined, nowMs: number): boolean {
  if (!since) return false;
  const ms = nowMs - Date.parse(since);
  return Number.isFinite(ms) && ms >= OLD_STUCK_MS;
}

/** The hero's small line: where the count came down from and how long the incident has run. */
export function heroMeta(fi: Pick<BriefFleetIncident, "series" | "stillStuck" | "incidentStart" | "incidentEnd">, nowMs: number): string {
  const parts: string[] = [];
  const stuck = fi.stillStuck.length;
  const peak = peakOf(fi.series);
  if (peak && peak.stuck > stuck) parts.push(`down from ${Math.round(peak.stuck)}`);
  else if (peak && stuck > 0 && peak.stuck <= stuck) parts.push("at its peak");
  const end = fi.incidentEnd ? Date.parse(fi.incidentEnd) : NaN;
  if (Number.isFinite(end)) {
    const ago = stuckFor(fi.incidentEnd, nowMs);
    if (ago) parts.push(`closed ${ago} ago`);
  } else {
    const open = stuckFor(fi.incidentStart, nowMs);
    if (open) parts.push(`open ${open}`);
  }
  return parts.join(" · ");
}

/** A label box on one line: left edge and width in px. */
export interface LabelBox {
  label: string;
  left: number;
  w: number;
}

const clash = (a: { left: number; w: number }, b: { left: number; w: number }, gap: number) => a.left < b.left + b.w + gap && b.left < a.left + a.w + gap;

/**
 * The time axis under the chart: "now" pinned to the right edge, then each
 * day tick centred on its x (px) and kept inside the axis. A tick that would
 * touch the label before it or "now" (closer than `gap`) is dropped, so two
 * labels never share the same x and never overlap.
 */
export function placeAxisLabels(ticks: readonly { x: number; label: string }[], width: number, nowLabel = "now", gap = 10, charPx = MONO_CHAR_PX): LabelBox[] {
  const nowW = monoWidth(nowLabel, charPx);
  const now: LabelBox = { label: nowLabel, left: Math.max(0, width - nowW), w: nowW };
  const kept: LabelBox[] = [];
  for (const t of [...ticks].sort((a, b) => a.x - b.x)) {
    const w = monoWidth(t.label, charPx);
    const left = Math.min(Math.max(0, t.x - w / 2), Math.max(0, width - w));
    const box = { label: t.label, left, w };
    if (clash(box, now, gap)) continue;
    if (kept.some((k) => clash(box, k, gap))) continue;
    kept.push(box);
  }
  return [...kept, now];
}

/**
 * Fix labels above the plot: each starts just right of its pin (or ends just
 * left of it near the right edge), in the first of `rows` lines where it does
 * not touch another label or a `reserved` box on the first line (the value
 * pill, when it sits up there). A label with no room gets row null: its pin
 * stays, hoverable, without words.
 */
export function placePinLabels(
  pins: readonly { x: number; label: string }[],
  width: number,
  reserved: readonly { left: number; w: number }[] = [],
  rows = 2,
  gap = 8,
  charPx = MONO_CHAR_PX,
): { row: number | null; left: number; w: number }[] {
  const lines: { left: number; w: number }[][] = Array.from({ length: rows }, (_, r) => (r === 0 ? [...reserved] : []));
  return pins.map((p) => {
    const w = monoWidth(p.label, charPx);
    let left = p.x + 4;
    if (left + w > width) left = p.x - 4 - w;
    if (left < 0) return { row: null, left: 0, w };
    const box = { left, w };
    for (let r = 0; r < rows; r += 1) {
      if (!lines[r]!.some((b) => clash(box, b, gap))) {
        lines[r]!.push(box);
        return { row: r, left, w };
      }
    }
    return { row: null, left, w };
  });
}

/** The readings worth a dot: the series' own points inside the window, thinned so dots never touch; the last (now) and the peak always stay. */
export function readingDots(geo: Pick<FleetGeometry, "points" | "from" | "to">, series: readonly { at: string }[], widthPx: number, minGap = 14): { x: number; y: number; at: number; stuck: number; current: boolean; peak: boolean }[] {
  const stamps = new Set(series.map((p) => Date.parse(p.at)).filter((t) => Number.isFinite(t) && t >= geo.from && t <= geo.to));
  const all = geo.points.filter((p) => stamps.has(p.at));
  const pts = all.length ? all : geo.points.slice(-1);
  if (!pts.length) return [];
  const peakStuck = Math.max(...pts.map((p) => p.stuck));
  const peakIdx = pts.findIndex((p) => p.stuck === peakStuck);
  const last = pts.length - 1;
  const px = (x: number) => (x / CHART.w) * widthPx;
  const keep = new Set<number>([last]);
  if (peakStuck > 0) keep.add(peakIdx);
  const anchors = [...keep].map((i) => px(pts[i]!.x));
  let prev = -Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    if (keep.has(i)) {
      prev = px(pts[i]!.x);
      continue;
    }
    const x = px(pts[i]!.x);
    if (x - prev < minGap) continue;
    if (anchors.some((a) => Math.abs(a - x) < minGap)) continue;
    keep.add(i);
    prev = x;
  }
  return pts
    .map((p, i) => ({ ...p, i }))
    .filter((p) => keep.has(p.i))
    .map(({ x, y, at, stuck, i }) => ({ x, y, at, stuck, current: i === last, peak: peakStuck > 0 && i === peakIdx && i !== last }));
}

/** The line's y (px) at x (px), from its points (px), linear between them. */
function lineYAt(pts: readonly { x: number; y: number }[], x: number): number {
  if (!pts.length) return 0;
  if (x <= pts[0]!.x) return pts[0]!.y;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return pts[pts.length - 1]!.y;
}

/** Where the value pill went: beside the dot (above or below it), at the plot's top, or in the readout strip above the plot. */
export type PillSide = "above" | "below" | "top" | "strip";

/**
 * Where the value pill sits for the current dot (all px, in the plot box). It
 * ends just right of the dot and stays inside the plot's width. Tried in turn:
 * above the dot, hugging the line, then below it, then at the plot's top; the
 * first spot where the line stays at least `clear` px away over the pill's
 * whole width wins. When the line leaves no room anywhere, the pill moves up into the
 * readout strip above the plot (top = -strip). It never covers the line; a
 * pill that is not beside its dot gets a dotted leader down to it.
 */
export function pillSpot(
  line: readonly { x: number; y: number }[],
  dot: { x: number; y: number },
  pill: { w: number; h: number },
  plot: { w: number; h: number },
  strip = 22,
  gap = 8,
  clear = 3,
): { left: number; top: number; side: PillSide; leader: boolean } {
  const left = Math.max(0, Math.min(plot.w - pill.w, dot.x + 6 - pill.w));
  const ys: number[] = [];
  for (let i = 0; i <= 16; i += 1) ys.push(lineYAt(line, left + (pill.w * i) / 16));
  const free = (top: number) => top >= 0 && top + pill.h <= plot.h && ys.every((y) => y < top - clear || y > top + pill.h + clear) && (dot.y < top - clear || dot.y > top + pill.h + clear);
  const tries: [PillSide, number][] = [
    // Hugging the line from above, then from below, as close to the dot as the line allows.
    ["above", Math.min(dot.y - gap, ...ys.map((y) => y - clear - 1)) - pill.h],
    ["below", Math.max(dot.y + gap, ...ys.map((y) => y + clear + 1))],
    ["top", 0],
  ];
  for (const [side, top] of tries) {
    if (!free(top)) continue;
    const away = side === "below" ? top - dot.y : dot.y - (top + pill.h);
    return { left, top, side, leader: away > 2 * gap };
  }
  return { left, top: -strip, side: "strip", leader: true };
}

/** The pill's words: the latest reading, with its age when it is an hour or more old. */
export function pillText(reading: { at: number; stuck: number }, nowMs: number): string {
  const n = Math.round(reading.stuck);
  const age = nowMs - reading.at >= HOUR_MS ? stuckFor(new Date(reading.at).toISOString(), nowMs) : "";
  return age ? `${n} · ${age} ago` : `${n} now`;
}

/** Initial for an agent's circle. */
export function initialOf(name: string): string {
  const c = name.trim().match(/[\p{L}\p{N}]/u);
  return c ? c[0]!.toUpperCase() : "?";
}
