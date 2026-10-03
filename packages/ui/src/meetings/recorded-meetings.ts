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
