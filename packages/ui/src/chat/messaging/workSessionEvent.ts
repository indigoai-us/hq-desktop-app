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

export type WorkSessionEventKind =
  | "claim"
  | "start"
  | "progress"
  | "blocked"
  | "done"
  | "note"
  | "task_status"
  | "handoff"
  | "question"
  | "answer"
  | "mention";

/** Board columns as the user sees them, keyed by the on-the-wire status. */
export const TASK_STATUS_LABEL: Record<string, string> = {
  queued: "To do",
  todo: "To do",
  in_progress: "Doing",
  doing: "Doing",
  review: "Waiting",
  waiting: "Waiting",
  done: "Done",
};

/** Human label for a wire task status; unknown values pass through trimmed. */
export function taskStatusLabel(status: string): string {
  const key = status.trim().toLowerCase();
  return TASK_STATUS_LABEL[key] ?? status.trim();
}

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
  /** Task/board move carried by the event, when it moved one. */
  taskStatus: TaskStatusMove | null;
  /** Runtime that emitted a v2 session event (claude-code, codex, …). */
  harness: string | null;
  /** Server-resolved actor uid, for roster/avatar lookup. Never displayed raw. */
  actorUid: string | null;
  actorType: "human" | "agent" | null;
  /** Stable id used for timeline dedupe. */
  eventId: string | null;
  threadId: string | null;
  /** Bursts collapsed into this row (1 = a single event). */
  burstCount: number;
}

/** A board move. `from` is null when only the destination is known. */
export interface TaskStatusMove {
  taskId: string | null;
  from: string | null;
  to: string;
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
  progress: "made progress on",
  blocked: "is blocked on",
  done: "marked done",
  note: "noted",
  task_status: "moved",
  handoff: "handed off",
  question: "asked about",
  answer: "answered on",
  mention: "mentioned",
};

const KINDS = new Set<string>(Object.keys(VERB));

function isKind(value: unknown): value is WorkSessionEventKind {
  return typeof value === "string" && KINDS.has(value);
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

  const statusTo = optionalString(payload?.status) ?? optionalString(event.status);
  const taskId = optionalString(payload?.taskId) ?? storyId;

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
    taskStatus: statusTo
      ? {
          taskId,
          from: optionalString(payload?.previousStatus),
          to: statusTo,
        }
      : null,
    harness: optionalString(payload?.harness) ?? optionalString(event.harness),
    actorUid: optionalString(event.byUid) ?? optionalString(event.actorUid),
    actorType: actorTypeOf(event.actorType ?? event.byType),
    eventId: optionalString(event.eventId) ?? optionalString(parsed.eventId),
    threadId: optionalString(parsed.threadId) ?? optionalString(event.threadId),
    burstCount: 1,
  };
}

// ─── v1 / v2 envelope normalisation ──────────────────────────────────────────

function actorTypeOf(value: unknown): "human" | "agent" | null {
  const v = optionalString(value);
  if (v === "human" || v === "agent") return v;
  return null;
}

/**
 * v1 thread-event kinds (hq-pro `WORK_THREAD_EVENT.eventKind`) mapped onto the
 * display vocabulary. `claim` keeps its own kind so the icon stays the link
 * glyph; everything else maps 1:1 except the two that have no row of their own.
 */
const V1_KIND: Record<string, WorkSessionEventKind> = {
  claim: "claim",
  progress: "progress",
  blocked: "blocked",
  question: "question",
  answer: "answer",
  handoff: "handoff",
  done: "done",
  note: "note",
  mention: "mention",
};

/**
 * v2 Work Mesh Live session-event kinds (`session-event.schema.json`).
 * `turn_start` / `turn_end` are deliberately dropped — they are per-turn noise
 * that the server coalesces into a session card, not timeline rows.
 */
const V2_KIND: Record<string, WorkSessionEventKind> = {
  session_start: "start",
  session_end: "done",
  task_status: "task_status",
  blocked: "blocked",
  note: "note",
};

const V2_DROPPED = new Set(["turn_start", "turn_end"]);

/** Resolves an actor uid to a display name. Returns null when unknown. */
export type ActorResolver = (actorUid: string) => string | null;

