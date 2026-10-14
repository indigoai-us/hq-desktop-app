/**
 * Pure helpers for the Today (agenda) card: the rows it shows (calls in time
 * order, busy holds folded into one row), the headline, the countdown and
 * the prep prompt of an event's peek. Display only; the picker never reads
 * this file, so local-time labels are fine here.
 */
import { dropCoveredBusy, spanOf } from "./brief-strip.js";
import { clockLabel } from "./brief-time.js";
import type { BriefCalendarEvent } from "./brief-types.js";

/** Rows per slot: M (two rows) and W3 (three columns) show 5; W and S show 3; then "+N more". */
export const AGENDA_ROWS_NARROW = 3;
export const AGENDA_ROWS_WIDE = 5;
export const BUSY_ROW_ID = "busy";

export function agendaLimit(rows: number, cols: number): number {
  return rows > 1 || cols >= 3 ? AGENDA_ROWS_WIDE : AGENDA_ROWS_NARROW;
}

export type AgendaRow =
  | { kind: "call"; id: string; start: number; end: number; e: BriefCalendarEvent }
  | { kind: "busy"; id: typeof BUSY_ROW_ID; start: number; end: number; holds: BriefCalendarEvent[] };

const byStart = <T extends { start: number; id: string }>(a: T, b: T) => a.start - b.start || a.id.localeCompare(b.id);

/** Named, timed events in time order. Busy holds are not calls. */
export function agendaCalls(events: readonly BriefCalendarEvent[]): BriefCalendarEvent[] {
  return events
    .filter((e) => !e.busy)
    .map((e) => ({ e, s: spanOf(e) }))
    .filter((x): x is { e: BriefCalendarEvent; s: NonNullable<ReturnType<typeof spanOf>> } => x.s != null)
    .sort((a, b) => a.s.start - b.s.start || a.e.id.localeCompare(b.e.id))
    .map((x) => x.e);
}

/** Busy holds that no named event covers, in time order. */
export function agendaHolds(events: readonly BriefCalendarEvent[]): BriefCalendarEvent[] {
  return dropCoveredBusy(events)
    .filter((e) => e.busy)
    .map((e) => ({ e, s: spanOf(e) }))
    .filter((x): x is { e: BriefCalendarEvent; s: NonNullable<ReturnType<typeof spanOf>> } => x.s != null)
    .sort((a, b) => a.s.start - b.s.start || a.e.id.localeCompare(b.e.id))
    .map((x) => x.e);
}

/**
 * The card's rows: every call, plus one row for all the uncovered busy holds
 * ("Busy until 2 PM"). The busy row sits at the hold that is running or next
 * (relative to `now`; the first hold when `now` is unknown or all have passed)
 * and reads its end time.
 */
export function agendaRows(events: readonly BriefCalendarEvent[], now: string | null | undefined): AgendaRow[] {
  const rows: AgendaRow[] = agendaCalls(events).map((e) => {
    const s = spanOf(e)!;
    return { kind: "call", id: e.id, start: s.start, end: s.end, e };
  });
  const holds = agendaHolds(events);
  if (holds.length) {
    const nowMs = now ? Date.parse(now) : NaN;
    const spans = holds.map((h) => spanOf(h)!);
    let i = Number.isFinite(nowMs) ? spans.findIndex((s) => s.end > nowMs) : -1;
    if (i < 0) i = 0;
    rows.push({ kind: "busy", id: BUSY_ROW_ID, start: spans[i]!.start, end: spans[i]!.end, holds });
  }
  return rows.sort(byStart);
}

/** "30m", "1h", "1h 30m". */
export function durationText(minutes: number): string {
  const min = Math.max(1, Math.round(minutes));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The headline. Before the first call: "5 calls · first at 9 AM". Once the
 * day has started: "Nothing until 10:30" when no call is running, "5 calls ·
 * next at 10:30" when one is, "All 5 calls done" after the last. No calls:
 * "No calls today".
 */
export function agendaTitle(events: readonly BriefCalendarEvent[], now: string | null | undefined): string {
  const calls = agendaCalls(events);
  const n = calls.length;
  if (!n) return "No calls today";
  const count = `${n} call${n === 1 ? "" : "s"}`;
  const spans = calls.map((e) => spanOf(e)!);
  const nowMs = now ? Date.parse(now) : NaN;
  if (!Number.isFinite(nowMs) || nowMs < spans[0]!.start) return `${count} · first at ${clockLabel(calls[0]!.start)}`;
  const next = spans.findIndex((s) => s.start > nowMs);
  const running = spans.some((s) => s.start <= nowMs && nowMs < s.end);
  if (next < 0) return running ? `${count} · last one running` : `All ${count} done`;
  const at = clockLabel(calls[next]!.start);
  return running ? `${count} · next at ${at}` : `Nothing until ${at}`;
}

/** "in 2h 15m", "in 40m", "started 10m ago", "started just now", "ended"; null when `now` is unknown. */
export function countdownText(e: Pick<BriefCalendarEvent, "start" | "end">, now: string | null | undefined): string | null {
  const s = spanOf(e);
  const nowMs = now ? Date.parse(now) : NaN;
  if (!s || !Number.isFinite(nowMs)) return null;
  if (nowMs < s.start) return `in ${durationText((s.start - nowMs) / 60_000)}`;
  if (nowMs < s.end) {
    const ago = Math.round((nowMs - s.start) / 60_000);
    return ago < 1 ? "started just now" : `started ${durationText(ago)} ago`;
  }
  return "ended";
}

/** "team call", "with outside people", "learning session". */
export function kindLabel(kind: BriefCalendarEvent["kind"]): string {
  return kind === "ext" ? "with outside people" : kind === "learn" ? "learning session" : "team call";
}

/** Short mono label for the peek eyebrow. */
export function kindEyebrow(kind: BriefCalendarEvent["kind"]): string {
  return kind === "ext" ? "External" : kind === "learn" ? "Learning" : "Team";
}

/** The prep prompt behind "Prep in Claude": the strip's wording, with the projected caveat when it applies. */
export function prepPrompt(e: BriefCalendarEvent): string {
  const s = spanOf(e);
  const length = s ? durationText((s.end - s.start) / 60_000) : "30m";
  const at = clockLabel(e.start);
  const projected = e.projected ? " The event is projected from a recurring series; confirm it is on today's calendar first." : "";
  return (
    `I have "${e.title}" today at ${at} (${length}, ${kindLabel(e.kind)}).${projected} ` +
    `Search HQ meetings, DMs and knowledge for prior sessions of this meeting and anything open that touches me, ` +
    `then give me a 5-line prep card: purpose, what changed since last time, what I owe, one thing to raise, and the next step.`
  );
}

/** The launch id for an event's prep prompt. */
export const prepId = (e: Pick<BriefCalendarEvent, "id">): string => `prep:${e.id}`;
