import {
  projectIdentity,
  saveLocalProjectStatus,
  saveLocalStoryPasses,
} from "./local-projects.js";
import type { Project } from "./projects-model.js";

// ---------------------------------------------------------------------------
// Projects mutation store (US-010) — optimistic local status/passes writes.
//
// Why this exists: the US-009 detail view rendered the status control read-only.
// US-010 makes the board a control center — selecting a status persists to the
// company `board.json` (and a story-passes toggle persists to the project's
// prd.json) through the new Rust write commands. Persistence is slow enough
// (disk read → parse → mutate → atomic rename) that a blocking await would make
// the dropdown feel laggy, so this store follows the stale-while-revalidate
// shape of company-store: it applies the change to an in-memory overlay
// IMMEDIATELY (optimistic paint), fires the write, and on failure ROLLS BACK the
// overlay to the prior value and surfaces a clear error string.
//
// The maps keep the queue logic unit-testable; one rune-backed version signal
// makes their public read methods reactive for whichever detail-view instance
// is currently mounted. Per-board queues keep rapid navigation from issuing
// overlapping read-modify-write operations against one company board, while
// pending and optimistic state remain isolated by stable project identity.
// ---------------------------------------------------------------------------

/** Invalidates reactive readers whenever exposed status state changes. */
let statusStateVersion = $state(0);
/** Optimistically-applied status overrides, keyed by stable project identity. */
const statusOverride = new Map<string, string>();
/** Last status known to have reached disk, used for ordered rollback. */
const committedStatus = new Map<string, string>();
/** Number of queued/running writes for an identity. */
const statusPendingCount = new Map<string, number>();
/** Settled tail of each company board's write queue. */
const statusWriteTail = new Map<string, Promise<void>>();
/** Latest optimistic mutation revision for rollback ownership. */
const statusRevision = new Map<string, number>();
/** Optimistically-applied story-passes overrides, keyed by `${prdPath}:${id}`. */
const passesOverride = new Map<string, boolean>();

function storyKey(prdPath: string, storyId: string): string {
  return `${prdPath}:${storyId}`;
}

/**
 * Derive a project's company `board.json` HQ-relative path. The board lives at
 * `companies/<company>/board.json` — the same tree the readers scan. Returns
 * null when the project has no company (an unlinked prd-only project), in which
 * case there is nothing to persist a board status to.
 */
export function boardPathFor(project: Pick<Project, "company">): string | null {
  const company = (project.company ?? "").trim();
  if (!company) return null;
  return `companies/${company}/board.json`;
}

export interface StatusWriteResult {
  ok: boolean;
  /** The value the caller should show (new on success, last committed on rollback). */
  status: string;
  /** A clear, user-facing error string when `ok === false`. */
  error: string | null;
}

/**
 * Optimistically set a project's status and persist it.
 *
 * The overlay records `next` before persistence starts. Writes for the same
 * stable identity run in call order; on failure the latest optimistic mutation
 * rolls back to the last value that reached disk.
 */
export async function setProjectStatus(
  project: Pick<Project, "id" | "company" | "prdPath">,
  previous: string,
  next: string,
): Promise<StatusWriteResult> {
  const key = projectIdentity(project);
  const boardPath = boardPathFor(project);
  if (!boardPath) {
    return {
      ok: false,
      status: previous,
      error: "This project has no company board to save to.",
    };
  }

  if (!committedStatus.has(key)) committedStatus.set(key, previous);
  const revision = (statusRevision.get(key) ?? 0) + 1;
  statusRevision.set(key, revision);

  // Optimistic overlay and pending state are visible before the queued write.
  statusOverride.set(key, next);
  statusPendingCount.set(key, (statusPendingCount.get(key) ?? 0) + 1);
  statusStateVersion += 1;

  const predecessor = statusWriteTail.get(boardPath) ?? Promise.resolve();
  const operation = predecessor.then(async (): Promise<StatusWriteResult> => {
    try {
      await saveLocalProjectStatus(
        boardPath,
        project.id,
        project.prdPath || null,
        next,
      );
      committedStatus.set(key, next);
      return { ok: true, status: next, error: null };
    } catch (err) {
      const rollbackStatus = committedStatus.get(key) ?? previous;
      // Do not let an older failed write clobber a newer queued optimistic value.
      if (statusRevision.get(key) === revision) {
        statusOverride.set(key, rollbackStatus);
        statusStateVersion += 1;
      }
      console.error("set_local_project_status failed:", err);
      return {
        ok: false,
        status: rollbackStatus,
        error: "Could not save the status change. Please try again.",
      };
    }
  });
  const settledTail = operation.then(
    () => undefined,
    () => undefined,
  );
  statusWriteTail.set(boardPath, settledTail);
  try {
    return await operation;
  } finally {
    const remaining = (statusPendingCount.get(key) ?? 1) - 1;
    if (remaining > 0) statusPendingCount.set(key, remaining);
    else statusPendingCount.delete(key);
    if (statusWriteTail.get(boardPath) === settledTail) {
      statusWriteTail.delete(boardPath);
    }
    statusStateVersion += 1;
  }
}

export interface PassesWriteResult {
  ok: boolean;
  passes: boolean;
  error: string | null;
}

/** Optimistically toggle a story's `passes` and persist it to the prd.json. */
export async function setStoryPasses(
  prdPath: string,
  storyId: string,
  previous: boolean,
  next: boolean,
): Promise<PassesWriteResult> {
  const key = storyKey(prdPath, storyId);
  passesOverride.set(key, next);
  try {
    await saveLocalStoryPasses(prdPath, storyId, next);
    return { ok: true, passes: next, error: null };
  } catch (err) {
    passesOverride.set(key, previous);
    console.error("set_local_story_passes failed:", err);
    return {
      ok: false,
      passes: previous,
      error: "Could not save the story change. Please try again.",
    };
  }
}

/** Read surface — the last optimistically-applied overlay, if any. */
export const projectsStore = {
  statusOverride(
    project: Pick<Project, "id" | "company" | "prdPath">,
  ): string | null {
    void statusStateVersion;
    return statusOverride.get(projectIdentity(project)) ?? null;
  },
  statusPending(project: Pick<Project, "id" | "company" | "prdPath">): boolean {
    void statusStateVersion;
    return (statusPendingCount.get(projectIdentity(project)) ?? 0) > 0;
  },
  passesOverride(prdPath: string, storyId: string): boolean | null {
    const v = passesOverride.get(storyKey(prdPath, storyId));
    return v === undefined ? null : v;
  },
  setProjectStatus,
  setStoryPasses,
  boardPathFor,
  /** Test-only reset of the overlays between runs. */
  _reset(): void {
    statusOverride.clear();
    committedStatus.clear();
    statusPendingCount.clear();
    statusWriteTail.clear();
    statusRevision.clear();
    passesOverride.clear();
    statusStateVersion += 1;
  },
};
