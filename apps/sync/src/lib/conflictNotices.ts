export interface ConflictParkedNotice {
  id: string;
  companySlug: string;
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
