/**
 * Reminders card helpers. Pure: no Date.now, no toLocale*, no randomness.
 *
 * `dueReminders` applies the same rule as the catalogue's reminders entry
 * (brief-catalogue.ts, measure()): a reminder counts when its dueAt parses
 * and falls no later than 48 hours after `now`. The card lists exactly what
 * the picker counted, so the two never disagree about what is on the page.
 * Labels ("due today", "said Thu") are display formatting: they read the
 * machine's local clock through Date getters, as the other cards do, but
 * never through toLocale*.
 */
import { clockLabel } from "./brief-time.js";
import type { BriefReminder } from "./brief-types.js";

export const DAY_MS = 86_400_000;
/** How far ahead a reminder may be due and still count: the end of tomorrow, as the picker reads it. */
export const REMINDER_WINDOW_MS = 2 * DAY_MS;
/** Rows on the card before "+N more". */
export const REMINDER_ROWS = 5;
/** A lone reminder's card at least this tall (px) has room for the said-to-due day strip. */
export const REMINDER_TALL_PX = 200;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day of an ISO time as YYYY-MM-DD; "" when it does not parse. */
export function localDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD plus n days, by UTC arithmetic on the date parts (machine-timezone independent). */
export function addDays(day: string, n: number): string {
  if (!DAY_RE.test(day)) return day;
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from day `a` to day `b` (both YYYY-MM-DD); 0 when either is malformed. */
export function dayDiff(a: string, b: string): number {
  if (!DAY_RE.test(a) || !DAY_RE.test(b)) return 0;
  const utc = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

/**
 * The reminders the picker counts: dated, and due no later than 48 hours
 * after `now`. Soonest due first, then the earlier said, then id, so the
 * order is the same on every render.
 */
export function dueReminders(reminders: readonly BriefReminder[] | null | undefined, now: string): BriefReminder[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];
  const dueMs = (r: BriefReminder) => (r.dueAt ? Date.parse(r.dueAt) : NaN);
  return (reminders ?? [])
    .filter((r) => {
      const t = dueMs(r);
      return Number.isFinite(t) && t <= nowMs + REMINDER_WINDOW_MS;
    })
    .sort((a, b) => dueMs(a) - dueMs(b) || a.saidAt.localeCompare(b.saidAt) || a.id.localeCompare(b.id));
}

export type DueState = "overdue" | "today" | "tomorrow" | "later";

/** Where a reminder's due day sits against the brief's local day. */
export function dueState(r: BriefReminder, today: string): DueState {
  const day = localDay(r.dueAt);
  if (!day) return "later";
  if (day < today) return "overdue";
  if (day === today) return "today";
  if (day === addDays(today, 1)) return "tomorrow";
  return "later";
}

/** "overdue", "due today", "due tomorrow", or "due Mon" for the odd one inside the 48h window. */
export function dueLabel(r: BriefReminder, today: string): string {
  switch (dueState(r, today)) {
    case "overdue":
      return "overdue";
    case "today":
      return "due today";
    case "tomorrow":
      return "due tomorrow";
    default: {
      const d = r.dueAt ? new Date(r.dueAt) : null;
      return d && !Number.isNaN(d.getTime()) ? `due ${WEEKDAYS[d.getDay()]}` : "due later";
    }
  }
}

/** "Oct 8" in local time. */
export function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "said today", "said Thu" inside the last week, else "said Oct 1". */
export function saidLabel(saidAt: string, now: string): string {
  const said = localDay(saidAt);
  const ref = localDay(now);
  if (!said || !ref) return "said";
  const diff = dayDiff(said, ref);
  if (diff === 0) return "said today";
  if (diff > 0 && diff < 7) return `said ${WEEKDAYS[new Date(saidAt).getDay()]}`;
  return `said ${dateLabel(saidAt)}`;
}

/** The quiet source line under the quote: "said Thu in a DM to yourself", or "said Thu" when nowhere was recorded. The due state is the pill's. */
export function sourceLine(r: BriefReminder, now: string): string {
  const where = r.where.trim();
  return `${saidLabel(r.saidAt, now)}${where ? ` in ${where}` : ""}`;
}

/**
 * The due pill's tone: its due state, or "done" once Done (or Start) marked it
 * in this brief. Overdue reads red, due today reads warm, the rest stay quiet.
 */
export type DueTone = DueState | "done";
export function dueTone(r: BriefReminder, today: string, cleared = false): DueTone {
  return cleared ? "done" : dueState(r, today);
}

/** A segment of the day strip's track, from one day to the next: time gone, time left, or time overdue. */
export type StripSeg = "past" | "ahead" | "late" | null;
export interface StripDay {
  day: string;
  /** "TUE": three letters, upper case. */
  label: string;
  said: boolean;
  due: boolean;
  today: boolean;
  /** The track coming in from the day before, and going out to the day after. */
  into: StripSeg;
  out: StripSeg;
}

const laterDay = (a: string, b: string) => (a > b ? a : b);

/**
 * The day strip under a lone reminder: `n` days with the track from the day
 * it was said to the later of due and today centred in it (a day more of
 * what is ahead when the room is odd), always ending at least a day after.
 * The track is solid for days gone, dotted for days left, and "late" from
 * the due day to today when it is overdue. A reminder said before the
 * window runs its track in from the left edge. Empty when the due day or
 * today does not parse. Days are calendar days (YYYY-MM-DD), so the strip is
 * the same on every machine for the same local days.
 */
export function reminderStrip(r: BriefReminder, today: string, n = 7): StripDay[] {
  const due = localDay(r.dueAt);
  const len = Math.floor(n);
  if (!due || !DAY_RE.test(today) || len < 1) return [];
  const said = localDay(r.saidAt) || due;
  const start = said < due ? said : due;
  const end = laterDay(due, today);
  const overdue = due < today;
  const span = dayDiff(start, end) + 1;
  const first = span + 1 > len ? addDays(end, 2 - len) : addDays(start, -Math.floor((len - span) / 2));
  const seg = (d: string): StripSeg => {
    const next = addDays(d, 1);
    if (d < start || next > end) return null;
    if (overdue) return d < due ? "past" : "late";
    return next <= today ? "past" : "ahead";
  };
  return Array.from({ length: len }, (_, i) => {
    const day = addDays(first, i);
    const [y, m, d] = day.split("-").map(Number);
    const wd = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    return {
      day,
      label: WEEKDAYS[wd]!.toUpperCase(),
      said: day === said && said !== due,
      due: day === due,
      today: day === today,
      into: seg(addDays(day, -1)),
      out: seg(day),
    };
  });
}

/** "Thu, Oct 8 at 2 PM" for the peek. */
export function whenLine(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${WEEKDAYS[d.getDay()]}, ${dateLabel(iso)} at ${clockLabel(iso)}`;
}

const GUARD =
  "Read what you need first. Stop and confirm with me before any irreversible step (merge, release, publish, deploy, or sending a message).";

/** The built-in prompt when the writer did not supply one: the owner's words, where they were said, and the guard. */
export function reminderPrompt(r: BriefReminder): string {
  const text = r.text.trim().replace(/[.?!]+$/, "");
  const where = r.where.trim();
  const said = where ? ` I said it in ${where}.` : "";
  return `You asked to be reminded: "${text}".${said} Pull the context from HQ, then do it, or lay out the first step and what you need from me. ${GUARD}`;
}

/** The first `max` rows and the rest, for the card and its "+N more" peek. */
export function reminderRows<T>(list: readonly T[], max = REMINDER_ROWS): { shown: T[]; rest: T[] } {
  const n = Math.max(0, Math.floor(max));
  return { shown: list.slice(0, n), rest: list.slice(n) };
}
