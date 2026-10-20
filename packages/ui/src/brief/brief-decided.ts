/**
 * What got settled: the decisions made in meetings you attended inside the
 * brief's window, one row per decided line. Pure, so the window rule, the
 * 90-character face line, the title copy and the peeks are testable without
 * the DOM. The window and the attended rule mirror the picker's `decided`
 * entry (meetingsInWindow + decidedLines), so the card and the picker count
 * the same lines. No toLocale*: times come in from the component.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import type { BriefLine, BriefMeeting } from "./brief-types.js";
import { clockLabel } from "./brief-time.js";

export const DAY_MS = 86_400_000;
/** The picker hides the card below this many decided lines; the card does too. */
export const DECIDED_MIN = 3;
/** Longest face line; longer text is cut on a word and ends with an ellipsis. */
export const LINE_MAX = 90;
/** A window wider than this is a catch-up, not "yesterday". */
export const AWAY_MS = 36 * 3_600_000;

export interface DecidedRow {
  /** `${meeting.id}:d${index}`: stable across renders, unique per line. */
  id: string;
  /** The full decision text, whitespace collapsed. */
  text: string;
  /** The face line: at most LINE_MAX characters, cut on a word. */
  line: string;
  meeting: BriefMeeting;
  /** The meeting left you a to-do, or the line names you: yours, not "without you". */
  mine: boolean;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Meetings you attended inside the window, by start time then id (the picker's order). */
export function meetingsInWindow(meetings: readonly BriefMeeting[], windowFrom: number): BriefMeeting[] {
  return meetings
    .filter((m) => m.attended !== false && Date.parse(m.startTime) >= windowFrom)
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
}

/** The meeting's title as a person says it: whitespace collapsed, nothing else. */
export function meetingLabel(title: string): string {
  return squash(title) || "Meeting";
}

/**
 * Cut long text on a word so the face line stays under `max` characters,
 * ending with an ellipsis. Short text comes back untouched. A single word
 * longer than the limit is cut hard.
 */
export function truncateLine(text: string, max = LINE_MAX): string {
  const t = squash(text);
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  const cut = head.lastIndexOf(" ");
  const base = (cut > max * 0.4 ? head.slice(0, cut) : head).replace(/[\s,;:.\-–—(]+$/u, "");
  return `${base}…`;
}

/** True when the owner's first name appears in the text as a word. */
export function namesOwner(text: string, userName: string | null | undefined): boolean {
  const first = (userName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first.length < 2) return false;
  return new RegExp(`(^|[^\\p{L}])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu").test(text);
}

/** One row per decided line of every in-window meeting, in meeting order. Blank lines are skipped. */
export function decidedRows(meetings: readonly BriefMeeting[], windowFrom: number, userName: string | null | undefined = null): DecidedRow[] {
  const out: DecidedRow[] = [];
  for (const m of meetingsInWindow(meetings, windowFrom)) {
    const mineTodo = (m.todo ?? []).some((t) => t.mine);
    (m.decided ?? []).forEach((raw, i) => {
      const text = squash(raw);
      if (!text) return;
      out.push({ id: `${m.id}:d${i}`, text, line: truncateLine(text), meeting: m, mine: mineTodo || namesOwner(text, userName) });
    });
  }
  return out;
}

export interface DecidedGroup {
  meeting: BriefMeeting;
  rows: DecidedRow[];
}

/**
 * The shown rows under their meetings: one group per meeting, in row order,
 * so the card names each meeting once and its decisions sit under it.
 */
export function groupByMeeting(rows: readonly DecidedRow[]): DecidedGroup[] {
  const out: DecidedGroup[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.meeting.id === r.meeting.id) last.rows.push(r);
    else out.push({ meeting: r.meeting, rows: [r] });
  }
  return out;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A group heading's time: "2 PM", or "Mon 2 PM" when the window is a
 * catch-up and its meetings fall on different days. Local time, no toLocale.
 */
export function headingWhen(iso: string, withDay: boolean): string {
  const clock = clockLabel(iso);
  if (!withDay || !clock) return clock;
  return `${WEEKDAYS[new Date(iso).getDay()]} ${clock}`;
}

/** True when the rows' meetings start on more than one local day. */
export function spansDays(rows: readonly DecidedRow[]): boolean {
  const days = new Set(rows.map((r) => new Date(r.meeting.startTime).toDateString()));
  return days.size > 1;
}

/** "6 decisions made yesterday without you"; "while you were away" on a catch-up window. */
export function settledTitle(n: number, opts: { mine: boolean; away: boolean }): string {
  const what = `${n} decision${n === 1 ? "" : "s"} made ${opts.away ? "while you were away" : "yesterday"}`;
  return opts.mine ? what : `${what} without you`;
}

/** "Oct 10, 2 PM" in local time, for the peek eyebrow and the prompt. */
export function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clockLabel(iso)}`;
}

const sentence = (t: string) => (/[.?!]$/.test(t) ? t : `${t}.`);

/** The follow-up prompt: summarise, draft in the owner's voice, show it, send nothing. */
export function followUpPrompt(meeting: string, text: string, when: string): string {
  const where = when ? `${meeting} (${when})` : meeting;
  return `Follow up on a decision from ${where}: ${sentence(text)} Check HQ for context first. Summarise the decision in two lines, then draft the follow-up message in my voice and show it to me. Do not send anything.`;
}

/** A row's peek: the full text, the meeting and time, the company chip, and "Follow up in <engine>". */
export function rowPeek(row: DecidedRow, when: string): PeekContent {
  const m = row.meeting;
  const title = meetingLabel(m.title);
  const status = [title, when, m.with ? `with ${m.with}` : null].filter(Boolean).join(" · ");
  return {
    compact: true,
    eyebrow: "Decided",
    origin: m.companyUid ? { companyUid: m.companyUid, label: title } : undefined,
    title: row.text,
    status,
    sections: [],
    prompt: { id: row.id, text: followUpPrompt(title, row.text, when), verb: "Follow up" },
  };
}

/** The "+N more" row's peek: the lines that did not fit, each with its meeting's time. */
export function morePeek(rest: readonly DecidedRow[], time: (iso: string) => string): PeekContent {
  const lines: BriefLine[] = rest.map((r) => ({ label: r.line, state: time(r.meeting.startTime), tone: "decision" }));
  return {
    title: `${rest.length} more decision${rest.length === 1 ? "" : "s"}`,
    status: "Also settled in these meetings",
    sections: [{ label: "Decided", lines }],
  };
}
