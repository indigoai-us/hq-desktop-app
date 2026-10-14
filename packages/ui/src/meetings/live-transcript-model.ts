/**
 * Pure helpers for the live meeting transcript (Recall real-time). The
 * server contract is hq-pro docs/plans/meeting-live-transcript.md section
 * 2.3. Only the lazy live-transcript body imports this file.
 */
import type {
  LiveTranscriptPartialWire,
  LiveTranscriptSegmentWire,
} from "@hq/platform";
import { initialsOf } from "./meetings-rail-model";

export interface LiveTurn {
  id: string;
  speaker: string;
  initials: string;
  at: string;
  text: string;
}

export interface LivePartialLine {
  speaker: string;
  at: string;
  text: string;
}

/** `startSeconds` from the start of the recording, as m:ss or h:mm:ss. */
export function offsetLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function speakerOf(row: { speaker?: string | null; participantId?: string | null }): string {
  const name = row.speaker?.trim();
  if (name) return name;
  return row.participantId ? `Speaker ${row.participantId}` : "Speaker";
}

/**
 * Merge a delta into the segments already held. Segments are keyed by
 * `segmentId`, so a full snapshot replayed after a cursor reset adds
 * nothing twice. Output is ordered by start time, ties in arrival order.
 */
export function mergeSegments(
  current: readonly LiveTranscriptSegmentWire[],
  incoming: readonly LiveTranscriptSegmentWire[],
): LiveTranscriptSegmentWire[] {
  if (!incoming.length) return [...current];
  const seen = new Set(current.map((s) => s.segmentId));
  const next = [...current];
  for (const seg of incoming) {
    if (!seg?.segmentId || seen.has(seg.segmentId) || !seg.text?.trim()) continue;
    seen.add(seg.segmentId);
    next.push(seg);
  }
  return next
    .map((seg, i) => ({ seg, i }))
    .sort((a, b) => (a.seg.startSeconds ?? 0) - (b.seg.startSeconds ?? 0) || a.i - b.i)
    .map(({ seg }) => seg);
}

/** Consecutive segments from the same speaker read as one turn. */
export function liveTurns(segments: readonly LiveTranscriptSegmentWire[]): LiveTurn[] {
  const turns: LiveTurn[] = [];
  for (const seg of segments) {
    const speaker = speakerOf(seg);
    const text = seg.text.trim();
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${text}`;
      continue;
    }
    turns.push({
      id: seg.segmentId,
      speaker,
      initials: initialsOf(speaker),
      at: offsetLabel(seg.startSeconds),
      text,
    });
  }
  return turns;
}

/** The in-progress line, shown only when it starts after the last final one. */
export function partialLine(
  partial: LiveTranscriptPartialWire | null | undefined,
  segments: readonly LiveTranscriptSegmentWire[],
): LivePartialLine | null {
  const text = partial?.text?.trim();
  if (!partial || !text) return null;
  const last = segments[segments.length - 1];
  const lastEnd = last ? (last.endSeconds ?? last.startSeconds) : -Infinity;
  if (partial.startSeconds < lastEnd) return null;
  return { speaker: speakerOf(partial), at: offsetLabel(partial.startSeconds), text };
}

/** Bot statuses that mean the notetaker is in the call right now. */
export function notetakerInCall(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s.includes("in_call") || s.includes("recording");
}

/** Within this many pixels of the bottom counts as "following". */
export const FOLLOW_SLACK_PX = 24;

export function isAtBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
}
