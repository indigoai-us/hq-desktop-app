/**
 * Work Mesh installer copy. HQ install is a yes/no first; this step is always
 * next, and it never replaces an existing HQ tree.
 */

export type MeshDoctorPhase = "apply" | "projects" | "chats" | "done" | "error";

export interface MeshDoctorProgress {
  phase: MeshDoctorPhase;
  current: number;
  total: number;
  label: string;
}

export const MESH_TITLE = "HQ Work in Real Time";

export const MESH_BODY =
  "Now all your work syncs between machines, people and agents as it happens. Your team everywhere all at once.";

export const MESH_BANDS = [
  "Installing.",
  "Syncing projects to the mesh.",
] as const;

/** @deprecated use MESH_TITLE */
export const MESH_UPGRADE_TITLE = MESH_TITLE;
/** @deprecated use MESH_BODY */
export const MESH_UPGRADE_BODY = MESH_BODY;
/** @deprecated use MESH_BANDS */
export const MESH_UPGRADE_BANDS = MESH_BANDS;

export function meshProgressLine(progress: MeshDoctorProgress | null): string {
  if (!progress || progress.phase === "apply") return MESH_BANDS[0];
  if (progress.phase === "done") return "Synced projects to the mesh.";
  if (progress.phase === "error") {
    return progress.label || "Couldn't finish syncing.";
  }
  const counts =
    progress.total > 0 ? ` ${progress.current}/${progress.total}` : "";
  if (progress.phase === "chats") {
    return `Syncing chats.${counts}`;
  }
  return `${MESH_BANDS[1]}${counts}`;
}

export function meshBandsFromProgress(
  progress: MeshDoctorProgress | null,
): Array<{ label: string; status: "pending" | "active" | "done" }> {
  const installingDone =
    progress != null &&
    progress.phase !== "apply" &&
    progress.phase !== "error";
  const syncingDone = progress?.phase === "done";
  const syncingActive =
    progress != null &&
    (progress.phase === "projects" || progress.phase === "chats");
  let syncLabel: string = MESH_BANDS[1];
  if (syncingDone) syncLabel = "Synced projects to the mesh.";
  else if (syncingActive) syncLabel = meshProgressLine(progress);
  return [
    {
      label: MESH_BANDS[0],
      status: installingDone ? "done" : "active",
    },
    {
      label: syncLabel,
      status: syncingDone ? "done" : syncingActive ? "active" : "pending",
    },
  ];
}
