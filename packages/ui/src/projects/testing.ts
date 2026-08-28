/**
 * Test-only fake ProjectsApi (desktop-alt port). The original suites mocked
 * the Tauri IPC bridge; this fake keeps those suites intact by
 * mapping each adapter method back onto the legacy `(command, args)` IPC
 * call shape, wrapping resolutions as `{ok:true}` results and rejections as
 * `{ok:false, reason:"error"}` (which `unwrap` re-throws — preserving the
 * original throw-on-failure observable behavior).
 */
import type { ProjectsApi } from "@hq/platform";

type IpcLike = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

async function call<T>(
  ipc: IpcLike,
  command: string,
  args?: Record<string, unknown>,
): Promise<
  { ok: true; value: T } | { ok: false; reason: "error"; message: string }
> {
  try {
    const value = (await (args === undefined
      ? ipc(command)
      : ipc(command, args))) as T;
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build a fake adapter.projects slice backed by a legacy IPC mock. */
export function fakeProjectsApi(ipc: IpcLike): ProjectsApi {
  return {
    listProjects: () => call(ipc, "get_local_projects"),
    getGoals: (slug: string) =>
      call(ipc, "get_local_company_goals", { companySlug: slug }),
    getPrd: (prdPath: string) =>
      call(ipc, "get_local_project_prd", { prdPath }),
    getReadme: (prdPath: string) =>
      call(ipc, "get_local_project_readme", { prdPath }),
    setProjectStatus: (ref: string, status: string) => {
      const { boardPath, projectId, prdPath } = JSON.parse(ref) as {
        boardPath: string;
        projectId: string;
        prdPath: string | null;
      };
      return call(ipc, "set_local_project_status", {
        boardPath,
        projectId,
        prdPath,
        status,
      });
    },
    setStoryPasses: (prdPath: string, storyId: string, passes: boolean) =>
      call(ipc, "set_local_story_passes", { prdPath, storyId, passes }),
    getProjectCreators: (slug: string) =>
      call(ipc, "get_company_project_creators", { slug }),
  } as unknown as ProjectsApi;
}
