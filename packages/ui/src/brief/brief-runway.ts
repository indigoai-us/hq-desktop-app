/**
 * Focus time (the runway card): the free stretches of today's workday once
 * every call is padded, ranked by length. Pure: minutes are counted from the
 * local midnight of `now`, nothing reads the clock, nothing calls toLocale*.
 * The 12-hour labels here are arithmetic so the picker's review mode and the
 * card agree on the words.
 */

import type { BriefCalendarEvent, BriefPriority } from "./brief-types.js";

/** The runway runs 8:00 to 18:00 local. */
export const WORKDAY_START_MIN = 8 * 60;
export const WORKDAY_END_MIN = 18 * 60;
/** Every call is padded this much on both sides before the gaps are measured. */
export const PAD_MIN = 10;
/** Shorter free stretches are not focus time. */
export const MIN_GAP_MIN = 25;
export const DEEP_MIN = 90;
export const SOLID_MIN = 50;
/** A call with no end runs this long. Same default as the today strip. */
export const DEFAULT_EVENT_MIN = 30;
/** Ruler labels along the runway. */
export const RULER_HOURS = [8, 10, 12, 14, 16, 18] as const;

export type GapClass = "deep" | "solid" | "shallow";

export interface FocusGap {
  /** Stable key: "start-end" in minutes. */
  id: string;
  /** Local minutes from midnight, inside the workday. */
  startMin: number;
  endMin: number;
  minutes: number;
  cls: GapClass;
  /** 1 = the longest gap = the one to protect. */
  rank: number;
  /** The call the gap follows; null when it starts at the workday start or at `now`. */
  after: BriefCalendarEvent | null;
  /** The call the gap runs into; null when it runs to the end of the workday. */
  before: BriefCalendarEvent | null;
}

export interface RunwayPill {
  event: BriefCalendarEvent;
  /** Clipped to the workday. */
  startMin: number;
  endMin: number;
}

export interface Runway {
  /** Timed events, by start. */
  events: BriefCalendarEvent[];
  /** Calls that touch the workday, clipped to it. */
  pills: RunwayPill[];
  /** Free stretches of MIN_GAP_MIN or more, in time order. */
  gaps: FocusGap[];
  /** The same gaps, longest first. */
  ranked: FocusGap[];
  protect: FocusGap | null;
  /** The longest free stretch under MIN_GAP_MIN, for the overloaded line. */
  longestShort: { startMin: number; minutes: number } | null;
  /** `now` in minutes from its local midnight; null when it does not parse. */
  nowMin: number | null;
}

interface Busy {
  start: number;
  end: number;
  first: BriefCalendarEvent;
  last: BriefCalendarEvent;
}

const timed = (e: BriefCalendarEvent) => Number.isFinite(Date.parse(e.start));

