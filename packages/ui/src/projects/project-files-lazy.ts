/**
 * Door into the Project Files chunk (US-025). The host renders a skeleton
 * on the first frame and imports the body only after the Files tab mounts.
 */
type ProjectFilesModule = typeof import("./ProjectFilesBody.svelte");

let pending: Promise<ProjectFilesModule> | null = null;

export function loadProjectFiles(): Promise<ProjectFilesModule> {
  pending ??= import("./ProjectFilesBody.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