export interface NormalizeContext {
  /** Roster lookup so rows show real names instead of `prs_…`. */
  resolveActor?: ActorResolver;
  /** Thread the event belongs to (v1 rows carry it; v2 events do not). */
  threadId?: string | null;
  /** Board task titles keyed by task id, for `task moved` rows. */
  taskTitles?: Readonly<Record<string, string>>;
}

/**
 * Normalise ONE work-mesh event — v1 `WORK_THREAD_EVENT` row or v2 Work Mesh
 * Live session event — into the single activity shape the timeline renders.
 *
 * Never throws: an unrecognised or malformed envelope returns `null` so a new
 * server-side kind can never break the channel.
 *
 * Discrimination is by shape, not by a version flag: v1 rows carry `eventKind`,
 * v2 events carry `kind` + `sessionId` + `at`. Both are accepted forever — v2
 * is not fully deployed, and v1 rows stay in the history after it is.
 */
export function normalizeWorkMeshEvent(
  raw: unknown,
  ctx: NormalizeContext = {},
): WorkSessionActivity | null {
  if (!isPlainObject(raw)) return null;

  const v1Kind = optionalString(raw.eventKind);
  const v2Kind = optionalString(raw.kind);
  const isV2 = !v1Kind && Boolean(v2Kind) && Boolean(optionalString(raw.sessionId));

  if (isV2 && v2Kind && V2_DROPPED.has(v2Kind)) return null;

  const kind = v1Kind
    ? V1_KIND[v1Kind]
    : v2Kind
      ? V2_KIND[v2Kind]
      : undefined;
  if (!kind) return null;

  const payload = asPayload(raw.payload) ?? {};
  const actorUid = optionalString(raw.authorUid) ?? optionalString(raw.actorUid);
  const resolved = actorUid ? (ctx.resolveActor?.(actorUid) ?? null) : null;
  const actor =
    resolved ??
    optionalString(payload.claimedBy) ??
    optionalString(raw.actorDisplay) ??
    (actorUid && !isOpaqueActorId(actorUid) ? actorUid : null) ??
    "A teammate";

  const at = optionalString(raw.createdAt) ?? optionalString(raw.at);
  // On a blocked event the reason IS the summary — it is the thing a reader
  // needs — so it outranks any generic summary the same event also carries.
  const reason = optionalString(payload.reason) ?? optionalString(raw.reason);
  const generalSummary =
    optionalString(payload.summary) ??
    optionalString(payload.text) ??
    optionalString(payload.note) ??
    optionalString(raw.summary);
  const summary =
    kind === "blocked" ? (reason ?? generalSummary) : (generalSummary ?? reason);

  const taskId = optionalString(payload.taskId) ?? optionalString(raw.taskId);
  const statusTo = optionalString(payload.status) ?? optionalString(raw.status);
  const taskStatus: TaskStatusMove | null = statusTo
    ? {
        taskId,
        from: optionalString(payload.previousStatus) ?? optionalString(raw.previousStatus),
        to: statusTo,
      }
    : null;

  // A v1 event that also moved the board reads as the move, not the note.
  const effectiveKind: WorkSessionEventKind =
    taskStatus && kind === "note" ? "task_status" : kind;

  const storyTitle =
    optionalString(payload.storyTitle) ??
    (taskId ? (ctx.taskTitles?.[taskId] ?? null) : null);

  return {
    kind: effectiveKind,
    actor,
    storyId: taskId,
    title: storyTitle ?? summary,
    verb: VERB[effectiveKind],
    at,
    storyTitle,
    summary,
    doneCriteria:
      criteriaString(payload.doneCriteria) ??
      criteriaString(payload.acceptanceCriteria),
    branch: optionalString(payload.branch),
    runtime: optionalString(payload.runtime),
    taskStatus,
    harness: optionalString(payload.harness) ?? optionalString(raw.harness),
    actorUid,
    actorType:
      actorTypeOf(raw.authorType) ??
      actorTypeOf(raw.actorType) ??
      (actorUid?.startsWith("agt_") ? "agent" : null),
    eventId: optionalString(raw.eventId),
    threadId:
      optionalString(raw.threadId) ??
      optionalString(ctx.threadId) ??
      optionalString(raw.sessionId),
    burstCount: 1,
  };
}
