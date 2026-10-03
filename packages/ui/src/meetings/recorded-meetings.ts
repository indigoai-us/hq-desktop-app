/**
 * Recorded meeting history (`GET /v1/meetings`).
 *
 * The calendar feed only carries upcoming events, so recorded meetings are the
 * Meetings rail's history. hq-pro scopes the list per company: a call with
 * `companyId` returns that company's meetings, a call without it returns only
 * the caller's unattributed meetings (`companyId: "unknown"`). Personal scope
 * therefore fans out across every active membership and merges.
 *
 * Rows are coerced here; nothing downstream trusts the wire shape.
 */

import type { MeetingEvent } from "./meetings-model";

export interface RecordedMeeting {
  meetingId: string;
  title: string;
  /** ISO start; rows without a parseable start are dropped. */
  startTime: string;
  endTime: string | null;
  /** Seconds, when hq-pro reports it. */
  durationSec: number | null;
  /** null when the server reports no company ("unknown"). */
  companyUid: string | null;
  hasSignals: boolean;
}

/** Event ids for recorded rows, kept distinct from calendar event ids. */
export const RECORDED_EVENT_PREFIX = "recorded:";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const n = Number(value);
    return n > 0 ? n : null;
  }
  return null;
}

function validTime(value: unknown): string | null {
  const s = str(value);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
}

/** Parse a `{ meetings: [...] }` envelope (or a bare array) into rows. */
export function parseRecordedMeetings(raw: unknown): RecordedMeeting[] {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.meetings)
      ? (record?.meetings as unknown[])
      : [];
  const out: RecordedMeeting[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const meetingId = str(m.meetingId) ?? str(m.id);
    const startTime = validTime(m.startTime) ?? validTime(m.ingested_at) ?? validTime(m.createdAt);
    if (!meetingId || !startTime) continue;
    const company = str(m.companyId);
    out.push({
      meetingId,
      title: str(m.title) ?? "Untitled meeting",
      startTime,
      endTime: validTime(m.endTime),
      durationSec: num(m.duration),
      companyUid: company && company !== "unknown" ? company : null,
      hasSignals: m.hasSignals === true,
    });
  }
  return out;
}

