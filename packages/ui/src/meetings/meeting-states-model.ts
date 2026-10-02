/**
 * Presentation model for Meetings states (US-022): past recap, in-app
 * transcript, upcoming brief, empty canvas, and the new-meeting draft.
 * Pure. No Svelte, no fetches.
 */

import {
  eventEnd,
  eventStart,
  type MeetingEvent,
  type ScheduledBot,
} from "./meetings-model";
import { clockLabel, initialsOf, isLiveMeeting, shortDateLabel } from "./meetings-rail-model";

export type MeetingPhase = "live" | "upcoming" | "past";

export type RecapItemKind = "decision" | "action" | "question";

export interface RecapItem {
  id: string;
  kind: RecapItemKind;
  title: string;
  detail: string;
  owner: string;
  ownerInitials: string;
  bot: boolean;
  when: string;
  status: string;
}

export interface RecapModel {
  summary: string;
  decisions: RecapItem[];
  actions: RecapItem[];
  questions: RecapItem[];
  meta: string;
}

export interface TranscriptTurn {
  id: string;
  at: string;
  speaker: string;
  initials: string;
  bot: boolean;
  text: string;
  /** Gutter jump target, when this line produced a signal. */
  signal: string | null;
}

export type MeetingLinkKind = "zoom" | "meet" | "none";
export type MeetingDurationMin = 30 | 45 | 60;

export interface NewMeetingDraft {
  title: string;
  date: string;
  time: string;
  durationMin: MeetingDurationMin;
  attendeeIds: string[];
  notetaker: boolean;
  link: MeetingLinkKind;
  agenda: string;
}

/** Join stays disabled until this many minutes before start (storyboard). */
export const JOIN_LEAD_MS = 10 * 60_000;

export function meetingPhase(event: MeetingEvent, now: Date, bot?: ScheduledBot): MeetingPhase {
  if (isLiveMeeting(event, now, bot)) return "live";
  const end = eventEnd(event);
  if (end && end.getTime() <= now.getTime()) return "past";
  return "upcoming";
}

export function joinAvailable(event: MeetingEvent, now: Date): boolean {
  const url = (event.meetingUrl || event.hangoutLink || "").trim();
  if (!url) return false;
  const start = eventStart(event);
  if (!start) return true;
  return now.getTime() >= start.getTime() - JOIN_LEAD_MS;
}

export function durationMin(event: MeetingEvent): number | null {
  const start = eventStart(event);
  const end = eventEnd(event);
  if (!start || !end) return null;
  const mins = Math.round((end.getTime() - start.getTime()) / 60_000);
  return mins > 0 ? mins : null;
}

export function whenChip(event: MeetingEvent): string {
  const start = eventStart(event);
  if (!start) return "Unscheduled";
  const mins = durationMin(event);
  return `${shortDateLabel(start)} · ${clockLabel(start)}${mins ? ` · ${mins} min` : ""}`;
}

