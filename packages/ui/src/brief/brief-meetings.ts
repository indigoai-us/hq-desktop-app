/**
 * Pure helpers for the Meetings card: which rows it shows, the second window
 * guard behind the catalogue gate, the signal and length lines of a row's
 * peek, the day-over-day line, the people a meeting was with, and the time
 * axis its capsules sit on. Display only; the picker never reads this file.
 */
import type { BriefDay, BriefMeeting } from "./brief-types.js";

/** Rows per slot: M (two rows) and W3 (three columns) show 5; W and S show 3; then "+N more". */
export const MEETING_ROWS_NARROW = 3;
export const MEETING_ROWS_WIDE = 5;
const DAY_MS = 86_400_000;

export function meetingsLimit(rows: number, cols: number): number {
  return rows > 1 || cols >= 3 ? MEETING_ROWS_WIDE : MEETING_ROWS_NARROW;
}

/**
 * The start of the card's window in ms, the same way the catalogue computes
 * it: `windowFrom` (a catch-up day's last brief) when it is a real time before
 * `now`, else 24 hours before `now`. Null when `now` is unknown: then the
 * catalogue gate is the only guard.
 */
export function meetingWindowFrom(now: string | null | undefined, windowFrom: string | null | undefined): number | null {
  if (!now) return null;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;
  const fromMs = windowFrom ? Date.parse(windowFrom) : NaN;
  return Number.isFinite(fromMs) && fromMs < nowMs ? fromMs : nowMs - DAY_MS;
}

/**
 * The rows the card carries: meetings the owner attended (attended !== false)
 * that started inside the window, oldest first, ties by id. Meetings with an
 * unreadable start time are dropped when a window applies.
 */
