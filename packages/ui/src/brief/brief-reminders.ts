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

/** The mono line under the quote: "said Thu in a DM to yourself · due today". */
export function saidLine(r: BriefReminder, now: string, today: string): string {
  const where = r.where.trim();
  return `${saidLabel(r.saidAt, now)}${where ? ` in ${where}` : ""} · ${dueLabel(r, today)}`;
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
