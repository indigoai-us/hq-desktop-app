/**
 * Daily Brief data model. `BriefInput` is the normalized day the generator
 * reads; `brief-data.ts` builds it from the PlatformAdapter, and the dev
 * harness can seed it directly. Every list may be empty: the brief composes
 * from whatever the day actually has.
 */

/** Where an item came from: the company (for its logo) and the repo or org. */
export interface BriefOrigin {
  companyUid: string | null;
  /** "indigoai-us/hq-core", "Calendar", "Indigo on X"... Shown as a chip. */
  repo: string | null;
}

export type BriefTone = "ok" | "warn" | "decision" | "red" | "neutral";

/** One line in a peek card or a shipped card: label plus a short state. */
export interface BriefLine {
  label: string;
  state: string;
  tone?: BriefTone;
}

export interface BriefCalendarEvent {
  id: string;
  title: string;
  /** ISO start. */
  start: string;
  end?: string | null;
  /** team = internal, ext = outside people, learn = learning or live sessions. */
  kind: "team" | "ext" | "learn";
  /** Projected from a recurring series rather than read from the calendar. */
  projected?: boolean;
  /** A free/busy placeholder with no title: hatched, unlabeled. */
  busy?: boolean;
  /** You answered "maybe": dashed outline, as in Meetings. */
  tentative?: boolean;
  /** Attendee names for the hover peek (you are left out). */
  attendees?: string[];
  /** Join link (Meet, Zoom, Teams, Webex), when the event has one. */
  joinUrl?: string | null;
}

export interface BriefMeeting {
  id: string;
  title: string;
  /** Who or what the meeting was with, shown muted. */
  with?: string;
  startTime: string;
  companyUid: string | null;
  decisions: number;
  actions: number;
  risks: number;
  questions: number;
  summary?: string;
  /** Up to three decisions made in the meeting, for the peek. */
  decided?: string[];
  /** Up to two action items from the meeting, for the peek. */
  todo?: string[];
}

export type BriefDecisionAction = "cut" | "go" | "decide" | "reply" | "prep";

export interface BriefDecision {
  id: string;
  /** Illustrative item with no real source yet; the peek marks it SAMPLE. */
  sample?: boolean;
  title: string;
  /** One work-level line for the card. */
  summary: string;
  action: BriefDecisionAction;
  /** Button label; defaults from the action. */
  actionLabel?: string;
  /** For `decide`: the two answers the button splits into on hover. */
  choices?: [string, string];
  origin: BriefOrigin;
  /** The generator shows `why` on the card itself only when this is set. */
  important?: boolean;
  /** Launch prompt written by the brief run; replaces the built-in one. */
  prompt?: string;
  detail?: {
    why: string;
    unlocks: BriefLine[];
    risk?: string;
    source: string;
  };
}

export interface BriefActionItem {
  id: string;
  title: string;
  origin: BriefOrigin;
}

export interface BriefRisk {
  id: string;
  sample?: boolean;
  title: string;
  summary: string;
  /** incident = live and on fire; watch = a standing risk. */
  severity: "incident" | "watch";
  /** For incidents with a measured fleet: healthy of total. */
  measure?: { healthy: number; total: number; unit: string; cause: string };
  /** Fix PRs or links in flight. */
  links: { label: string; origin: BriefOrigin }[];
  origin: BriefOrigin;
  /** Launch prompt written by the brief run; replaces the built-in one. */
  prompt?: string;
}

export interface BriefShipped {
  id: string;
  sample?: boolean;
  title: string;
  status: string;
  note: string;
  origin: BriefOrigin;
  lines: BriefLine[];
}

export interface BriefWaiting {
  id: string;
  sample?: boolean;
  who: string;
  what: string;
  /** Launch prompt written by the brief run; replaces the built-in one. */
  prompt?: string;
}

export interface BriefTeammate {
  id: string;
  sample?: boolean;
  name: string;
  doing: string;
  /** Status dot: ok = shipping, warn = you wait on them, decision = needs you. */
  tone: BriefTone;
  /** Fleet agent (agt_ uid) rather than a person. */
  isAgent?: boolean;
  /** DMs from them in the brief's window, shown as a small badge. */
  dmCount?: number;
  detail?: {
    status: string;
    between: BriefLine[];
    owns: string[];
    next: string;
  };
}

/** A work session. Sessions in companies outside the brief's set are counted only. */
export interface BriefSession {
  id: string;
  title: string;
  startedAt: string;
  workstream: string;
  /** Company uid or slug the session ran in. */
  company: string | null;
}

export interface BriefInput {
  /** ISO time the brief is generated for. */
  now: string;
  userName: string;
  /** Company uids/slugs whose work this brief may detail. */
  companies: string[];
  calendarToday: BriefCalendarEvent[];
  meetingsYesterday: BriefMeeting[];
  decisions: BriefDecision[];
  actionItems: BriefActionItem[];
  risks: BriefRisk[];
  shipped: BriefShipped[];
  /** PR totals for the shipped card, when known. */
  merged?: number | null;
  opened?: number | null;
  waitingOn: BriefWaiting[];
  team: BriefTeammate[];
  sessions: BriefSession[];
  /** Sessions started in the 24 hours before `now`, for the sunrise timeline. */
  recentSessions?: BriefSession[];
  /** ISO of the last brief the user opened, or null for never. */
  lastBriefAt: string | null;
  /** DMs read for this brief, for the provenance line. */
  dmCount?: number;
  /** Fleet agents by status, when the sweep read them. */
  fleet?: { total: number; active: number; dormant: number; provisioning: number } | null;
  /** PRs across the sweep window. */
  prWindow?: { from: string; to: string; total: number; merged: number; byRepo: { repo: string; total: number; merged: number }[] } | null;
  /** The calendar strip is illustrative (no live calendar). */
  calendarSample?: boolean;
}
