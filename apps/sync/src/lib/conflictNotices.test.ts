import { describe, expect, it } from 'vitest';
import {
  filterAcknowledgedConflictNotices,
  mergeConflictNotices,
  removeConflictNotice,
  type ConflictParkedNotice,
} from './conflictNotices';

const notice = (id: string, companySlug = 'indigo'): ConflictParkedNotice => ({
  id,
  scope: 'company',
  companySlug,
  relativePath: 'boards/primary.md',
  backupPath: '.hq/conflict-backups/boards/primary.md.backup',
  winnerReason: 'remote-newer',
  sideKept: 'remote',
  parkedAt: '2026-10-08T15:00:00.000Z',
});

describe('conflict parked notices', () => {
  it('dedupes a parked copy by id and keeps same relative paths from separate companies', () => {
    expect(mergeConflictNotices([notice('a')], [notice('a'), notice('b', 'companyx')])).toEqual([
      notice('a'),
      notice('b', 'companyx'),
    ]);
  });

  it('keeps personal and company copies distinct even when their paths match', () => {
    const company = notice('company-id');
    const personal: ConflictParkedNotice = {
      ...company,
      id: 'personal-id',
      scope: 'personal',
      companySlug: null,
    };
    expect(mergeConflictNotices([], [company, personal])).toEqual([company, personal]);
  });

  it('clears only the acknowledged notice', () => {
    expect(removeConflictNotice([notice('a'), notice('b')], 'a')).toEqual([notice('b')]);
    expect(filterAcknowledgedConflictNotices([notice('a'), notice('b')], new Set(['b']))).toEqual([
      notice('a'),
    ]);
  });
});

describe('conflict notice batch dismissal', () => {
  it('treats the dismissed id set as the batch identity', async () => {
    const { isConflictBatchDismissed } = await import('./conflictNotices');
    const dismissed = new Set(['a', 'b']);
    expect(isConflictBatchDismissed([notice('a'), notice('b')], dismissed)).toBe(true);
    expect(isConflictBatchDismissed([notice('b')], dismissed)).toBe(true);
    expect(isConflictBatchDismissed([notice('b'), notice('c')], dismissed)).toBe(false);
    expect(isConflictBatchDismissed([], dismissed)).toBe(false);
  });

  it('round-trips through storage and ignores malformed values', async () => {
    const {
      CONFLICT_DISMISSED_BATCH_KEY,
      clearDismissedConflictBatch,
      readDismissedConflictBatch,
      writeDismissedConflictBatch,
    } = await import('./conflictNotices');
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    writeDismissedConflictBatch(storage, [notice('a'), notice('b')]);
    expect([...readDismissedConflictBatch(storage)].sort()).toEqual(['a', 'b']);
    clearDismissedConflictBatch(storage);
    expect(readDismissedConflictBatch(storage).size).toBe(0);
    data.set(CONFLICT_DISMISSED_BATCH_KEY, '{torn');
    expect(readDismissedConflictBatch(storage).size).toBe(0);
    expect(readDismissedConflictBatch(null).size).toBe(0);
  });

  it('recognises only the conflict review route the native notification carries', async () => {
    const { CONFLICT_REVIEW_ROUTE, isConflictReviewRoute } = await import('./conflictNotices');
    // Must match hq_desktop_core::conflict_notify::CONFLICT_REVIEW_ROUTE.
    expect(CONFLICT_REVIEW_ROUTE).toBe('conflicts');
    expect(isConflictReviewRoute('conflicts')).toBe(true);
    expect(isConflictReviewRoute(' conflicts ')).toBe(true);
    expect(isConflictReviewRoute('meetings')).toBe(false);
    expect(isConflictReviewRoute(null)).toBe(false);
  });
});
