/**
 * Meetings rail model (console-rail US-021).
 *
 * Pure presentation data for the Meetings sidepane (Live, Today, Tomorrow,
 * Past) and the live meeting canvas (room strip, Outline, Notes, Signals).
 * Inputs are the meetings-store snapshot (which itself hydrates from
 * meetings-cache first), so everything here paints from cache on the first
 * frame. No Svelte, no Tauri, no timers.
 */

import {
  botForEvent,
  eventEnd,
  eventStart,
  isActiveBotStatus,
  isListableMeeting,
  type MeetingEvent,
  type ScheduledBot,
} from "./meetings-model";
import { daySectionLabel } from "../chat/sidebar-model";

/** Past calendar rows shown before the "Earlier" affordance. */
export const MEETINGS_PAST_ROW_LIMIT = 8;
/** Recorded history rows kept in Past (one hq-pro page per scope). */
export const MEETINGS_RECORDED_ROW_LIMIT = 50;

export type MeetingsSectionId = "live" | "today" | "tomorrow" | "past";

export interface MeetingsRailRow {
  id: string;
  title: string;
  /** "11:00" start time; elapsed for live. Past rows sit under a day header. */
  time: string;
  companyUid: string | null;
  /** Two-letter company mark; null for personal calendars. */
  companyMark: string | null;
  live: boolean;
  /** Past row with a saved recap (notes mark). */
  hasRecap: boolean;
  hasRecording: boolean;
  /** Recorded rows: "45m"; null when unknown or not a recording. */
  duration?: string | null;
  /** Company name for the row (personal scope lists every company). */
  companyLabel?: string | null;
  /** Meeting start in epoch ms, for local-day labels such as the recap heading. */
  startMs?: number | null;
  /** A meeting from today that has already ended; drawn quieter in the Today section. */
  past?: boolean;
}

export interface MeetingsRailSection {
  id: MeetingsSectionId;
  /** Unique render key; past splits into one section per local day. */
  key: string;
  /** Day-group label in the Messages grammar, e.g. "YESTERDAY · OCT 1". */
  label: string;
  rows: MeetingsRailRow[];
}

export interface MeetingsFilter {
  /** null = all companies. */
  companyUid: string | null;
  hasRecording: boolean;
  hasRecap: boolean;
  liveOnly: boolean;
}

export const EMPTY_MEETINGS_FILTER: MeetingsFilter = {
  companyUid: null,
  hasRecording: false,
  hasRecap: false,
  liveOnly: false,
};

export function activeFilterCount(filter: MeetingsFilter): number {
  return (
    (filter.companyUid ? 1 : 0) +
    (filter.hasRecording ? 1 : 0) +
    (filter.hasRecap ? 1 : 0) +
    (filter.liveOnly ? 1 : 0)
  );
}

