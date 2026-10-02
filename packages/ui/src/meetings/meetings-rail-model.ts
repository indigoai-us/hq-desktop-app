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
  type MeetingEvent,
  type ScheduledBot,
} from "./meetings-model";

/** Past rows shown before the "Earlier" affordance. */
export const MEETINGS_PAST_ROW_LIMIT = 8;

export type MeetingsSectionId = "live" | "today" | "tomorrow" | "past";

export interface MeetingsRailRow {
  id: string;
  title: string;
  /** "11:00" for upcoming rows, "Sep 30" for past rows, elapsed for live. */
  time: string;
  companyUid: string | null;
  /** Two-letter company mark; null for personal calendars. */
  companyMark: string | null;
  live: boolean;
  /** Past row with a saved recap (notes mark). */
  hasRecap: boolean;
  hasRecording: boolean;
  /** Free/busy-only "Busy" block from a shared calendar: rendered quiet, no mark. */
  busy?: boolean;
}

export interface MeetingsRailSection {
  id: MeetingsSectionId;
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

export function shortDateLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function elapsedLabel(start: Date | null, now: Date): string {
  if (!start) return "now";
  const mins = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * Google "Busy" blocks: free/busy-only events from a shared calendar. They
 * carry no attendees, no join link, and the literal title "Busy".
 */
export function isBusyBlock(
  event: Pick<MeetingEvent, "summary" | "attendees" | "meetingUrl" | "hangoutLink">,
): boolean {
  return (
    (event.summary ?? "").trim().toLowerCase() === "busy" &&
    !event.attendees?.length &&
    !event.meetingUrl &&
    !event.hangoutLink
  );
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
 * Live, Today · <date>, Tomorrow, Past. Empty sections are dropped; Past is
 * newest-first and capped so the pane stays short.
 */
export function meetingsRailSections(input: MeetingsRailInput): MeetingsRailSection[] {
  const now = input.now ?? new Date();
  const filter = input.filter ?? EMPTY_MEETINGS_FILTER;
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const live: MeetingsRailRow[] = [];
  const todayRows: MeetingsRailRow[] = [];
  const tomorrowRows: MeetingsRailRow[] = [];
  const past: Array<{ at: number; row: MeetingsRailRow }> = [];
  const upcoming: Array<{ at: number; row: MeetingsRailRow; bucket: MeetingsRailRow[] }> = [];

  for (const event of input.events) {
    if (event.status === "cancelled") continue;
    const start = eventStart(event);
    if (!start) continue;
    const end = eventEnd(event) ?? start;
    const bot = botForEvent(event, input.botsByEventId, input.scheduledBots);
    const companyUid = event.sourceCompanyUid ?? null;
    const isLive = isLiveMeeting(event, now, bot);
    const recap = hasRecap(event, bot);
    const recording = Boolean(bot && isActiveBotStatus(bot.status));
    if (filter.companyUid && companyUid !== filter.companyUid) continue;
    if (filter.liveOnly && !isLive) continue;
    if (filter.hasRecap && !recap) continue;
    if (filter.hasRecording && !recording && !bot?.sourceLanded) continue;
    const busy = isBusyBlock(event);
    const base = {
      id: event.id,
      title: event.summary?.trim() || "Untitled meeting",
      companyUid,
      companyMark:
        companyUid && !busy
          ? companyMark(input.companyNamesByUid.get(companyUid) ?? null)
          : null,
      busy,
      live: isLive,
      hasRecap: false,
      hasRecording: recording,
    };
    if (isLive) {
      live.push({ ...base, time: elapsedLabel(start, now) });
      continue;
    }
    if (end.getTime() <= now.getTime()) {
      past.push({
        at: end.getTime(),
        row: { ...base, time: shortDateLabel(start), hasRecap: recap },
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

  const sections: MeetingsRailSection[] = [];
  if (live.length) sections.push({ id: "live", label: "Live", rows: live });
  if (todayRows.length)
    sections.push({ id: "today", label: `Today · ${shortDateLabel(now)}`, rows: todayRows });
  if (tomorrowRows.length)
    sections.push({ id: "tomorrow", label: "Tomorrow", rows: tomorrowRows });
  if (past.length)
    sections.push({
      id: "past",
      label: "Past",
      rows: past.slice(0, MEETINGS_PAST_ROW_LIMIT).map((p) => p.row),
    });
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
