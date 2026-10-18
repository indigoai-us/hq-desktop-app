/**
 * Daily Brief data model. `BriefInput` is the normalized day the generator
 * reads; `brief-data.ts` builds it from the PlatformAdapter, and the dev
 * harness can seed it directly. Every list may be empty: the brief composes
 * from whatever the day actually has.
 */

/** Grid widget kinds, in registry order. `fleet` and `otherWork` are gone (owner-rejected). */
export type BriefWidgetKind =
  | "sunrise"
  | "catchup"
  | "needs"
  | "oneThing"
  | "blockedByMe"
  | "incident"
  | "fleetRecovery"
  | "resolved"
  | "risk"
  | "waiting"
  | "carry"
  | "handoffs"
  | "shipped"
  | "firsts"
  | "releaseTrain"
  | "meetings"
  | "decided"
  | "weekArc"
  | "team"
  | "agenda"
  | "runway"
  | "focus"
  | "reminders";

/** Slot size classes. An XL may span 6x2 in quiet template 1 (the span comes from the areas). */
export type BriefSlotSize = "XL" | "L" | "M" | "W" | "W3" | "S";

/** Owner preferences the picker reads, copied by the writer into brief.json prefs_applied.widgets. */
export interface BriefPrefs {
  density: "auto" | "calm" | "full";
  /** "always show X": tier 2 tail, below cards that contain a priority. */
  pinned: BriefWidgetKind[];
  /** "never show X": excluded. sunrise, catchup and needs are ignored here. */
  hidden: BriefWidgetKind[];
  /** -2..2, five points each. */
  weights: Partial<Record<BriefWidgetKind, number>>;
}

/** Content keys of the previous ready brief, for rotation. Built read-only by brief-data.ts. */
export interface BriefPrevious {
  runId: string;
  hashes: Partial<Record<BriefWidgetKind, string>>;
}

/** Where an item came from: the company (for its logo) and the repo or org. */
export interface BriefOrigin {
  companyUid: string | null;
  /** "indigoai-us/hq-core", "Calendar", "Indigo on X"... Shown as a chip. */
  repo: string | null;
  /** The product the item is about ("Desktop app"), when the writer names it. */
  product?: string | null;
}

export type BriefTone = "ok" | "warn" | "decision" | "red" | "neutral";

/** One line in a peek card or a shipped card: label plus a short state. */
export interface BriefLine {
  label: string;
  state: string;
  tone?: BriefTone;
  /** A small tag after the label, e.g. "you" on your own to-do. */
  tag?: string;
  /** A line you can act on: the peek shows Start and Copy prompt under it. */
  prompt?: { id: string; text: string };
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
  /** Action items from the meeting, for the peek; `mine` marks the owner's own. */
  todo?: BriefTodo[];
  /** false when the owner did not attend; such meetings never reach the page. */
  attended?: boolean;
  durationMin?: number | null;
}

export interface BriefTodo {
  text: string;
  owner?: string | null;
  /** The brief owner's own to-do: the peek offers to start it. */
  mine?: boolean;
}

/** One of today's priorities, linked to the item it is about. */
export interface BriefPriority {
  companyUid?: string | null;
  n: number;
  text: string;
  because: string | null;
  /** id of the decision or incident the row opens. */
  itemId: string | null;
  /** brief_rank unblock score, shown in the row peek. Not used by the picker. */
  score?: number | null;
}

export type BriefDecisionAction = "cut" | "go" | "decide" | "reply" | "prep";

/** A person or piece of work that waits on one of the owner's calls. */
export interface BriefBlocked {
  who: string;
  what: string;
  kind: "person" | "work";
  origin?: BriefOrigin;
}

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
  ageHours?: number | null;
  effort?: "quick" | "medium" | "large";
  peopleWaiting?: number;
  revenue?: boolean;
  blocks?: BriefBlocked[];
  /** meeting_signals | dms | main_health | prs | fleet */
  source?: string;
  /** Consecutive earlier briefs this item appeared in (from items.carry); 0 or absent = new today. */
  carriedBriefs?: number;
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
  /** Red main CI: what is red, where, and since when. */
  ci?: {
    repo: string;
    workflow: string | null;
    job: string | null;
    /** ISO time it went red. */
    since: string | null;
    ageHours: number | null;
    note: string | null;
    /** Merged changes to the repo after it went red. */
    mergesOnTop?: number | null;
  };
}

export interface BriefShipped {
  id: string;
  sample?: boolean;
  title: string;
  status: string;
  note: string;
  origin: BriefOrigin;
  lines: BriefLine[];
  first?: boolean;
  why?: string;
  highlights?: string[];
  mergeHoursMedian?: number | null;
}

