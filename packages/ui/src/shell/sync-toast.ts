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
export function syncToastCopy(
  status: SyncStatusState,
  moved: boolean,
  paused = false,
  /** AUDIT-3: company display name for a slug; null omits the company. */
  companyName: (slug: string) => string | null = () => null,
): SyncToastCopy {
  if (paused) {
    return { state: "attention", title: "Sync is paused", detail: "New files will sync when it resumes", progress: null };
  }
  switch (status.phase) {
    case "syncing": {
      const total = status.planTotal;
      const done = Math.min(status.progressed, total || status.progressed);
      // Never the raw slug: only a display name the shell knows.
      const name = status.company ? companyName(status.company)?.trim() : "";
      const where = name ? ` for ${name}` : "";
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

/**
 * Companies whose sync toast the person closed with X.
 *
 * Rule: X hides the toast for the rest of the current run (every company in
 * it, through every later progress tick and batch), and keeps it hidden for
 * that company on later runs and after a restart. The company's toast comes
 * back only when the person starts a sync for it themselves (Sync now). A
 * toast closed before the run named its company records the wildcard and
 * hides every company's toast until the next sync the person starts.
 *
 * Stored per account (tenant storage, company scope "all") so another HQ
 * account on the same computer does not inherit it.
 */
export const SYNC_TOAST_DISMISSED_KEY = "hq.syncToast.dismissed.v1";
export const SYNC_TOAST_ANY_COMPANY = "*";

type DismissStorage = Pick<Storage, "getItem" | "setItem">;

export function readDismissedSyncToasts(storage: DismissStorage | null | undefined): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(SYNC_TOAST_DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0) : []);
  } catch {
    return new Set();
  }
}

export function writeDismissedSyncToasts(storage: DismissStorage | null | undefined, companies: ReadonlySet<string>): void {
  if (!storage) return;
  try {
    storage.setItem(SYNC_TOAST_DISMISSED_KEY, JSON.stringify([...companies].sort()));
  } catch {
    // Private mode / quota: the in-memory set still holds for this window.
  }
}

/** True when the person has closed this company's sync toast (or every company's). */
export function isSyncToastDismissed(dismissed: ReadonlySet<string>, company: string | null): boolean {
  if (dismissed.has(SYNC_TOAST_ANY_COMPANY)) return true;
  return company !== null && dismissed.has(company);
}

/** The set after X on a toast naming `company` (null: the run named none yet). */
export function withSyncToastDismissed(dismissed: ReadonlySet<string>, company: string | null): Set<string> {
  const next = new Set(dismissed);
  next.add(company ?? SYNC_TOAST_ANY_COMPANY);
  return next;
}

/**
 * The set after the person starts a sync: a scoped start re-enables that
 * company (and drops the wildcard); an unscoped start re-enables all.
 */
export function withSyncToastRestored(dismissed: ReadonlySet<string>, company?: string | null): Set<string> {
  if (!company) return new Set();
  const next = new Set(dismissed);
  next.delete(company);
  next.delete(SYNC_TOAST_ANY_COMPANY);
  return next;
}
