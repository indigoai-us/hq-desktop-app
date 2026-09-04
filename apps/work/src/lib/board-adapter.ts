/**
 * Web bridge from the PlatformAdapter + direct hq-pro client to the
 * packages/ui board seams (US-008). The browser-held token is attached by
 * `$lib/hq-pro-client`; packages/ui continues to consume structural APIs.
 *
 * Absent-safety: work-mesh endpoints that do not exist yet (or return
 * unavailable through the adapter) resolve to empty data — the board renders
 * honest empty states and the polling/wake feeds keep retrying, so no code
 * change is needed when the backing APIs land.
 */

import type { PlatformAdapter } from "@hq/platform";
import type {
  BoardDataApi,
  BoardPrdInput,
  BoardProjectInput,
  BoardSessionInput,
  WorkMeshThread,
} from "@hq/ui";
// Value imports come from the pure-TS subpath (no .svelte re-exports), so
// this module stays loadable in plain-node vitest (US-007 convention).
import { normalizeThread, normalizeThreads } from "@hq/ui/board/thread-model";
import { hqProFetch } from "./hq-pro-client.js";

/** Provisional work-mesh REST paths (mirror packages/core reconcile routes). */
export const WORK_MESH_PATHS = {
  threads: "/v1/work-mesh/threads",
  thread: (companyUid: string, threadId: string) =>
    `/v1/work-mesh/companies/${encodeURIComponent(companyUid)}/threads/${threadId
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  workSessions: "/v1/work-mesh/work-sessions",
} as const;

type FetchLike = typeof fetch;

/**
 * Absent-safe GET: 404/501 (API not shipped yet) → null; other failures
 * throw so callers can distinguish "empty" from "broken".
 */
async function getJson(
  fetchFn: FetchLike,
  path: string,
): Promise<unknown | null> {
  const res = await fetchFn(path);
  if (res.status === 404 || res.status === 501) return null;
  if (!res.ok) throw new Error(`[http-${res.status}] GET ${path} failed`);
  return res.json().catch(() => null);
}

function sessionsFromState(state: unknown): BoardSessionInput[] {
  const rec =
    typeof state === "object" && state != null && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : null;
  const list = Array.isArray(state)
    ? state
    : Array.isArray(rec?.sessions)
      ? (rec?.sessions as unknown[])
      : [];
  const out: BoardSessionInput[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item == null) continue;
    const s = item as Record<string, unknown>;
    out.push({
      project: typeof s.project === "string" ? s.project : "",
      company: typeof s.company === "string" ? s.company : "",
      cwd: typeof s.cwd === "string" ? s.cwd : "",
      status: typeof s.status === "string" ? s.status : "",
      ...(typeof s.tool === "string" ? { tool: s.tool } : {}),
      ...(typeof s.model === "string" ? { model: s.model } : {}),
      ...(typeof s.source === "string" ? { source: s.source } : {}),
      ...(typeof s.storyId === "string" ? { storyId: s.storyId } : {}),
      ...(typeof s.progressPercent === "number"
        ? { progressPercent: s.progressPercent }
        : {}),
    });
  }
  return out;
}

export function createBoardDataApi(
  adapter: PlatformAdapter,
  fetchFn: FetchLike = hqProFetch,
): BoardDataApi {
  return {
    async listThreads(): Promise<WorkMeshThread[]> {
      const state = await getJson(fetchFn, WORK_MESH_PATHS.threads).catch(
        () => null,
      );
      return normalizeThreads(state);
    },

    async getThread(
      companyUid: string,
      threadId: string,
    ): Promise<WorkMeshThread | null> {
      const state = await getJson(
        fetchFn,
        WORK_MESH_PATHS.thread(companyUid, threadId),
      ).catch(() => null);
      if (state == null) return null;
      const rec = state as Record<string, unknown>;
      return normalizeThread(rec.thread ?? state, companyUid);
    },

    async listProjects(): Promise<BoardProjectInput[]> {
      // Adapter route: returns unavailable ("not-yet-implemented-api") on
      // web today — degrade to [] (honest empty kanban) until it ships.
      const result = await adapter.projects.listProjects();
      if (!result.ok) return [];
      return result.value
        .filter((p): p is Record<string, unknown> => p != null)
        .map((p) => ({
          id: typeof p.id === "string" ? p.id : "",
          ...(typeof p.title === "string" ? { title: p.title } : {}),
          ...(typeof p.name === "string" ? { name: p.name } : {}),
          ...(typeof p.company === "string" ? { company: p.company } : {}),
          ...(typeof p.prdPath === "string" ? { prdPath: p.prdPath } : {}),
        }))
        .filter((p) => p.id.length > 0);
    },

    async getPrd(prdPath: string): Promise<BoardPrdInput | null> {
      const result = await adapter.projects.getPrd(prdPath);
      if (!result.ok) return null;
      return result.value as BoardPrdInput;
    },

    async listWorkSessions(): Promise<BoardSessionInput[]> {
      // Work-session records degrade to polling until US-009; the endpoint
      // 404s today → [] (absent-safe), flips to data with no code change.
      const state = await getJson(fetchFn, WORK_MESH_PATHS.workSessions).catch(
        () => null,
      );
      return sessionsFromState(state);
    },
  };
}
