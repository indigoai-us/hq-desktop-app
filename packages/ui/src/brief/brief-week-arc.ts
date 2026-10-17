/**
 * Pure helpers for the "Your week" card (kind `weekArc`): day labels from the
 * date string alone (weekday by arithmetic, never the machine clock), the
 * beats worth a disc, the one-sentence arc title, the week's sums, its record
 * day and average, and the capsule geometry (merges per day). The picker's measure() in
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

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type BeatKind = NonNullable<BriefDay["beat"]>["kind"];

/** Per beat kind: the word the title uses, the disc's name, its colour and the peek tone. */
export const BEAT_STYLE: Record<BeatKind, { word: string; name: string; color: string; tone: BriefTone }> = {
  crisis: { word: "outage", name: "Crisis", color: "var(--b-red)", tone: "red" },
  resolution: { word: "recovery", name: "Resolution", color: "var(--b-ok)", tone: "ok" },
  push: { word: "record", name: "Push", color: "var(--b-decision)", tone: "decision" },
  turn: { word: "turn", name: "Turn", color: "var(--b-t1)", tone: "neutral" },
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

/** "Sun" for 2026-10-11: the column label (set in caps by the card). */
export function weekdayShort(date: string): string {
  return WEEKDAYS_SHORT[weekdayOf(date)] ?? "";
}

/** The date `n` days after `date`, YYYY-MM-DD, by UTC arithmetic on the string alone. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The week's sums: the hero number (merged) and the quiet line under the sentence. */
export function weekTotals(days: readonly BriefDay[]): { merged: number; sessions: number; meetings: number } {
  return days.reduce((t, d) => ({ merged: t.merged + d.merged, sessions: t.sessions + d.sessions, meetings: t.meetings + d.meetings }), { merged: 0, sessions: 0, meetings: 0 });
}

/** "18 sessions · 9 meetings": what else the week held, in plain words. */
export function weekMix(days: readonly BriefDay[]): string {
  const t = weekTotals(days);
  return `${plural(t.sessions, "session")} · ${plural(t.meetings, "meeting")}`;
}

/**
 * The week's record day, the one column in the brand colour: the (latest)
 * push beat when the writer named one, else the day with the most merges
 * (later wins a tie). Today's partial column only counts when it is the only
 * day with merges. -1 when nothing merged at all.
 */
export function recordIndex(days: readonly BriefDay[], today?: string): number {
  for (let i = days.length - 1; i >= 0; i -= 1) if (days[i]!.beat?.kind === "push") return i;
  const pick = (skipToday: boolean) => {
    let best = -1;
    days.forEach((d, i) => {
      if (skipToday && d.date === today) return;
      if (d.merged > 0 && (best < 0 || d.merged >= days[best]!.merged)) best = i;
    });
    return best;
  };
  const full = pick(true);
  return full >= 0 ? full : pick(false);
}

/** Mean merges a day over the full days (today's partial column left out when two others remain); null under two days. */
export function mergedAverage(days: readonly BriefDay[], today?: string): number | null {
  const full = days.filter((d) => d.date !== today);
  const use = full.length >= 2 ? full : days;
  if (use.length < 2) return null;
  return Math.round((use.reduce((n, d) => n + d.merged, 0) / use.length) * 10) / 10;
}

export interface WeekColumn {
  date: string;
  merged: number;
  /** 0..1 share of the busiest day's merges (an all-zero week stays flat). */
  share: number;
  today: boolean;
  record: boolean;
}

/** One capsule per day, its height the day's merges against the busiest day. */
export function weekColumns(days: readonly BriefDay[], today?: string): WeekColumn[] {
  const max = Math.max(1, ...days.map((d) => d.merged));
  const rec = recordIndex(days, today);
  return days.map((d, i) => ({ date: d.date, merged: d.merged, share: round2(d.merged / max), today: d.date === today, record: i === rec }));
}

/** The average as a share of the busiest day, for the dotted line; null when there is no line to draw. */
export function averageShare(days: readonly BriefDay[], today?: string): number | null {
  const avg = mergedAverage(days, today);
  if (avg == null || avg <= 0) return null;
  return round2(avg / Math.max(1, ...days.map((d) => d.merged)));
}

/**
 * The days still to come, as empty ghost columns, up to a seven-column week:
 * only when the data ends on today or today is one of those next days (a
 * morning brief before today has any work in it). Otherwise none.
 */
export function futureDays(days: readonly BriefDay[], today: string, span = 7): string[] {
  const last = days[days.length - 1]?.date;
  if (!last) return [];
  const next = Array.from({ length: Math.max(0, span - days.length) }, (_, i) => addDays(last, i + 1));
  return last === today || next.includes(today) ? next : [];
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