function dayKey(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function clockLabel(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Heading for the empty-canvas recap card (QA-098). Compares local calendar
 * days, so a meeting earlier today reads Today's recap even when UTC has
 * already rolled over to tomorrow.
 */
export function recapHeading(startMs: number | null | undefined, now: Date): string {
  if (typeof startMs !== "number" || !Number.isFinite(startMs)) return "Latest recap";
  const day = dayKey(new Date(startMs));
  const today = dayKey(now);
  if (day === today) return "Today's recap";
  if (day === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) {
    return "Yesterday's recap";
  }
  return "Latest recap";
}

export function shortDateLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function elapsedLabel(start: Date | null, now: Date): string {
  if (!start) return "now";
  const mins = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Two-letter mark from a company name ("LiveRecover" → "LR", "Indigo" → "IN"). */
export function companyMark(name: string | null | undefined): string | null {
  const clean = (name ?? "").trim();
  if (!clean) return null;
  const caps = clean.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return `${caps[0]}${caps[1]}`;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Live = the clock is inside the event window, or its notetaker is in the
 * call right now. Cancelled events never count.
 */
export function isLiveMeeting(
  event: MeetingEvent,
  now: Date,
  bot?: ScheduledBot,
): boolean {
  if (event.status === "cancelled") return false;
  if (event.room?.live === true) return true;
  const status = bot?.status?.toLowerCase() ?? "";
  if (status.includes("in_call") || status.includes("recording")) return true;
  const start = eventStart(event);
  const end = eventEnd(event);
  if (!start || !end || !event.start.dateTime) return false;
  return start.getTime() <= now.getTime() && now.getTime() < end.getTime();
}

function hasRecap(event: MeetingEvent, bot: ScheduledBot | undefined): boolean {
  if (bot?.sourceLanded) return true;
  return Array.isArray(event.notes) && event.notes.length > 0;
}

export interface MeetingsRailInput {
  events: readonly MeetingEvent[];
  botsByEventId: Map<string, ScheduledBot>;
  scheduledBots?: ScheduledBot[];
  companyNamesByUid: Map<string, string>;
  filter?: MeetingsFilter;
  now?: Date;
}

/**
 * Live, Today · <date>, Tomorrow, Past. Today holds every meeting of the
 * local day, ended and upcoming, in start order. Tomorrow stays hidden until
 * today is over: nothing upcoming or live remains today. Empty sections are
 * dropped; Past is newest-first and capped so the pane stays short.
 */
export function meetingsRailSections(input: MeetingsRailInput): MeetingsRailSection[] {
  const now = input.now ?? new Date();
  const filter = input.filter ?? EMPTY_MEETINGS_FILTER;
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const live: MeetingsRailRow[] = [];
  const todayRows: MeetingsRailRow[] = [];
  const tomorrowRows: MeetingsRailRow[] = [];
  const past: Array<{ at: number; row: MeetingsRailRow; recorded: boolean }> = [];
  const upcoming: Array<{ at: number; row: MeetingsRailRow; bucket: MeetingsRailRow[] }> = [];

  for (const event of input.events) {
    if (event.status === "cancelled") continue;
    const recordedMeta = event.recorded ?? null;
    if (!recordedMeta && !isListableMeeting(event)) continue;
    const start = eventStart(event);
    if (!start) continue;
    const end = eventEnd(event) ?? start;
    const bot = botForEvent(event, input.botsByEventId, input.scheduledBots);
    const companyUid = event.sourceCompanyUid ?? null;
    const isLive = isLiveMeeting(event, now, bot);
    const recap = recordedMeta ? recordedMeta.hasSignals : hasRecap(event, bot);
    const recording = Boolean(bot && isActiveBotStatus(bot.status));
    if (filter.companyUid && companyUid !== filter.companyUid) continue;
    if (filter.liveOnly && !isLive) continue;
    if (filter.hasRecap && !recap) continue;
    if (filter.hasRecording && !recording && !bot?.sourceLanded && !recordedMeta) continue;
    const companyLabel = companyUid ? (input.companyNamesByUid.get(companyUid) ?? null) : null;
    const base = {
      id: event.id,
      title: event.summary?.trim() || "Untitled meeting",
      companyUid,
      companyMark: companyUid
        ? companyMark(input.companyNamesByUid.get(companyUid) ?? null)
        : null,
      live: isLive,
      hasRecap: false,
      hasRecording: recording,
      duration: recordedMeta?.durationLabel ?? null,
      companyLabel,
      startMs: start.getTime(),
    };
    if (recordedMeta) {
      past.push({
        at: start.getTime(),
        row: { ...base, live: false, time: clockLabel(start), hasRecap: recap },
        recorded: true,
      });
      continue;
    }
    if (isLive) {
      live.push({ ...base, time: elapsedLabel(start, now) });
      continue;
    }
    if (end.getTime() <= now.getTime()) {
      past.push({
        at: end.getTime(),
        row: { ...base, time: clockLabel(start), hasRecap: recap },
        recorded: false,
      });
      continue;
    }
    const day = dayKey(start);
    const bucket = day === today ? todayRows : day === tomorrow ? tomorrowRows : null;
    if (!bucket) continue;
    upcoming.push({ at: start.getTime(), row: { ...base, time: clockLabel(start) }, bucket });
  }

  upcoming.sort((a, b) => a.at - b.at);
  for (const u of upcoming) u.bucket.push(u.row);
  past.sort((a, b) => b.at - a.at);
  // Calendar past rows stay capped; recorded history is the meeting archive
  // and keeps up to one server page so older meetings remain reachable.
  let calendarPast = 0;
  let recordedPast = 0;
  const pastRows = past
    .filter((p) =>
      p.recorded
        ? recordedPast++ < MEETINGS_RECORDED_ROW_LIMIT
        : calendarPast++ < MEETINGS_PAST_ROW_LIMIT,
    )
    .map((p) => p.row);

  // Ended meetings from today join the Today section; older days keep
  // one header each below it.
  const olderPast: MeetingsRailRow[] = [];
  const todayPast: MeetingsRailRow[] = [];
  for (const row of pastRows) {
    if (dayKey(new Date(row.startMs ?? 0)) === today) todayPast.push({ ...row, past: true });
    else olderPast.push(row);
  }
  const todayAll = [...todayPast, ...todayRows].sort(
    (a, b) => (a.startMs ?? 0) - (b.startMs ?? 0),
  );
  const liveToday = live.some((r) => dayKey(new Date(r.startMs ?? 0)) === today);
  const todayOver = todayRows.length === 0 && !liveToday;

  const sections: MeetingsRailSection[] = [];
  if (live.length) sections.push({ id: "live", key: "live", label: "Live", rows: live });
  if (todayAll.length)
    sections.push({ id: "today", key: "today", label: daySectionLabel(now.getTime(), now.getTime()), rows: todayAll });
  if (todayOver && tomorrowRows.length)
    sections.push({ id: "tomorrow", key: "tomorrow", label: "Tomorrow", rows: tomorrowRows });
  // Past: one header per local day, the date shown only when it changes.
  for (const row of olderPast) {
    const day = dayKey(new Date(row.startMs ?? 0));
    const key = `past-${day}`;
    const last = sections.at(-1);
    if (last?.key === key) {
      last.rows.push(row);
      continue;
    }
    sections.push({ id: "past", key, label: daySectionLabel(day, now.getTime()), rows: [row] });
  }
  return sections;
}

/**
 * Default selection is the live meeting only. With nothing live the canvas
 * stays on the empty state (US-022) until a row is clicked.
 */
export function defaultMeetingId(sections: readonly MeetingsRailSection[]): string | null {
  return sections.find((s) => s.id === "live")?.rows[0]?.id ?? null;
}

/** Companies offered in the filter popover, with meeting counts. */
export function filterCompanies(
  events: readonly MeetingEvent[],
  companyNamesByUid: Map<string, string>,
): Array<{ uid: string; label: string; mark: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (!event.recorded && !isListableMeeting(event)) continue;
    const uid = event.sourceCompanyUid;
    if (uid) counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  return Array.from(counts, ([uid, count]) => {
    const label = companyNamesByUid.get(uid) ?? "Company";
    return { uid, label, mark: companyMark(label) ?? "?", count };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ── Room strip ──────────────────────────────────────────────────────────

export interface RoomPerson {
  id: string;
  name: string;
  initials: string;
  kind: "human" | "bot";
  live: boolean;
  speaking: boolean;
  /** Invited but not in the room (dashed ring). */
  invited: boolean;
}

export interface RoomStrip {
  people: RoomPerson[];
  speaker: RoomPerson | null;
  /** "Corey is speaking · 4 people, 1 bot in the room · Andrew invited". */
  summary: string;
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * Room roster: live participants from the meeting room (notetaker presence)
 * when present, otherwise calendar attendees as invited. The speaker comes
 * first so the ring is always visible.
 */
export function roomStrip(event: MeetingEvent | null | undefined): RoomStrip {
  if (!event) return { people: [], speaker: null, summary: "" };
  const people: RoomPerson[] = [];
  const seen = new Set<string>();
  const speakerId = event.room?.speakerId ?? null;
  for (const p of event.room?.participants ?? []) {
    const name = p.name?.trim() || p.id;
    const id = p.id || name;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    people.push({
      id,
      name,
      initials: initialsOf(name),
      kind: p.kind === "bot" ? "bot" : "human",
      live: p.live !== false,
      speaking: Boolean(p.speaking) || (speakerId != null && speakerId === id),
      invited: false,
    });
  }
  for (const a of event.attendees ?? []) {
    if (a.resource) continue;
    const id = a.email?.trim() || a.displayName?.trim() || "";
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const name = a.displayName?.trim() || id.split("@")[0];
    people.push({
      id,
      name,
      initials: initialsOf(name),
      kind: "human",
      live: false,
      speaking: false,
      invited: true,
    });
  }
  people.sort((a, b) => Number(b.speaking) - Number(a.speaking));
  const speaker = people.find((p) => p.speaking) ?? null;
  const inRoom = people.filter((p) => p.live);
  const humans = inRoom.filter((p) => p.kind === "human").length;
  const bots = inRoom.length - humans;
  const invited = people.filter((p) => p.invited);
  const parts: string[] = [];
  if (speaker) parts.push(`${firstName(speaker.name)} is speaking`);
  if (inRoom.length) {
    const room = [`${humans} ${humans === 1 ? "person" : "people"}`];
    if (bots) room.push(`${bots} ${bots === 1 ? "bot" : "bots"}`);
    parts.push(`${room.join(", ")} in the room`);
  }
  if (invited.length) {
    parts.push(
      invited.length <= 2
        ? `${invited.map((p) => firstName(p.name)).join(", ")} invited`
        : `${invited.length} invited`,
    );
  }
  return { people, speaker, summary: parts.join(" · ") };
}

// ── Outline and notes ───────────────────────────────────────────────────

export interface OutlineItem {
  id: string;
  title: string;
  detail: string | null;
  state: "done" | "now" | "todo";
  children: Array<{ id: string; title: string; done: boolean }>;
}

export function outlineItems(event: MeetingEvent | null | undefined): OutlineItem[] {
  return (event?.outline ?? []).map((item, i) => ({
    id: item.id ?? `o${i}`,
    title: item.title,
    detail: item.detail ?? null,
    state: item.state === "done" || item.state === "now" ? item.state : "todo",
    children: (item.children ?? []).map((c, j) => ({
      id: c.id ?? `o${i}.${j}`,
      title: c.title,
      done: Boolean(c.done),
    })),
  }));
}

export interface NoteLine {
  id: string;
  author: string;
  initials: string;
  kind: "human" | "bot";
  at: string;
  text: string;
  typing: boolean;
}

export function noteLines(event: MeetingEvent | null | undefined): NoteLine[] {
  return (event?.notes ?? []).map((n, i) => {
    const author = n.author?.trim() || "Notetaker";
    return {
      id: n.id ?? `n${i}`,
      author,
      initials: initialsOf(author),
      kind: n.kind === "bot" ? "bot" : "human",
      at: n.at ?? "",
      text: n.text ?? "",
      typing: Boolean(n.typing),
    };
  });
}

// ── Signals ─────────────────────────────────────────────────────────────

export type SignalKind = "action" | "decision" | "question" | "risk";
export type SignalAction = "confirm" | "edit" | "dismiss" | "answer" | "park";

export const SIGNAL_ACTIONS: Record<SignalKind, readonly SignalAction[]> = {
  action: ["confirm", "edit", "dismiss"],
  decision: ["confirm", "edit", "dismiss"],
  question: ["answer", "park"],
  risk: ["confirm", "edit", "dismiss"],
};

export const SIGNAL_ACTION_LABEL: Record<SignalAction, string> = {
  confirm: "Confirm",
  edit: "Edit",
  dismiss: "Dismiss",
  answer: "Answer",
  park: "Park",
};

const GROUP_LABEL: Record<SignalKind, string> = {
  action: "Action items",
  decision: "Decisions",
  question: "Open questions",
  risk: "Risks",
};

export interface SignalItem {
  id: string;
  kind: SignalKind;
  title: string;
  owner: string | null;
  at: string | null;
  quote: string | null;
  isNew: boolean;
  actions: readonly SignalAction[];
}

export interface SignalGroup {
  kind: SignalKind;
  label: string;
  items: SignalItem[];
}

function signalKind(raw: string): SignalKind | null {
  const label = raw.toLowerCase();
  if (label.includes("action")) return "action";
  if (label.includes("decision")) return "decision";
  if (label.includes("question")) return "question";
  if (label.includes("risk")) return "risk";
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rawSignals(raw: unknown): Array<Record<string, unknown>> {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === "object" && s !== null);
  if (typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const buckets: Array<[string, string]> = [
    ["actions", "action"],
    ["actionItems", "action"],
    ["decisions", "decision"],
    ["questions", "question"],
    ["openQuestions", "question"],
    ["risks", "risk"],
  ];
  const out: Array<Record<string, unknown>> = [];
  for (const [key, type] of buckets) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      out.push(
        typeof item === "object" && item !== null
          ? { ...(item as Record<string, unknown>), type }
          : { title: String(item), type },
      );
    }
  }
  if (out.length) return out;
  return Array.isArray(record.signals) ? rawSignals(record.signals) : [];
}

/**
 * Action items, Decisions, Open questions, Risks — always all four groups in
 * that order so the column layout never jumps. Items marked dismissed in
 * `hidden` are dropped.
 */
export function signalGroups(
  event: MeetingEvent | null | undefined,
  hidden: ReadonlySet<string> = new Set(),
): SignalGroup[] {
  const groups: Record<SignalKind, SignalItem[]> = {
    action: [],
    decision: [],
    question: [],
    risk: [],
  };
  rawSignals(event?.signals).forEach((s, i) => {
    const kind = signalKind(`${s.type ?? s.kind ?? s.category ?? ""}`);
    const title = str(s.title) ?? str(s.text) ?? str(s.summary);
    if (!kind || !title) return;
    const id = str(s.id) ?? `${kind}:${i}`;
    if (hidden.has(id)) return;
    groups[kind].push({
      id,
      kind,
      title,
      owner: str(s.owner) ?? str(s.assignee),
      at: str(s.at) ?? str(s.time),
      quote: str(s.quote) ?? str(s.source),
      isNew: s.isNew === true || s.new === true,
      actions: SIGNAL_ACTIONS[kind],
    });
  });
  return (Object.keys(GROUP_LABEL) as SignalKind[]).map((kind) => ({
    kind,
    label: GROUP_LABEL[kind],
    items: groups[kind],
  }));
}

export function signalTotal(groups: readonly SignalGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}
