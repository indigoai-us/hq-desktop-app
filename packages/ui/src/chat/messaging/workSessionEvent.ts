/**
 * Parse work-mesh session events posted as JSON chat messages.
 *
 * Work-mesh writes compact JSON into project channels (kind
 * `work-session-event`). The parser never throws: malformed bodies fall
 * through to `null` so the conversation can keep rendering the raw bubble.
 *
 * `payload` may be a plain object or an escaped JSON string, and may sit
 * at the top level or inside `event`.
 *
 * A single wrapping markdown code fence (``` / ```json) is stripped before
 * JSON detection so fenced chat bodies still parse.
 */

export type WorkSessionEventKind = "claim" | "start" | "blocked" | "done";

export interface WorkSessionActivity {
  kind: WorkSessionEventKind;
  actor: string;
  storyId: string | null;
  title: string | null;
  verb: string;
  at: string | null;
  /** Expanded-detail fields (mirrors hq-sessions' MeshEvent mapping). */
  storyTitle: string | null;
  summary: string | null;
  /** `doneCriteria` (or `acceptanceCriteria`) — arrays joined with "; ". */
  doneCriteria: string | null;
  branch: string | null;
  runtime: string | null;
}

/**
 * True for raw participant ids that must never render as an actor name:
 * `prs_` / `agt_` prefixes, or a bare 8-4-4-4-12 hex UUID (Cognito sub).
 * Mirrors hq-sessions' `looks_like_opaque_id`.
 */
export function isOpaqueActorId(value: string): boolean {
  const s = value.trim();
  if (s.startsWith("prs_") || s.startsWith("agt_")) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

const VERB: Record<WorkSessionEventKind, string> = {
  claim: "started",
  start: "started",
  blocked: "is blocked on",
  done: "marked done",
};

function isKind(value: unknown): value is WorkSessionEventKind {
  return (
    value === "claim" ||
    value === "start" ||
    value === "blocked" ||
    value === "done"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Criteria fields may be a string or an array of strings (joined "; "). */
function criteriaString(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return optionalString(value);
}

/** `payload` may already be an object, or a JSON string that parses to one. */
function asPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return isPlainObject(parsed) ? parsed : null;
  }
  return isPlainObject(value) ? value : null;
}

/** Suffix after the last `:`, e.g. `work-desktop-dogfood:T-002` → `T-002`. */
function storyIdFromThreadId(threadId: unknown): string | null {
  const raw = optionalString(threadId);
  if (!raw) return null;
  const colon = raw.lastIndexOf(":");
  if (colon === -1 || colon === raw.length - 1) return null;
  const suffix = raw.slice(colon + 1).trim();
  return suffix.length > 0 ? suffix : null;
}

/**
 * Strip one wrapping markdown fence. Trimmed bodies that start with ```
 * (optional language tag on that line) and end with ``` yield the inner
 * content; anything else is returned unchanged.
 */
function unwrapMarkdownFence(trimmed: string): string {
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
  if (trimmed.length <= 6) return trimmed;
  const match = trimmed.match(/^```[^\n\r]*\r?\n([\s\S]*)\r?\n?```$/);
  if (!match) return trimmed;
  return match[1].trim();
}

export function parseWorkSessionEvent(
  body: string,
): WorkSessionActivity | null {
  if (typeof body !== "string") return null;
  const trimmed = unwrapMarkdownFence(body.trim());
  if (!trimmed.startsWith("{")) return null;

  const parsed = parseJson(trimmed);
  if (!isPlainObject(parsed) || parsed.kind !== "work-session-event") {
    return null;
  }

  const event = isPlainObject(parsed.event) ? parsed.event : null;
  if (!event || !isKind(event.kind)) return null;

  const payload = asPayload(parsed.payload) ?? asPayload(event.payload);
  const storyId =
    optionalString(payload?.storyId) ?? storyIdFromThreadId(parsed.threadId);
  const storyTitle = optionalString(payload?.storyTitle);
  const summary = optionalString(event.summary);
  const title = storyTitle ?? summary;

  return {
    kind: event.kind,
    actor: optionalString(event.by) ?? "Someone",
    storyId,
    title,
    verb: VERB[event.kind],
    at: optionalString(event.at),
    storyTitle,
    summary,
    doneCriteria:
      criteriaString(payload?.doneCriteria) ??
      criteriaString(payload?.acceptanceCriteria),
    branch: optionalString(payload?.branch),
    runtime: optionalString(payload?.runtime),
  };
}