function localMidnight(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Minutes of an event from the given midnight: [start, end], end defaulting to 30 minutes on. */
function spanMin(e: BriefCalendarEvent, midnight: number): [number, number] {
  const s = (Date.parse(e.start) - midnight) / 60_000;
  const endMs = e.end ? Date.parse(e.end) : NaN;
  const en = Number.isFinite(endMs) && endMs > Date.parse(e.start) ? (endMs - midnight) / 60_000 : s + DEFAULT_EVENT_MIN;
  return [s, en];
}

export function gapClass(minutes: number): GapClass {
  return minutes >= DEEP_MIN ? "deep" : minutes >= SOLID_MIN ? "solid" : "shallow";
}

/** "45 min", "1h 35m", "2h". Same words as the picker's fact clause. */
export function minutesText(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "9:25", "2:45" for minutes from midnight; with `suffix`, "9:25 AM". */
export function clockMin(min: number, suffix = false): string {
  const total = Math.round(min);
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const h = h24 % 12 || 12;
  const t = `${h}:${String(m).padStart(2, "0")}`;
  return suffix ? `${t} ${h24 >= 12 ? "PM" : "AM"}` : t;
}

/** "9:25–11:00". */
export const gapRange = (g: Pick<FocusGap, "startMin" | "endMin">, suffix = false) => `${clockMin(g.startMin, suffix)}–${clockMin(g.endMin, suffix)}`;

/** Where a gap sits on the 8:00–18:00 runway, as a percentage. */
export function pct(min: number): number {
  const x = ((min - WORKDAY_START_MIN) / (WORKDAY_END_MIN - WORKDAY_START_MIN)) * 100;
  return Math.max(0, Math.min(100, x));
}

/**
 * The day's runway: calls padded PAD_MIN on both sides and merged; the free
 * stretches between them inside the workday, from `now` on when the brief sits
 * inside the day; gaps under MIN_GAP_MIN dropped; the rest ranked by length.
 */
export function focusRunway(events: readonly BriefCalendarEvent[], now: string): Runway {
  const midnight = localMidnight(now);
  const nowMin = midnight == null ? null : (Date.parse(now) - midnight) / 60_000;
  const base = midnight ?? 0;
  const sorted = events
    .filter(timed)
    .slice()
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  const empty: Runway = { events: sorted, pills: [], gaps: [], ranked: [], protect: null, longestShort: null, nowMin };
  if (midnight == null) return empty;

  const pills: RunwayPill[] = [];
  const busy: Busy[] = [];
  for (const e of sorted) {
    const [s, en] = spanMin(e, base);
    if (en > WORKDAY_START_MIN && s < WORKDAY_END_MIN) {
      pills.push({ event: e, startMin: Math.max(WORKDAY_START_MIN, s), endMin: Math.min(WORKDAY_END_MIN, en) });
    }
    const ps = s - PAD_MIN;
    const pe = en + PAD_MIN;
    const prev = busy[busy.length - 1];
    if (prev && ps <= prev.end) {
      if (pe > prev.end) {
        prev.end = pe;
        prev.last = e;
      }
    } else {
      busy.push({ start: ps, end: pe, first: e, last: e });
    }
  }

  // Walk the day from the workday start, or from now when the brief sits inside it.
  let cursor = nowMin != null ? Math.max(WORKDAY_START_MIN, nowMin) : WORKDAY_START_MIN;
  let cursorFrom: BriefCalendarEvent | null = null;
  const free: Omit<FocusGap, "rank" | "cls" | "id">[] = [];
  let longestShort: Runway["longestShort"] = null;
  const consider = (start: number, end: number, after: BriefCalendarEvent | null, before: BriefCalendarEvent | null) => {
    const s = Math.max(start, WORKDAY_START_MIN);
    const en = Math.min(end, WORKDAY_END_MIN);
    const minutes = en - s;
    if (minutes <= 0) return;
    if (minutes >= MIN_GAP_MIN) free.push({ startMin: s, endMin: en, minutes, after, before });
    else if (!longestShort || minutes > longestShort.minutes) longestShort = { startMin: s, minutes };
  };
  for (const b of busy) {
    if (b.end <= cursor) {
      // Entirely behind us: the day's walk starts at now, not after this call.
      continue;
    }
    // A call after the workday does not bound the gap; the day's end does.
    consider(cursor, b.start, cursorFrom, b.start < WORKDAY_END_MIN ? b.first : null);
    cursor = Math.max(cursor, b.end);
    cursorFrom = b.last;
  }
  consider(cursor, WORKDAY_END_MIN, cursorFrom, null);

  const ranked = free
    .slice()
    .sort((a, b) => b.minutes - a.minutes || a.startMin - b.startMin)
    .map((g, i): FocusGap => ({ ...g, id: `${g.startMin}-${g.endMin}`, cls: gapClass(g.minutes), rank: i + 1 }));
  const gaps = ranked.slice().sort((a, b) => a.startMin - b.startMin);
  return { events: sorted, pills, gaps, ranked, protect: ranked[0] ?? null, longestShort, nowMin };
}

/** The ranked gaps alone (the catalogue's name for this computation). */
export function focusGaps(events: readonly BriefCalendarEvent[], now: string): FocusGap[] {
  return focusRunway(events, now).gaps;
}

/** "after Standup", "before Investor call", or "until 6:00" when nothing else is booked. */
export function gapWhere(g: FocusGap): string {
  if (g.after) return `after ${g.after.title}`;
  if (g.before) return `before ${g.before.title}`;
  return `until ${clockMin(WORKDAY_END_MIN)}`;
}

/** "1h 35m clear after Standup". The same shape as the picker's fact clause. */
export const gapText = (g: FocusGap) => `${minutesText(g.minutes)} clear ${gapWhere(g)}`;

/** The card's one line. */
export function runwayTitle(r: Runway): string {
  if (!r.events.length) return "Whole day open. Pick the hardest thing first.";
  if (r.nowMin != null && r.nowMin >= WORKDAY_END_MIN) return "No focus time left today.";
  if (r.protect) return `${gapText(r.protect)}. Protect it.`;
  if (r.longestShort) return `No focus block today. Longest gap is ${minutesText(r.longestShort.minutes)} at ${clockMin(r.longestShort.startMin)}.`;
  return `No focus block today. Booked solid until ${clockMin(WORKDAY_END_MIN)}.`;
}

/** The priority a ranked gap suggests: the longest gap takes priority 1, and so on. */
export function suggestionFor(priorities: readonly BriefPriority[], gap: FocusGap): BriefPriority | null {
  return priorities[gap.rank - 1] ?? null;
}

/** Launch id for a priority: its item when it has one, else its rank. */
export const priorityLaunchId = (p: BriefPriority) => p.itemId ?? `priority:${p.n}`;

/** A prompt for a priority with no written one: start it inside this block. */
export function priorityPrompt(p: BriefPriority, gap: FocusGap): string {
  const because = p.because ? ` ${p.because.replace(/\.\s*$/, "")}.` : "";
  return (
    `Today's priority ${p.n}: ${p.text.replace(/\.\s*$/, "")}.${because} ` +
    `I have ${minutesText(gap.minutes)} clear (${gapRange(gap, true)}). ` +
    `Pull the current state, lay out the steps that fit this block, and start on the first one. ` +
    `Ask before anything irreversible: no sends, deploys, or pushes without my ok.`
  );
}

/**
 * An event draft to paste into a calendar. Text only: the brief never writes
 * the calendar.
 */
export function calendarDraft(gap: FocusGap, task: string | null, dateLabel: string): string {
  return [
    `Focus block${task ? `: ${task}` : ""}`,
    `${dateLabel} · ${gapRange(gap, true)}`,
    "Protected focus time from your Daily Brief. Not booked yet: paste this into your calendar.",
  ].join("\n");
}
