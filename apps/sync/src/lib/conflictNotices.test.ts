import { describe, expect, it } from 'vitest';
import {
  filterAcknowledgedConflictNotices,
  mergeConflictNotices,
  removeConflictNotice,
  type ConflictParkedNotice,
} from './conflictNotices';

const notice = (id: string, companySlug = 'indigo'): ConflictParkedNotice => ({
  id,
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

  it('clears only the acknowledged notice', () => {
    expect(removeConflictNotice([notice('a'), notice('b')], 'a')).toEqual([notice('b')]);
    expect(filterAcknowledgedConflictNotices([notice('a'), notice('b')], new Set(['b']))).toEqual([
      notice('a'),
    ]);
  });
});
