/**
 * Presentation model for Meetings states (US-022): past recap, in-app
 * transcript, upcoming brief, and empty canvas.
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
  /** Read from the summary's Next Steps list because no action signals were extracted. */
  derived?: boolean;
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
  // No link: nothing to show, so no placeholder text.
  if (!url) return "";
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
  // OWNER-R25: an empty owner is empty, not a dash placeholder.
  const owner = typeof row.owner === "string" && row.owner.trim() ? row.owner.trim() : "";
  const bot = owner.toLowerCase() === "deacon" || row.kind === "bot";
  return {
    id: String(row.id ?? `${kind}-${index}`),
    kind,
    title,
    detail: typeof row.detail === "string" ? row.detail : typeof row.quote === "string" ? row.quote : "",
    owner,
    ownerInitials: owner ? initialsOf(owner) : "",
    bot,
    when: typeof row.when === "string" ? row.when : typeof row.at === "string" ? row.at : "",
    status: typeof row.status === "string" ? row.status : kind === "question" ? "Unanswered" : "Open",
  };
}

const NEXT_STEPS_HEAD = /^(?:#{1,6}\s*|\*\*)?\s*(?:next steps|action items|follow[- ]ups?)\s*:?\s*(?:\*\*)?\s*:?\s*$/i;

/**
 * List items under a "Next Steps" / "Action items" heading in a structured
 * summary. Used only when the meeting has no extracted action signals, so the
 * count still reflects the follow-ups the recap names.
 */
export function nextStepsFromSummary(summary: string): string[] {
  const lines = summary.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let inside = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (NEXT_STEPS_HEAD.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (!line) {
      if (out.length) inside = false;
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) out.push(item[1].trim());
    else if (/^#{1,6}\s/.test(line) || out.length) inside = false;
  }
  return out;
}

/** "6 actions · 1 decision"; empty when every count is zero. */
export function recapDetailsLine(model: Pick<RecapModel, "decisions" | "actions" | "questions">): string {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : "");
  return [
    part(model.decisions.length, "decision", "decisions"),
    part(model.actions.length, "action", "actions"),
    part(model.questions.length, "question", "questions"),
  ]
    .filter(Boolean)
    .join(" · ");
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
    (decisions[0] ? decisions.map((d) => d.title).join(" ") : "");
  const by = bot?.sourceLanded ? "Recap saved to the company vault" : "Recap from this meeting";
  if (!actions.length && summary) {
    nextStepsFromSummary(summary).forEach((title, i) => {
      const item = itemFrom({ title, id: `summary-action-${i}` }, "action", i);
      if (item) actions.push({ ...item, derived: true });
    });
  }
  return { summary, decisions, actions, questions, meta: by };
}

export function recapPlainText(model: RecapModel, title: string): string {
  const lines = [title, "", "Summary", model.summary, "", "Decisions"];
  for (const item of model.decisions) lines.push(`- ${item.title}${item.owner ? ` (${item.owner})` : ""}`);
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

export function relativeUntil(start: Date, now: Date): string {
  const mins = Math.round((start.getTime() - now.getTime()) / 60_000);
  if (mins < 1) return "starting now";
  if (mins < 60) return `in ${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${hours} h`;
  return shortDateLabel(start);
}

export type PastNotesState = "ready" | "preparing" | "loading" | "failed" | "none";

/** Notes usually land this long after a recorded meeting ends. */
export const NOTES_PREP_WINDOW_MS = 30 * 60_000;

/**
 * Whether a past meeting has real notes to show. Tabs and recap sections
 * render only for "ready"; otherwise the canvas shows one quiet line and the
 * calendar details. "preparing" means a recording exists and ended recently
 * but no notes have landed; "loading" means the saved notes are being fetched.
 */
export function pastNotesState(
  event: MeetingEvent,
  now: Date,
  opts: { bot?: ScheduledBot; detailLoading?: boolean; detailFailed?: boolean } = {},
): PastNotesState {
  const model = recapModel(event, opts.bot);
  const hasContent =
    Boolean(model.summary) ||
    model.decisions.length + model.actions.length + model.questions.length > 0 ||
    transcriptTurns(event).length > 0 ||
    (event.notes ?? []).some((n) => n.text?.trim());
  if (hasContent) return "ready";
  if (opts.detailLoading) return "loading";
  // OWNER-019: a read that failed is not "no notes".
  if (opts.detailFailed) return "failed";
  const bot = opts.bot;
  const recorded = Boolean(event.recorded) || Boolean(bot?.sourceLanded) ||
    (bot ? bot.status === "recording" || bot.status === "processing" || bot.status === "completed" : false);
  const end = eventEnd(event);
  if (recorded && end && now.getTime() - end.getTime() < NOTES_PREP_WINDOW_MS) return "preparing";
  return "none";
}
