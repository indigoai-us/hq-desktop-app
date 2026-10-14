/**
 * Pure helpers for the Yesterday (meetings) card: which rows it shows, the
 * second window guard behind the catalogue gate, the signal and length lines
 * of a row's peek, and the day-over-day footer. Display only; the picker
 * never reads this file.
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
 * "4 meetings · 2 the day before": yesterday's count against the day
 * before, from the sweep's days. Null unless both days are known.
 */
export function meetingsFooter(days: readonly BriefDay[] | null | undefined, today: string | null | undefined): string | null {
  if (!days?.length || !today) return null;
  const y = shiftDay(today, -1);
  const b = shiftDay(today, -2);
  if (!y || !b) return null;
  const yesterday = days.find((d) => d.date === y);
  const before = days.find((d) => d.date === b);
  if (!yesterday || !before) return null;
  return `${plural(yesterday.meetings, "meeting")} · ${before.meetings} the day before`;
}
