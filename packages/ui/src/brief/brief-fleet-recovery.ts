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
