export interface ConflictParkedNotice {
  id: string;
  scope: 'company' | 'personal';
  companySlug: string | null;
  relativePath: string;
  backupPath: string;
  winnerReason: 'local-newer' | 'remote-newer' | 'remote-changed-since-journal';
  sideKept: 'local' | 'remote';
  parkedAt: string;
}

const MAX_PENDING_NOTICES = 50;

export function mergeConflictNotices(
  current: readonly ConflictParkedNotice[],
  incoming: readonly ConflictParkedNotice[],
): ConflictParkedNotice[] {
  const byId = new Map(current.map((notice) => [notice.id, notice]));
  for (const notice of incoming) byId.set(notice.id, notice);
  return [...byId.values()].slice(-MAX_PENDING_NOTICES);
}

export function removeConflictNotice(
  notices: readonly ConflictParkedNotice[],
  id: string,
): ConflictParkedNotice[] {
  return notices.filter((notice) => notice.id !== id);
}

export function filterAcknowledgedConflictNotices(
  notices: readonly ConflictParkedNotice[],
  acknowledgedIds: ReadonlySet<string>,
): ConflictParkedNotice[] {
  return notices.filter((notice) => !acknowledgedIds.has(notice.id));
}

/**
 * Route a parked-conflict OS notification click carries (Rust:
 * `hq_desktop_core::conflict_notify::CONFLICT_REVIEW_ROUTE`). The shell turns
 * it into "show the conflict toast with its Review list open" instead of a
 * screen change.
 */
export const CONFLICT_REVIEW_ROUTE = 'conflicts';

export function isConflictReviewRoute(route: unknown): boolean {
  return typeof route === 'string' && route.trim() === CONFLICT_REVIEW_ROUTE;
}

/** localStorage key for the batch the person closed with the toast's X. */
export const CONFLICT_DISMISSED_BATCH_KEY = 'hq.conflictNotices.dismissedBatch.v1';

export type ConflictBatchStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The batch identity is the set of notice ids. A batch the person dismissed
 * stays dismissed while every pending notice was part of it: acknowledging or
 * dropping notices only shrinks the set. Any id outside it is a new batch.
 */
export function readDismissedConflictBatch(storage: ConflictBatchStorage | null): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(CONFLICT_DISMISSED_BATCH_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

export function writeDismissedConflictBatch(
  storage: ConflictBatchStorage | null,
  notices: readonly ConflictParkedNotice[],
): Set<string> {
  const ids = new Set(notices.map((notice) => notice.id));
  try {
    storage?.setItem(CONFLICT_DISMISSED_BATCH_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage full or unavailable: the dismissal still holds for this window.
  }
  return ids;
}

export function clearDismissedConflictBatch(storage: ConflictBatchStorage | null): void {
  try {
    storage?.removeItem(CONFLICT_DISMISSED_BATCH_KEY);
  } catch {
    // Nothing persisted to clear.
  }
}

export function isConflictBatchDismissed(
  notices: readonly ConflictParkedNotice[],
  dismissedIds: ReadonlySet<string>,
): boolean {
  return notices.length > 0 && notices.every((notice) => dismissedIds.has(notice.id));
}

export function defaultConflictBatchStorage(): ConflictBatchStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}
