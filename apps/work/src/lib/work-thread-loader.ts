import { normalizeThreads, type WorkMeshThread, type Workspace } from "@hq/ui";

import { hqProFetch, type HqProFetch } from "./hq-pro-client.js";

export async function loadWorkThreads(
  roster: Workspace[],
  fetchImpl: HqProFetch = hqProFetch,
): Promise<WorkMeshThread[]> {
  const uids = [
    ...new Set(
      roster
        .map((row) => row.cloudUid?.trim())
        .filter((uid): uid is string => Boolean(uid)),
    ),
  ];
  if (uids.length === 0) {
    return [];
  }
  const collected: WorkMeshThread[] = [];
  await Promise.all(
    uids.flatMap((uid) =>
      ["in-progress", "claimed", "blocked"].map(async (status) => {
        try {
          const res = await fetchImpl(
            `/v1/work-mesh/threads?companyUid=${encodeURIComponent(uid)}&status=${encodeURIComponent(status)}&limit=50`,
          );
          if (!res.ok) return;
          collected.push(...normalizeThreads(await res.json(), uid));
        } catch {
          /* absent-safe */
        }
      }),
    ),
  );
  return collected;
}
