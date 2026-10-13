/**
 * Pure helpers for the "Your week" card (kind `weekArc`): day labels from the
 * date string alone (weekday by arithmetic, never the machine clock), the
 * beats worth a disc, the one-sentence arc title, the stacked-bar geometry and
 * the smooth line over the bar tops. The picker's measure() in
 * brief-catalogue.ts counts the same thing this file does: a beat is any day
 * with `beat` set. No toLocale*, no Date.now.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { weekdayOf } from "./brief-catalogue.js";
import type { BriefDay, BriefTone } from "./brief-types.js";

/** Discs on the chart; more beats go to the "+N more" peek. */
export const MAX_BEATS = 4;
/** Fewer days than this and the card hides itself (the picker's gate too). */
export const MIN_DAYS = 3;
/** Share of the chart height the busiest day reaches; the rest is room for discs. */
export const BAR_SCALE = 0.84;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type BeatKind = NonNullable<BriefDay["beat"]>["kind"];

/** Per beat kind: the word the title uses, the disc's name, its colour and the peek tone. */
export const BEAT_STYLE: Record<BeatKind, { word: string; name: string; color: string; tone: BriefTone }> = {
  crisis: { word: "outage", name: "Crisis", color: "var(--b-red)", tone: "red" },
  resolution: { word: "recovery", name: "Resolution", color: "var(--b-ok)", tone: "ok" },
  push: { word: "record", name: "Push", color: "var(--b-violet)", tone: "decision" },
  turn: { word: "turn", name: "Turn", color: "#ffffff", tone: "neutral" },
};
const BEAT_WEIGHT: Record<BeatKind, number> = { crisis: 4, resolution: 3, push: 2, turn: 1 };

export interface WeekBeat {
  date: string;
  kind: BeatKind;
  /** The writer's words. */
  label: string;
  evidence: string | null;
  /** Position in `days`. */
  index: number;
  /** Bigger beats win a disc and the title. */
  weight: number;
}

export interface DayBar {
  date: string;
  sessions: number;
  meetings: number;
  merged: number;
  total: number;
  /** 0..1 share of the busiest day. */
  share: number;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Day of month from YYYY-MM-DD, as a number ("2026-10-08" -> 8). */
export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10)) || 0;
}

/** "Thursday" for 2026-10-08, by arithmetic on the date string. */
export function weekdayName(date: string): string {
  return WEEKDAYS[weekdayOf(date)] ?? "";
}

/** "Thu 8" for 2026-10-08. */
export function dayLabel(date: string): string {
  return `${WEEKDAYS_SHORT[weekdayOf(date)] ?? ""} ${dayOfMonth(date)}`.trim();
}

/** "Oct 8" for 2026-10-08. */
export function monthDay(date: string): string {
  const m = Number(date.slice(5, 7));
  return `${MONTHS_SHORT[m - 1] ?? ""} ${dayOfMonth(date)}`.trim();
}

/** "Oct 4–9" across one month, "Sep 28 – Oct 4" across two; one day alone reads "Oct 4". */
export function rangeLabel(days: readonly BriefDay[]): string {
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  if (!first || !last) return "";
  if (first === last) return monthDay(first);
  return first.slice(0, 7) === last.slice(0, 7) ? `${monthDay(first)}–${dayOfMonth(last)}` : `${monthDay(first)} – ${monthDay(last)}`;
}

/** "Thu 8: 2 sessions, 6 meetings, 34 merged". */
export function dayTip(d: BriefDay): string {
  return `${dayLabel(d.date)}: ${plural(d.sessions, "session")}, ${plural(d.meetings, "meeting")}, ${d.merged} merged`;
}

/** Every day with a beat, oldest first. Same count as the picker's measure(). */
export function beats(days: readonly BriefDay[]): WeekBeat[] {
  const out: WeekBeat[] = [];
  days.forEach((d, index) => {
    if (!d.beat) return;
    out.push({
      date: d.date,
      kind: d.beat.kind,
      label: d.beat.label,
      evidence: d.beat.evidence?.trim() || null,
      index,
      weight: BEAT_WEIGHT[d.beat.kind] ?? 0,
    });
  });
  return out;
}

/** Biggest first; among equals the later day (fresher) first. */
const byWeight = (a: WeekBeat, b: WeekBeat) => b.weight - a.weight || b.index - a.index;
const byDay = (a: WeekBeat, b: WeekBeat) => a.index - b.index;

/**
 * The beats that get a disc (at most `max`, biggest first, shown in day order)
 * and the rest for the "+N more" peek (day order).
 */
export function pickBeats(days: readonly BriefDay[], max = MAX_BEATS): { shown: WeekBeat[]; rest: WeekBeat[] } {
  const all = beats(days);
  if (all.length <= max) return { shown: all, rest: [] };
  const keep = new Set([...all].sort(byWeight).slice(0, max).map((b) => b.index));
  return { shown: all.filter((b) => keep.has(b.index)), rest: all.filter((b) => !keep.has(b.index)) };
}

