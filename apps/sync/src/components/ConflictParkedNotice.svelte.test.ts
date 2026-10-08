import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import ConflictParkedNotice from './ConflictParkedNotice.svelte';
import type { ConflictParkedNotice as Notice } from '../lib/conflictNotices';

const notice: Notice = {
  id: 'a'.repeat(64),
  companySlug: 'indigo',
  relativePath: 'boards/primary.md',
  backupPath: '.hq/conflict-backups/boards/primary.md.backup',
  winnerReason: 'remote-newer',
  sideKept: 'remote',
  parkedAt: '2026-10-08T15:00:00.000Z',
};

describe('ConflictParkedNotice rendering', () => {
  it('names the file and provides Finder and acknowledgement actions', () => {
    const html = render(ConflictParkedNotice, {
      props: { notices: [notice], busyIds: new Set<string>(), onShowInFinder: vi.fn(), onAcknowledge: vi.fn() },
    }).body;

    expect(html).toContain('Conflict copy parked');
    expect(html).toContain('boards/primary.md');
    expect(html).toContain('Show in Finder');
    expect(html).toContain('Dismiss');
  });
});