/** Merge per-scope lists: dedupe by meeting id (attributed copy wins), newest first. */
export function mergeRecordedMeetings(lists: readonly RecordedMeeting[][]): RecordedMeeting[] {
  const byId = new Map<string, RecordedMeeting>();
  for (const list of lists) {
    for (const m of list) {
      const prev = byId.get(m.meetingId);
      if (!prev || (!prev.companyUid && m.companyUid)) byId.set(m.meetingId, m);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => Date.parse(b.startTime) - Date.parse(a.startTime),
  );
}

/** "45m", "1h 05m"; null when the duration is unknown. */
export function recordedDurationLabel(m: Pick<RecordedMeeting, "durationSec" | "startTime" | "endTime">): string | null {
  let sec = m.durationSec;
  if (sec == null && m.endTime) {
    const diff = (Date.parse(m.endTime) - Date.parse(m.startTime)) / 1000;
    sec = diff > 0 ? diff : null;
  }
  if (sec == null) return null;
  const mins = Math.max(1, Math.round(sec / 60));
  if (mins < 60) return `${mins}m`;
  const rest = mins % 60;
  return `${Math.floor(mins / 60)}h ${rest < 10 ? `0${rest}` : rest}m`;
}

/**
 * A recorded meeting as a past MeetingEvent so the rail and the existing
 * meeting canvas render it without a second code path.
 */
export function recordedToEvent(m: RecordedMeeting): MeetingEvent {
  const startMs = Date.parse(m.startTime);
  const endIso =
    m.endTime ??
    (m.durationSec != null ? new Date(startMs + m.durationSec * 1000).toISOString() : m.startTime);
  return {
    id: `${RECORDED_EVENT_PREFIX}${m.meetingId}`,
    summary: m.title,
    start: { dateTime: m.startTime },
    end: { dateTime: endIso },
    status: "confirmed",
    sourceCompanyUid: m.companyUid ?? undefined,
    recorded: {
      meetingId: m.meetingId,
      durationLabel: recordedDurationLabel(m),
      hasSignals: m.hasSignals,
    },
  };
}

/** Calendar events plus recorded history, recorded rows after calendar rows. */
export function withRecordedEvents(
  events: readonly MeetingEvent[],
  recorded: readonly RecordedMeeting[],
): MeetingEvent[] {
  return [...events, ...recorded.map(recordedToEvent)];
}

/**
 * What the client knows about the signed-in person's own meetings. hq-pro's
 * list rows carry no attendee, organizer or recorder field (only meetingId,
 * title, startTime, companyId), and the list is ACL-filtered, so a company
 * owner or admin can read every member's recordings. Each signal here is
 * person-scoped on its own:
 *  - `botIds`: the caller's notetaker bots (`GET /v1/bot/list` is keyed by the
 *    caller's personUid). A recorded meeting's id is its recall bot id.
 *  - `calendarEvents`: events from the caller's own connected calendars, so the
 *    caller is on the invite.
 *  - `localRecordingIds`: recordings started from this device.
 */
export interface OwnMeetingSignals {
  botIds: Iterable<string>;
  calendarEvents: readonly Pick<MeetingEvent, "summary" | "start">[];
  localRecordingIds?: Iterable<string>;
}

/** A calendar match must start within this window of the recording. */
const CALENDAR_MATCH_WINDOW_MS = 10 * 60_000;

function normTitle(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Keep only meetings the signed-in person attended or recorded. Company role
 * never widens the list. With no matching signal a row is hidden.
 */
export function ownRecordedMeetings(
  rows: readonly RecordedMeeting[],
  signals: OwnMeetingSignals,
): RecordedMeeting[] {
  const ids = new Set<string>([...signals.botIds, ...(signals.localRecordingIds ?? [])]);
  const calendar = signals.calendarEvents
    .map((e) => ({
      title: normTitle(e.summary),
      at: Date.parse(e.start?.dateTime ?? e.start?.date ?? ""),
    }))
    .filter((e) => e.title && Number.isFinite(e.at));
  return rows.filter((m) => {
    if (ids.has(m.meetingId)) return true;
    const title = normTitle(m.title);
    const at = Date.parse(m.startTime);
    return calendar.some(
      (e) => e.title === title && Math.abs(e.at - at) <= CALENDAR_MATCH_WINDOW_MS,
    );
  });
}

// ── Recorded meeting detail (`GET /v1/meetings/{id}`) ─────────────────────

export type RecordedSignalKind = "summary" | "decisions" | "actions" | "questions";

export interface RecordedSignalRef {
  kind: RecordedSignalKind;
  /** Server title when present; hq-pro usually omits it, so bodies are read. */
  title: string | null;
  url: string | null;
}

const SIGNAL_KIND: Record<string, RecordedSignalKind> = {
  summary: "summary",
  decision: "decisions",
  decisions: "decisions",
  action: "actions",
  actions: "actions",
  action_item: "actions",
  action_items: "actions",
  actionItem: "actions",
  commitment: "actions",
  question: "questions",
  questions: "questions",
  open_question: "questions",
};

/** Signal refs from a meeting detail envelope; unknown types are skipped. */
export function parseRecordedDetail(raw: unknown): RecordedSignalRef[] {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const signals =
    record?.signals && typeof record.signals === "object"
      ? (record.signals as Record<string, unknown>)
      : {};
  const out: RecordedSignalRef[] = [];
  for (const [type, list] of Object.entries(signals)) {
    const kind = SIGNAL_KIND[type];
    if (!kind || !Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;
      out.push({ kind, title: str(s.title), url: str(s.presigned_url) });
    }
  }
  return out;
}

/** Markdown body without frontmatter, headings collapsed to plain text. */
export function signalBodyText(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Signal bodies read per page: the first page when a meeting opens, then one per "Load more". */
export const RECORDED_SIGNAL_READ_LIMIT = 24;

export interface RecordedSignals {
  summary: string;
  decisions: { title: string }[];
  actions: { title: string }[];
  questions: { title: string }[];
}

/** Paging state for one meeting's notes: every ref, plus the texts read so far (in ref order). */
export interface RecordedSignalPages {
  refs: readonly RecordedSignalRef[];
  texts: readonly string[];
}

/** Notes not read yet. */
export function recordedSignalsRemaining(pages: RecordedSignalPages): number {
  return Math.max(0, pages.refs.length - pages.texts.length);
}

/**
 * Read the next page of signal bodies. Titles come from the server when
 * present; otherwise the body is read from its presigned URL. A body that
 * cannot be read is logged and kept as an empty text, so it is not retried.
 */
export async function loadNextRecordedSignalPage(
  pages: RecordedSignalPages,
  readText: (url: string) => Promise<string>,
): Promise<RecordedSignalPages> {
  const from = pages.texts.length;
  const next = pages.refs.slice(from, from + RECORDED_SIGNAL_READ_LIMIT);
  const texts = await Promise.all(
    next.map(async (ref) => {
      if (ref.title) return ref.title;
      if (!ref.url) return "";
      try {
        return signalBodyText(await readText(ref.url));
      } catch (err) {
        console.warn(`[meetings] could not read ${ref.kind} signal body`, err);
        return "";
      }
    }),
  );
  return { refs: pages.refs, texts: [...pages.texts, ...texts] };
}

/** The recap `signals` object from every text read so far, in ref order. */
export function recordedSignalsFromPages(pages: RecordedSignalPages): RecordedSignals {
  const out: RecordedSignals = { summary: "", decisions: [], actions: [], questions: [] };
  pages.texts.forEach((text, i) => {
    const ref = pages.refs[i];
    if (!text || !ref) return;
    if (ref.kind === "summary") out.summary = out.summary ? `${out.summary} ${text}` : text;
    else out[ref.kind].push({ title: text });
  });
  return out;
}

/** The recap `signals` for the first page of a meeting's notes. */
export async function loadRecordedSignals(
  refs: readonly RecordedSignalRef[],
  readText: (url: string) => Promise<string>,
): Promise<RecordedSignals> {
  return recordedSignalsFromPages(await loadNextRecordedSignalPage({ refs, texts: [] }, readText));
}
