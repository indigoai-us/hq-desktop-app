/**
 * Shared wake/reconcile routing for the board surfaces (US-008 review fixes).
 *
 * One pure module consumed by BOTH the board page
 * (routes/(app)/board/+page.svelte) and the story acceptance tests, so the
 * production routing and the tested routing cannot drift:
 *
 * - `isWorkSessionTopic` — exact `hq/{uid}/work-session/...` segment parse
 *   (the US-009 feature-detect signal). Substring checks are forbidden: a
 *   thread id containing "/work-session" must NOT flip the session feed.
 * - `applyBoardReconcile` — routes a MeshClient `reconciled` result:
 *   `thread:*` upserts the normalized per-thread detail (via
 *   parseThreadResource, never a hand-rolled split); `work:*` replaces the
 *   whole list from the reconciled durable state DIRECTLY — no re-fetch, so
 *   WakeReconciler's per-resource ordering/coalescing guarantees hold and a
 *   slow stale refetch can never overwrite newer state.
 */

import { parseThreadResource, type BoardWakeEvents } from "./board-api";
import {
  normalizeThread,
  normalizeThreads,
  upsertThread,
  type WorkMeshThread,
} from "./thread-model";

/**
 * True only for the exact `hq/{uid}/work-session/...` topic shape. This is
 * the US-009 feature-detection channel: observing one (retained replays
 * included) flips the work-session feed from polling to wake-driven.
 * Segment-parsed — a thread topic whose id merely CONTAINS "/work-session"
 * (e.g. hq/cmp_x/thread/proj/work-session-notes) never matches.
 */
export function isWorkSessionTopic(topic: string): boolean {
  const parts = topic.split("/");
  return (
    parts.length >= 4 &&
    parts[0] === "hq" &&
    parts[1].length > 0 &&
    parts[2] === "work-session" &&
    parts[3].length > 0
  );
}

/** The subset of a MeshClient `reconciled` result the board routes on. */
export interface BoardReconcileResult {
  resource: string;
  state: unknown;
}

export interface BoardReconcileOutcome {
  /** Next thread list (unchanged reference when the resource was unknown). */
  threads: WorkMeshThread[];
  /** Which board resource the result matched, if any. */
  handled: "thread" | "work" | null;
}

/**
 * Route one reconciled result into the board thread list, emitting the
 * matching wake-bus event. Pure: returns the next list; callers assign it.
 */
export function applyBoardReconcile(
  result: BoardReconcileResult,
  threads: WorkMeshThread[],
  emit: <K extends keyof BoardWakeEvents>(
    event: K,
    payload: BoardWakeEvents[K],
  ) => void,
): BoardReconcileOutcome {
  const parsed = parseThreadResource(result.resource);
  if (parsed) {
    // Per-thread reconcile (hq/{companyUid}/thread/# wake — retained
    // THREAD_META replays hydrate late subscribers through this path).
    const state = result.state as Record<string, unknown> | null;
    const detail = normalizeThread(state?.thread ?? state, parsed.companyUid);
    emit("thread:reconciled", {
      companyUid: parsed.companyUid,
      threadId: parsed.threadId,
      state: result.state,
    });
    return {
      threads: detail ? upsertThread(threads, detail) : threads,
      handled: "thread",
    };
  }
  if (result.resource.startsWith("work:")) {
    // Person-scoped rollup: the reconciled durable state IS the new list
    // when it is a thread rollup (`threads: []`). GET /v1/work-mesh/work is
    // a work-item snapshot and must not wipe the Board.
    emit("work:reconciled", { state: result.state });
    const rec =
      result.state &&
      typeof result.state === "object" &&
      !Array.isArray(result.state)
        ? (result.state as Record<string, unknown>)
        : null;
    if (Array.isArray(result.state) || Array.isArray(rec?.threads)) {
      return { threads: normalizeThreads(result.state), handled: "work" };
    }
    return { threads, handled: "work" };
  }
  return { threads, handled: null };
}