export function venueLabel(event: MeetingEvent): string {
  const url = (event.meetingUrl || event.hangoutLink || "").toLowerCase();
  if (url.includes("zoom.us")) return "Zoom";
  if (url.includes("meet.google")) return "Meet";
  if (!url) return "No link";
  return "Link";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function textOf(row: Record<string, unknown>): string {
  for (const key of ["title", "text", "summary"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function bucket(raw: unknown, key: string): Record<string, unknown>[] {
  const root = asRecord(raw);
  if (!root) return [];
  const value = root[key];
  if (!Array.isArray(value)) return [];
  return value.map((item, i) => {
    if (typeof item === "string") return { title: item, id: `${key}-${i}` };
    const row = asRecord(item);
    return row ? { ...row, id: row.id ?? `${key}-${i}` } : { title: "", id: `${key}-${i}` };
  });
}

function itemFrom(row: Record<string, unknown>, kind: RecapItemKind, index: number): RecapItem | null {
  const title = textOf(row);
  if (!title) return null;
  const owner = typeof row.owner === "string" && row.owner.trim() ? row.owner.trim() : "—";
  const bot = owner.toLowerCase() === "deacon" || row.kind === "bot";
  return {
    id: String(row.id ?? `${kind}-${index}`),
    kind,
    title,
    detail: typeof row.detail === "string" ? row.detail : typeof row.quote === "string" ? row.quote : "",
    owner,
    ownerInitials: owner === "—" ? "—" : initialsOf(owner),
    bot,
    when: typeof row.when === "string" ? row.when : typeof row.at === "string" ? row.at : "",
    status: typeof row.status === "string" ? row.status : kind === "question" ? "Unanswered" : "Open",
  };
}

export function recapModel(event: MeetingEvent, bot?: ScheduledBot): RecapModel {
  const raw = event.signals;
  const decisions = bucket(raw, "decisions").map((row, i) => itemFrom(row, "decision", i)).filter((x): x is RecapItem => !!x);
  const actions = bucket(raw, "actions").concat(bucket(raw, "actionItems")).map((row, i) => itemFrom(row, "action", i)).filter((x): x is RecapItem => !!x);
  const questions = bucket(raw, "questions").map((row, i) => itemFrom(row, "question", i)).filter((x): x is RecapItem => !!x);
  const explicit = asRecord(raw);
  const summary =
    (explicit && typeof explicit.summary === "string" && explicit.summary.trim()) ||
    event.notes?.map((n) => n.text?.trim()).filter(Boolean).slice(0, 2).join(" ") ||
    (decisions[0] ? decisions.map((d) => d.title).join(" ") : "No recap summary yet. It appears here after the notetaker posts one.");
  const by = bot?.sourceLanded ? "Recap saved to the company vault" : "Recap from this meeting";
  return { summary, decisions, actions, questions, meta: by };
}

export function recapPlainText(model: RecapModel, title: string): string {
  const lines = [title, "", "Summary", model.summary, "", "Decisions"];
  for (const item of model.decisions) lines.push(`- ${item.title}${item.owner !== "—" ? ` (${item.owner})` : ""}`);
  lines.push("", "Action items");
  for (const item of model.actions) lines.push(`- ${item.title} [${item.status}]`);
  return lines.join("\n");
}

export function transcriptTurns(event: MeetingEvent): TranscriptTurn[] {
  const raw = asRecord(event.signals);
  const listed = raw && Array.isArray(raw.transcript) ? raw.transcript : null;
  const source = listed ?? event.notes ?? [];
  const turns: TranscriptTurn[] = [];
  source.forEach((item, index) => {
    const row = asRecord(item) ?? {};
    const text = (typeof item === "object" && item && "text" in item ? String((item as { text?: string }).text ?? "") : textOf(row)).trim();
    if (!text) return;
    const speaker = (typeof row.speaker === "string" && row.speaker) || (typeof row.author === "string" && row.author) || "Note";
    turns.push({
      id: String(row.id ?? `tx-${index}`),
      at: typeof row.at === "string" ? row.at : "",
      speaker,
      initials: initialsOf(speaker),
      bot: row.kind === "bot" || speaker.toLowerCase() === "deacon",
      text,
      signal: typeof row.signal === "string" ? row.signal : null,
    });
  });
  return turns;
}

export function filterTranscript(turns: readonly TranscriptTurn[], query: string): TranscriptTurn[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...turns];
  return turns.filter((turn) => `${turn.speaker} ${turn.text} ${turn.signal ?? ""}`.toLowerCase().includes(q));
}

export function emptyNewMeetingDraft(now = new Date()): NewMeetingDraft {
  const next = new Date(now.getTime() + 60 * 60_000);
  next.setMinutes(0, 0, 0);
  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, "0");
  const d = String(next.getDate()).padStart(2, "0");
  return {
    title: "",
    date: `${y}-${m}-${d}`,
    time: clockLabel(next),
    durationMin: 30,
    attendeeIds: [],
    notetaker: true,
    link: "zoom",
    agenda: "",
  };
}

export function draftToEvent(draft: NewMeetingDraft, id: string): MeetingEvent | null {
  const title = draft.title.trim();
  if (!title) return null;
  const start = new Date(`${draft.date}T${draft.time}:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + draft.durationMin * 60_000);
  const lines = draft.agenda.split("\n").map((line) => line.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
  return {
    id,
    summary: title,
    status: "confirmed",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    meetingUrl: draft.link === "none" ? null : draft.link === "meet" ? "https://meet.google.com/new" : null,
    outline: lines.map((line, i) => ({ id: `${id}-ag-${i}`, title: line, state: "todo" as const })),
    notes: [],
  };
}

export function relativeUntil(start: Date, now: Date): string {
  const mins = Math.round((start.getTime() - now.getTime()) / 60_000);
  if (mins < 1) return "starting now";
  if (mins < 60) return `in ${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${hours} h`;
  return shortDateLabel(start);
}
