/**
 * Plain copy for the sync toast (OWNER-003 addition).
 *
 * Sync and updater states are separate maps: a sync phase never reaches the
 * update toast and an updater state never reaches this one. Raw phase keys
 * are never shown.
 */
import type { SyncStatusState } from "../home/sync-status.js";

export interface SyncToastCopy {
  /** "busy" keeps a sticky toast; "done" swaps it for a quiet one; "none" shows nothing. */
  state: "busy" | "done" | "attention" | "none";
  title: string;
  detail: string;
  progress: number | "indeterminate" | null;
}

function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/**
 * `moved` says whether this run moved anything, so a run that ends with
 * nothing to do does not flash a toast.
 */
export function syncToastCopy(status: SyncStatusState, moved: boolean, paused = false): SyncToastCopy {
  if (paused) {
    return { state: "attention", title: "Sync is paused", detail: "New files will sync when it resumes", progress: null };
  }
  switch (status.phase) {
    case "syncing": {
      const total = status.planTotal;
      const done = Math.min(status.progressed, total || status.progressed);
      const where = status.company ? ` for ${status.company}` : "";
      if (total > 0) {
        return {
          state: "busy",
          title: `Syncing ${files(total)}${where}`,
          detail: `${done} of ${total} done`,
          progress: done / total,
        };
      }
      return {
        state: "busy",
        title: `Syncing files${where}`,
        detail: done > 0 ? `${files(done)} done` : "Checking for changes",
        progress: "indeterminate",
      };
    }
    case "auth-error":
      return { state: "attention", title: "Sync stopped", detail: "Sign in again to keep files syncing", progress: null };
    case "conflict":
      return { state: "attention", title: "Sync needs a decision", detail: "Some files changed in two places", progress: null };
    case "error":
      return { state: "attention", title: "Sync ran into a problem", detail: "HQ will try again shortly", progress: null };
    default:
      return moved
        ? { state: "done", title: "Files up to date", detail: "Sync finished", progress: null }
        : { state: "none", title: "", detail: "", progress: null };
  }
}