export interface BriefWaiting {
  id: string;
  sample?: boolean;
  who: string;
  what: string;
  /** Launch prompt written by the brief run; replaces the built-in one. */
  prompt?: string;
  ageHours?: number | null;
  kind?: "dm" | "review" | "handoff" | "other";
  origin?: BriefOrigin;
}

export interface BriefCarry {
  id: string;
  title: string;
  why: string;
  origin: BriefOrigin;
  carriedFrom: string;
  carriedSince: string | null;
  /** Consecutive ready briefs it has appeared in (1 = first carry). */
  briefs: number;
  /** id of today's decision or incident that continues it, if any. */
  itemId: string | null;
  prompt?: string;
}

export interface BriefHandoff {
  id: string;
  object: string;
  from: string;
  to: string;
  me: boolean;
  production: boolean;
  since: string;
  /** null = unknown, never shown as done. */
  receipts: { access: boolean | null; ack: boolean | null; active: boolean | null };
  note?: string;
  origin: BriefOrigin;
  prompt?: string;
}

export interface BriefRelease {
  product: string;
  version: string | null;
  origin: BriefOrigin;
  releasedAt: string | null;
  pending: { day: string; count: number; theme: string }[];
  pendingCount: number;
  held: { title: string; why: string }[];
  light: "ok" | "warn" | "red";
  prompt?: string;
}

export interface BriefDay {
  /** YYYY-MM-DD local. */
  date: string;
  sessions: number;
  meetings: number;
  merged: number;
  opened: number;
  beat?: { kind: "turn" | "crisis" | "resolution" | "push"; label: string; evidence?: string };
}

export interface BriefMainHealth {
  repo: string;
  product: string | null;
  companyUid: string | null;
  workflows: number;
  red: { workflow: string; since: string | null; mergesOnTop: number | null }[];
  delta?: { newlyRed: string[]; stillRed: string[]; recovered: string[] };
}

export interface BriefRecovered {
  id: string;
  title: string;
  what: string;
  at: string | null;
  source: "main_health" | "fleet" | "session";
  origin: BriefOrigin;
  timeline?: { at: string; text: string }[];
  /** Post-incident lines when the writer supplies them. */
  postIncident?: { broke: string; did: string; changes: string };
}

export interface BriefFleetIncident {
  companyUid?: string | null;
  id: string;
  series: { at: string; stuck: number }[];
  incidentStart: string | null;
  incidentEnd: string | null;
  verdict: "healing" | "healed" | "plateaued" | "relapsing";
  stillStuck: { name: string; reason: string; since: string | null }[];
  fixes: { label: string; at: string; origin: BriefOrigin }[];
}

export interface BriefTeammate {
  companyUid?: string | null;
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
  load?: "clear" | "steady" | "heavy" | "storm";
  owes?: string[];
  thanks?: string | null;
}

/** A work session. Sessions in companies outside the brief's set are counted only. */
export interface BriefSession {
  id: string;
  title: string;
  startedAt: string;
  workstream: string;
  /** Company uid or slug the session ran in. */
  company: string | null;
  /** you | agent | lane; absent means yours. */
  kind?: string;
  project?: string | null;
  product?: string | null;
  endedAt?: string | null;
  hasHandoff?: boolean;
}

export interface BriefReminder {
  companyUid?: string | null;
  id: string;
  /** The owner's own words, verbatim. */
  text: string;
  saidAt: string;
  where: string;
  dueAt?: string | null;
  prompt?: string;
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
  /** Today's priorities from brief.json; absent in older briefs (the page derives them). */
  priorities?: BriefPriority[];
  /** PRs across the sweep window. */
  prWindow?: { from: string; to: string; total: number; merged: number; byRepo: { repo: string; total: number; merged: number }[] } | null;
  /** The calendar strip is illustrative (no live calendar). */
  calendarSample?: boolean;
  /** One quiet line per source that could not be read ("Calendar could not be read."). Never a priority. */
  sourceNotes?: string[];
  /** Local calendar date of the brief, YYYY-MM-DD, from brief-data.json window.today. The only source of weekday. */
  today?: string;
  /** brief.json lead_hint. */
  leadHint?: string | null;
  /** brief.json catch_up. */
  catchUp?: boolean;
  prefs?: BriefPrefs;
  previous?: BriefPrevious | null;
  carry?: BriefCarry[];
  handoffs?: BriefHandoff[];
  releases?: BriefRelease[];
  mainHealth?: BriefMainHealth[];
  recovered?: BriefRecovered[];
  fleetIncident?: BriefFleetIncident | null;
  fleetIncidents?: BriefFleetIncident[];
  /** Up to 7 local days, oldest first. */
  days?: BriefDay[];
  reminders?: BriefReminder[];
  /** Local dates with a landing, newest last. */
  landedDays?: string[];
  /** Sum of effort minutes over open decisions, when the writer wrote it. */
  timeToClearMin?: number | null;
  runId?: string | null;
  previousRunId?: string | null;
}
