/**
 * Work-mesh thread model (US-008).
 *
 * Absent-safe normalization of the hq-pro work-mesh REST rollups
 * (`/v1/work-mesh/threads`, `/v1/work-mesh/companies/{uid}/threads/{id}`)
 * into the Board's thread rows. Wake payloads (including retained
 * THREAD_META snapshots that hydrate late subscribers) are advisory-only —
 * they only trigger the REST re-fetch whose response is parsed here.
 * Platform-pure; unit-tested.
 */

/** Work-mesh thread lifecycle statuses (work-mesh.sh verbs). */
export type WorkMeshThreadStatus =
  "check" | "start" | "progress" | "blocked" | "done" | "unknown";

export interface WorkMeshThread {
  threadId: string;
  companyUid: string;
  /** Project slug/id this thread coordinates (empty when unattributed). */
  project: string;
  title: string;
  status: WorkMeshThreadStatus;
  storyId: string | null;
  updatedAt: string | null;
  /** Person or agent uid last writing the thread, when the rollup carries it. */
  actor: string | null;
  /** Latest human-readable status/progress note. */
  note: string | null;
}

const STATUS_VALUES = new Set([
  "check",
  "start",
  "progress",
  "blocked",
  "done",
]);

export function normalizeThreadStatus(raw: unknown): WorkMeshThreadStatus {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (STATUS_VALUES.has(s)) return s as WorkMeshThreadStatus;
  // Common aliases from older writers.
  if (s === "in_progress" || s === "in-progress" || s === "working") {
    return "progress";
  }
  if (s === "complete" || s === "completed" || s === "shipped") return "done";
  if (s === "started" || s === "claimed") return "start";
  if (s === "open") return "check";
  if (s === "needs-human" || s === "needs_human") return "blocked";
  return "unknown";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v != null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function extractStoryIdFromNote(note: string): string {
  const match = note.match(/\b(US[-_]?\d+[a-z]?)\b/i);
  return match?.[1] ?? "";
}

/**
 * Normalize one wire thread. Returns null when no thread id can be found —
 * callers drop such rows (absent-safe).
 */
export function normalizeThread(
  raw: unknown,
  fallbackCompanyUid = "",
): WorkMeshThread | null {
  const r = rec(raw);
  if (!r) return null;
  const meta = rec(r.meta) ?? rec(r.threadMeta) ?? {};
  const threadId = str(r.threadId) || str(r.thread_id) || str(r.id);
  if (!threadId) return null;
  const companyUid =
    str(r.companyUid) ||
    str(r.company_uid) ||
    str(meta.companyUid) ||
    fallbackCompanyUid;
  const project =
    str(r.project) ||
    str(r.projectId) ||
    str(meta.project) ||
    str(meta.projectId);
  const title = str(r.title) || str(meta.title) || project || threadId;
  const storyId =
    str(r.storyId) ||
    str(r.story_id) ||
    str(meta.storyId) ||
    extractStoryIdFromNote(
      str(r.progressSummary) || str(meta.progressSummary) || str(r.note),
    );
  const updatedAt =
    str(r.updatedAt) ||
    str(r.updated_at) ||
    str(r.lastActivityAt) ||
    str(meta.lastActivityAt);
  const actor =
    str(r.ownerUid) ||
    str(meta.ownerUid) ||
    str(r.actor) ||
    str(r.personUid) ||
    str(r.agentUid);
  const note =
    str(r.progressSummary) ||
    str(meta.progressSummary) ||
    str(r.note) ||
    str(r.message) ||
    str(r.summary);
  return {
    threadId,
    companyUid,
    project,
    title,
    status: normalizeThreadStatus(
      r.threadStatus ?? r.status ?? meta.threadStatus ?? meta.status,
    ),
    storyId: storyId || null,
    updatedAt: updatedAt || null,
    actor: actor || null,
    note: note || null,
  };
}

/**
 * Parse a work-mesh threads REST rollup. Accepts `{ threads: [...] }`,
 * a bare array, or anything else (→ []).
 */
export function normalizeThreads(
  state: unknown,
  fallbackCompanyUid = "",
): WorkMeshThread[] {
  const r = rec(state);
  const list = Array.isArray(state)
    ? state
    : Array.isArray(r?.threads)
      ? (r?.threads as unknown[])
      : [];
  const out: WorkMeshThread[] = [];
  for (const item of list) {
    const t = normalizeThread(item, fallbackCompanyUid);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Merge a reconciled single-thread detail into a thread list (replace by
 * threadId, else append). Used when `hq/{companyUid}/thread/{id}` wakes
 * reconcile against the per-thread REST resource.
 */
export function upsertThread(
  threads: readonly WorkMeshThread[],
  detail: WorkMeshThread,
): WorkMeshThread[] {
  const idx = threads.findIndex(
    (t) => t.threadId === detail.threadId && t.companyUid === detail.companyUid,
  );
  if (idx === -1) return [...threads, detail];
  const next = threads.slice();
  next[idx] = detail;
  return next;
}

/** Threads for one company, newest activity first. */
export function threadsForCompany(
  threads: readonly WorkMeshThread[],
  companyUid: string,
): WorkMeshThread[] {
  return threads
    .filter((t) => t.companyUid === companyUid)
    .sort(
      (a, b) =>
        (Date.parse(b.updatedAt ?? "") || 0) -
        (Date.parse(a.updatedAt ?? "") || 0),
    );
}

/** Human status chip label for a thread. */
export const THREAD_STATUS_LABEL: Record<WorkMeshThreadStatus, string> = {
  check: "CHECKING",
  start: "STARTED",
  progress: "IN PROGRESS",
  blocked: "BLOCKED",
  done: "DONE",
  unknown: "—",
};