/**
 * Where merges went across the week, first full day to last: up when the last
 * day has at least double and three more, down for the mirror. Today's partial
 * column is left out when there are at least two other days. Null = flat.
 */
export function mergeTrend(days: readonly BriefDay[], today?: string): { from: number; to: number; dir: "up" | "down" } | null {
  const full = days.filter((d) => d.date !== today);
  const use = full.length >= 2 ? full : days;
  if (use.length < 2) return null;
  const from = use[0]!.merged;
  const to = use[use.length - 1]!.merged;
  if (to >= from * 2 && to - from >= 3) return { from, to, dir: "up" };
  if (from >= to * 2 && from - to >= 3) return { from, to, dir: "down" };
  return null;
}

/**
 * The card's one sentence, from the two biggest beats: "Outage Tuesday,
 * recovery Thursday." One beat adds the merge trend ("Record Thursday, and
 * merges climbed from 2 to 34."); no beats is the trend alone ("Merges
 * climbed from 2 to 34.") or "Steady week." A beat on `today` says "today".
 * Kind words only: no repo names, PR numbers or labels reach the title.
 */
export function arcSentence(days: readonly BriefDay[], today?: string): string {
  const all = beats(days);
  const when = (b: WeekBeat) => (b.date === today ? "today" : weekdayName(b.date));
  if (all.length >= 2) {
    const [a, b] = [...all].sort(byWeight).slice(0, 2).sort(byDay) as [WeekBeat, WeekBeat];
    const wa = BEAT_STYLE[a.kind].word;
    const wb = BEAT_STYLE[b.kind].word;
    if (when(a) === when(b)) return `${cap(wa)} and ${wb} ${when(a)}.`;
    return `${cap(wa)} ${when(a)}, ${wb} ${when(b)}.`;
  }
  const trend = mergeTrend(days, today);
  const clause = trend ? `merges ${trend.dir === "up" ? "climbed" : "fell"} from ${trend.from} to ${trend.to}` : null;
  if (all.length === 1) {
    const b = all[0]!;
    const head = `${cap(BEAT_STYLE[b.kind].word)} ${when(b)}`;
    return clause ? `${head}, and ${clause}.` : `${head}, otherwise steady.`;
  }
  return clause ? `${cap(clause)}.` : "Steady week.";
}

/** One stacked bar per day; `share` is against the busiest day (an all-zero week stays flat). */
export function bars(days: readonly BriefDay[]): DayBar[] {
  const totals = days.map((d) => d.sessions + d.meetings + d.merged);
  const max = Math.max(1, ...totals);
  return days.map((d, i) => ({
    date: d.date,
    sessions: d.sessions,
    meetings: d.meetings,
    merged: d.merged,
    total: totals[i]!,
    share: totals[i]! / max,
  }));
}

/** Bar tops in chart percent: x at each column's centre, y from the top (100 = baseline). */
export function linePoints(days: readonly BriefDay[]): { x: number; y: number }[] {
  const b = bars(days);
  return b.map((d, i) => ({ x: round2(((i + 0.5) / b.length) * 100), y: round2(100 - d.share * BAR_SCALE * 100) }));
}

/** A smooth cubic path through the points: horizontal tangents, control points at the midpoints. */
export function linePath(pts: readonly { x: number; y: number }[]): string {
  const first = pts[0];
  if (!first) return "";
  let d = `M${first.x},${first.y}`;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const mx = round2((a.x + b.x) / 2);
    d += ` C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
  }
  return d;
}

/** The hover card for a beat disc: the writer's label, the kind and day, the evidence. */
export function beatPeek(b: WeekBeat): PeekContent {
  return {
    title: b.label,
    status: `${BEAT_STYLE[b.kind].name} · ${dayLabel(b.date)}`,
    sections: b.evidence ? [{ label: "Evidence", text: b.evidence }] : [],
  };
}

/** The hover card for a day column: its counts, and its beat when it has one. */
export function dayPeek(d: BriefDay, today?: string): PeekContent {
  const sections: PeekContent["sections"] = [];
  if (d.beat) sections.push({ label: BEAT_STYLE[d.beat.kind].name, tone: BEAT_STYLE[d.beat.kind].tone, text: d.beat.evidence?.trim() ? `${d.beat.label}. ${d.beat.evidence.trim()}` : d.beat.label });
  return {
    title: d.date === today ? `${dayLabel(d.date)} · today so far` : dayLabel(d.date),
    status: `${plural(d.sessions, "session")} · ${plural(d.meetings, "meeting")} · ${d.merged} merged${d.opened ? ` · ${d.opened} opened` : ""}`,
    sections,
  };
}

/** The "+N more" peek: the beats that did not get a disc, in day order. */
export function restPeek(rest: readonly WeekBeat[]): PeekContent {
  return {
    title: `${plural(rest.length, "more turning point")}`,
    sections: [{ label: "Also this week", lines: rest.map((b) => ({ label: b.label, state: dayLabel(b.date).toUpperCase(), tone: BEAT_STYLE[b.kind].tone })) }],
  };
}
