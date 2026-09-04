/**
 * Svelte 5 runes mirror of the framework-free LiveReadStore from @hq/core.
 *
 * Hosts call `bindLiveReadStore(store)` once (mesh-runtime / desktop-alt).
 * Components read `liveReadFor(companyUid)` inside $derived.
 */

import type { LiveReadResponse, LiveReadStore } from "@hq/core";
import { liveSessionsForProject } from "@hq/core";
import type {
  LiveReadSessionInput,
  StatusPresenceInput,
} from "./channel-status-model.js";

let snapshot = $state<ReadonlyMap<string, LiveReadResponse>>(new Map());
let bound: LiveReadStore | null = null;
let unsubscribe: (() => void) | null = null;

export function liveReadSnapshot(): ReadonlyMap<string, LiveReadResponse> {
  return snapshot;
}

export function liveReadFor(companyUid: string): LiveReadResponse | undefined {
  return snapshot.get(companyUid.trim());
}

/** Presence + project-scoped sessions for channel status / board (US-015). */
export function liveInputsForCompanyProject(
  companyUid: string,
  projectId: string,
): {
  liveSessions: LiveReadSessionInput[];
  presence: StatusPresenceInput[];
} {
  const response = liveReadFor(companyUid);
  const presence: StatusPresenceInput[] = (response?.participants ?? []).map(
    (p) => ({
      actorUid: p.actorUid,
      status: p.presence,
      actorType: p.actorType,
    }),
  );
  const liveSessions: LiveReadSessionInput[] = liveSessionsForProject(
    response,
    projectId,
  ).map((s) => ({
    sessionId: s.sessionId,
    actorUid: s.actorUid,
    actorType: s.actorType,
    displayName: s.displayName,
    harness: s.harness,
    taskId: s.taskId ?? null,
    turnCount: s.turnCount,
    status: s.status,
    lastTurnAt: s.lastTurnAt,
    startedAt: s.startedAt,
  }));
  return { liveSessions, presence };
}

export function bindLiveReadStore(store: LiveReadStore): () => void {
  unsubscribe?.();
  bound = store;
  snapshot = store.snapshot();
  unsubscribe = store.subscribeSnapshot((next) => {
    snapshot = next;
  });
  return () => {
    if (bound === store) {
      unsubscribe?.();
      unsubscribe = null;
      bound = null;
      snapshot = new Map();
    }
  };
}
