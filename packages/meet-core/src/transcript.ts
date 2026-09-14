/** Bounded text-only messages on the admitted peer control channel.
 * Sender identity is deliberately absent: use TranscriptEvent.from.
 * Consent/capture policy belongs to the caller; this codec conveys no audio.
 */
export interface TranscriptMessage {
  kind: "transcript";
  version: 1;
  conversationId: string;
  streamId: string;
  segmentId: string;
  revision: number;
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}
export const TRANSCRIPT_MAX_TEXT_LENGTH = 4096;
/** UTF-8 JSON wire budget, checked before parsing and after encoding. */
export const TRANSCRIPT_MAX_BYTES = 32768;
const fields = ["kind", "version", "conversationId", "streamId", "segmentId", "revision", "startMs", "endMs", "text", "final"];
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

export function parseTranscript(data: unknown): TranscriptMessage | null {
  if (typeof data === "string") {
    if (data.length > TRANSCRIPT_MAX_BYTES || bytes(data) > TRANSCRIPT_MAX_BYTES) return null;
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (Object.keys(r).length !== fields.length || !fields.every(k => Object.prototype.hasOwnProperty.call(r, k))) return null;
  if (r.kind !== "transcript" || r.version !== 1 || !id(r.conversationId) || !id(r.streamId) || !id(r.segmentId) ||
      !uint(r.revision) || !uint(r.startMs) || !uint(r.endMs) || r.endMs < r.startMs ||
      typeof r.text !== "string" || r.text.length > TRANSCRIPT_MAX_TEXT_LENGTH || typeof r.final !== "boolean") return null;
  const message: TranscriptMessage = {
    kind: "transcript", version: 1, conversationId: r.conversationId, streamId: r.streamId,
    segmentId: r.segmentId, revision: r.revision, startMs: r.startMs, endMs: r.endMs, text: r.text, final: r.final,
  };
  return bytes(JSON.stringify(message)) <= TRANSCRIPT_MAX_BYTES ? message : null;
}

/** Invalid caller input throws a content-free error; session sending returns false. */
export function encodeTranscript(message: TranscriptMessage): string {
  const parsed = parseTranscript(message);
  if (!parsed) throw new Error("INVALID_TRANSCRIPT");
  return JSON.stringify(parsed);
}
