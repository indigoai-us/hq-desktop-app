/**
 * Injection seams for the Board and project/thread views (US-008).
 *
 * packages/ui stays platform-pure: no Tauri, no direct fetch. The host app
 * implements BoardDataApi (web: WebPlatformAdapter + the same-origin hq-pro
 * proxy; desktop: Tauri commands) and bridges MeshClient wakes into the
 * BoardWakeBus. Mirrors the ChatWakeBus pattern from US-007.
 */

import type {
  BoardPrdInput,
  BoardProjectInput,
  BoardSessionInput,
} from "./board-model";
import type { WorkMeshThread } from "./thread-model";

/** Backend seam for the board surfaces. All methods are absent-safe. */
export interface BoardDataApi {
  /**
   * Person-scoped work-mesh thread rollup (`/v1/work-mesh/threads`) —
   * the reconcile target for `hq/{personUid}/work` wakes.
   */
  listThreads(): Promise<WorkMeshThread[]>;
  /**
   * One thread's durable state
   * (`/v1/work-mesh/companies/{companyUid}/threads/{threadId}`) — the
   * reconcile target for `hq/{companyUid}/thread/#` wakes; retained
   * THREAD_META snapshots replay these wakes to hydrate late subscribers.
   */
  getThread(
    companyUid: string,
    threadId: string,
  ): Promise<WorkMeshThread | null>;
  /** Project listing for the kanban surface (empty until the API lands). */
  listProjects(): Promise<BoardProjectInput[]>;
  /** PRD for a project (`prdPath` from listProjects); null when absent. */
  getPrd(prdPath: string): Promise<BoardPrdInput | null>;
  /**
   * Work-session records. Polled until work-session wakes land (US-009);
   * absent-safe — resolves [] while the backing API does not exist.
   */
  listWorkSessions(): Promise<BoardSessionInput[]>;
}

/** Wake events the host bridges from the MeshClient into the board. */
export interface BoardWakeEvents {
  /** A `thread:{companyUid}:{threadId}` resource reconciled. */
  "thread:reconciled": { companyUid: string; threadId: string; state: unknown };
  /** The person-scoped `work:` rollup reconciled (thread list changed). */
  "work:reconciled": { state: unknown };
  /** A work-session wake was observed (US-009 flip signal). */
  "work-session:wake": undefined;
  /** Latest STS-vend droppedCompanies emission (may be empty). */
  "dropped-companies": string[];
}

export type BoardWakeEventName = keyof BoardWakeEvents;

export interface BoardWakeBus {
  on<K extends BoardWakeEventName>(
    event: K,
    handler: (payload: BoardWakeEvents[K]) => void,
  ): () => void;
}

/** In-memory bus hosts use to bridge MeshClient events to board views. */
export function createBoardWakeBus(): BoardWakeBus & {
  emit<K extends BoardWakeEventName>(
    event: K,
    payload: BoardWakeEvents[K],
  ): void;
} {
  const handlers = new Map<string, Set<(payload: never) => void>>();
  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (payload: never) => void);
      return () => set.delete(handler as (payload: never) => void);
    },
    emit(event, payload) {
      for (const h of handlers.get(event) ?? []) {
        (h as (p: unknown) => void)(payload);
      }
    },
  };
}

/**
 * Parse a reconcile resource key (`thread:{companyUid}:{threadId}`) as
 * emitted by the shared MeshClient. Returns null for other resources.
 */
export function parseThreadResource(
  resource: string,
): { companyUid: string; threadId: string } | null {
  if (!resource.startsWith("thread:")) return null;
  const rest = resource.slice("thread:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const companyUid = rest.slice(0, sep);
  const threadId = rest.slice(sep + 1);
  if (!companyUid || !threadId) return null;
  return { companyUid, threadId };
}