export function meetingsShown(meetings: readonly BriefMeeting[], now: string | null | undefined, windowFrom: string | null | undefined = null): BriefMeeting[] {
  const from = meetingWindowFrom(now, windowFrom);
  return meetings
    .filter((m) => m.attended !== false)
    .filter((m) => from == null || Date.parse(m.startTime) >= from)
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 decisions · 2 action items · 1 risk"; only the counts above zero; null when there are none. */
export function signalsText(m: Pick<BriefMeeting, "decisions" | "actions" | "risks">): string | null {
  const parts: string[] = [];
  if (m.decisions > 0) parts.push(plural(m.decisions, "decision"));
  if (m.actions > 0) parts.push(plural(m.actions, "action item"));
  if (m.risks > 0) parts.push(plural(m.risks, "risk"));
  return parts.length ? parts.join(" · ") : null;
}

/** "45m", "1h", "1h 15m" from minutes; null when unknown or not positive. */
export function lengthText(durationMin: number | null | undefined): string | null {
  if (durationMin == null || !Number.isFinite(durationMin) || durationMin <= 0) return null;
  const min = Math.round(durationMin);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The row's label: the title, then who it was with. */
export function meetingLabel(m: Pick<BriefMeeting, "title" | "with">): string {
  return m.with ? `${m.title} · ${m.with}` : m.title;
}

/** YYYY-MM-DD shifted by whole days, by UTC arithmetic (no local clock, no DST). */
export function shiftDay(day: string, delta: number): string | null {
  const parts = day.split("-").map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return null;
  const [y, m, d] = parts as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + delta * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Yesterday's meeting count against the day before, in plain words:
 * "Up from 2 the day before", "Down from 3 the day before", "Same as the
 * day before". On a catch-up window (`away`) the card's number covers more
 * than yesterday, so the line names both days: "4 yesterday, 2 the day
 * before". Null unless both days are in the sweep.
 */
export function meetingsFooter(days: readonly BriefDay[] | null | undefined, today: string | null | undefined, away = false): string | null {
  if (!days?.length || !today) return null;
  const y = shiftDay(today, -1);
  const b = shiftDay(today, -2);
  if (!y || !b) return null;
  const yesterday = days.find((d) => d.date === y);
  const before = days.find((d) => d.date === b);
  if (!yesterday || !before) return null;
  const was = before.meetings === 0 ? "none" : String(before.meetings);
  if (away) return `${yesterday.meetings} yesterday, ${was} the day before`;
  if (yesterday.meetings === before.meetings) return "Same as the day before";
  return `${yesterday.meetings > before.meetings ? "Up" : "Down"} from ${was} the day before`;
}

/** Words that make a title part a meeting name, not a person ("Sales Sync", "Dev Standup"). */
const MEETING_WORDS = new Set(
  "all hands sync standup stand up call meeting review team sales dev weekly daily monthly series training prep board investor investors advisory demo kickoff kick off intro planning retro check in one on 1:1 office hours interview onboarding offsite update group product design eng engineering marketing ops gtm hq"
    .split(" "),
);
const NAME_WORD = /^\p{Lu}[\p{L}'’.-]*$/u;

/** A title part that reads as a person: one to three capitalised words, none of them a meeting word. */
function personLike(part: string): boolean {
  const words = part.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return words.every((w) => NAME_WORD.test(w) && !MEETING_WORDS.has(w.toLowerCase()) && !/^\p{Lu}{2,}$/u.test(w));
}

/**
 * Who the meeting was with, as far as the card can tell without an attendee
 * list: the `with` field, the named owners of its to-dos, and a title made
 * only of names ("Jacob / Corey", "Don Ranns and Jacob Posel"). A title with
 * any meeting word in it ("HQ Dev Standup", "HQ <> Sales Sync") names nobody.
 * First seen first, no repeats by first name, case-insensitive.
 */
export function meetingPeople(m: Pick<BriefMeeting, "title" | "with" | "todo">): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | null | undefined) => {
    const n = (name ?? "").replace(/\s+/g, " ").trim();
    if (!n) return;
    const key = n.split(" ")[0]!.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  const SPLIT = /\s*(?:\/|\+|&|<>|,|\band\b)\s*/i;
  const parts = m.title.split(SPLIT).filter((p) => p.trim());
  if (parts.length >= 2 && parts.every(personLike)) parts.forEach(add);
  for (const w of (m.with ?? "").split(SPLIT)) if (personLike(w)) add(w);
  for (const t of m.todo ?? []) if (!t.mine && t.owner && personLike(t.owner)) add(t.owner);
  return out;
}

/** "JC" for "Jacob Corey", "J" for "Jacob": first and last initials, upper case. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const first = words[0]![0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

const HOUR_MS = 3_600_000;
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export interface MeetingTick {
  /** Fraction of the axis, 0..1: the hour, or the start of the day on a day axis. */
  at: number;
  /** "9 AM", or a weekday ("MON") on an axis that spans days. */
  label: string;
}

export interface MeetingAxis {
  from: number;
  to: number;
  /** The meetings run over more than one day (a catch-up window): ticks are days, not hours. */
  days: boolean;
  ticks: MeetingTick[];
}

/** "9 AM" for a local hour, without toLocale. */
function hourLabel(ms: number): string {
  const h = new Date(ms).getHours();
  return `${h % 12 || 12} ${h >= 12 ? "PM" : "AM"}`;
}

/**
 * The time axis the capsules sit on: whole hours from the first start to the
 * last end (a meeting of unknown length counts as half an hour), at least
 * four hours wide, with at most `maxTicks` hour labels on a round step. When
 * the meetings span more than a day the axis runs midnight to midnight and
 * the ticks are weekdays. Null when no start time reads.
 */
export function meetingAxis(ms: readonly Pick<BriefMeeting, "startTime" | "durationMin">[], maxTicks = 5): MeetingAxis | null {
  const spans = ms
    .map((m) => {
      const s = Date.parse(m.startTime);
      const len = m.durationMin != null && Number.isFinite(m.durationMin) && m.durationMin > 0 ? m.durationMin : 30;
      return Number.isFinite(s) ? [s, s + len * 60_000] : null;
    })
    .filter((x): x is number[] => !!x);
  if (!spans.length) return null;
  const first = Math.min(...spans.map((x) => x[0]!));
  const last = Math.max(...spans.map((x) => x[1]!));
  if (last - first > 30 * HOUR_MS) {
    const a = new Date(first);
    a.setHours(0, 0, 0, 0);
    const b = new Date(last);
    if (b.getHours() || b.getMinutes() || b.getSeconds() || b.getMilliseconds()) {
      b.setHours(0, 0, 0, 0);
      b.setDate(b.getDate() + 1);
    }
    const from = a.getTime();
    const to = b.getTime();
    const ticks: MeetingTick[] = [];
    const d = new Date(from);
    while (d.getTime() < to) {
      ticks.push({ at: (d.getTime() - from) / (to - from), label: WEEKDAYS[d.getDay()]! });
      d.setDate(d.getDate() + 1);
    }
    const step = Math.ceil(ticks.length / Math.max(1, maxTicks));
    return { from, to, days: true, ticks: ticks.filter((_, i) => i % step === 0) };
  }
  const floor = new Date(first);
  floor.setMinutes(0, 0, 0);
  const ceil = new Date(last);
  if (ceil.getMinutes() || ceil.getSeconds() || ceil.getMilliseconds()) {
    ceil.setMinutes(0, 0, 0);
    ceil.setTime(ceil.getTime() + HOUR_MS);
  }
  let from = floor.getTime();
  let to = ceil.getTime();
  const MIN_SPAN = 4 * HOUR_MS;
  if (to - from < MIN_SPAN) {
    const extra = Math.round((MIN_SPAN - (to - from)) / HOUR_MS);
    from -= Math.floor(extra / 2) * HOUR_MS;
    to += Math.ceil(extra / 2) * HOUR_MS;
  }
  const hours = Math.round((to - from) / HOUR_MS);
  const step = [1, 2, 3, 4, 6, 12].find((s) => Math.floor(hours / s) + 1 <= Math.max(2, maxTicks)) ?? 12;
  const ticks: MeetingTick[] = [];
  for (let h = 0; h <= hours; h += step) ticks.push({ at: h / hours, label: hourLabel(from + h * HOUR_MS) });
  return { from, to, days: false, ticks };
}

/**
 * Where a meeting's capsule sits on the axis, as fractions: `left` from its
 * start, `width` from its length (null when the length is unknown: the
 * capsule is drawn as a round dot). Clamped to the axis.
 */
export function capsuleOf(m: Pick<BriefMeeting, "startTime" | "durationMin">, axis: MeetingAxis): { left: number; width: number | null } {
  const span = axis.to - axis.from;
  const s = Date.parse(m.startTime);
  const left = Number.isFinite(s) ? Math.min(1, Math.max(0, (s - axis.from) / span)) : 0;
  const len = m.durationMin != null && Number.isFinite(m.durationMin) && m.durationMin > 0 ? (m.durationMin * 60_000) / span : null;
  return { left, width: len == null ? null : Math.min(1 - left, len) };
}

/** "10 AM · 45M": when a meeting started and how long it ran, for the mono label beside its capsule. A day axis adds the weekday. */
export function capsuleLabel(m: Pick<BriefMeeting, "startTime" | "durationMin">, days = false): string {
  const d = new Date(m.startTime);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const min = d.getMinutes();
  const clock = `${h % 12 || 12}${min ? `:${String(min).padStart(2, "0")}` : ""} ${h >= 12 ? "PM" : "AM"}`;
  const when = days ? `${WEEKDAYS[d.getDay()]} ${clock}` : clock;
  const len = lengthText(m.durationMin);
  return len ? `${when} · ${len}` : when;
}

/** Total minutes in meetings, only when every meeting's length is known; else null. */
export function meetingsMinutes(ms: readonly Pick<BriefMeeting, "durationMin">[]): number | null {
  if (!ms.length) return null;
  let n = 0;
  for (const m of ms) {
    if (m.durationMin == null || !Number.isFinite(m.durationMin) || m.durationMin <= 0) return null;
    n += m.durationMin;
  }
  return n;
}
