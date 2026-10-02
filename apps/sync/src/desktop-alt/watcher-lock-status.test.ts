import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { watcherLockNoticeFromStatus } from './watcher-lock-status';

const shell = readFileSync(
  fileURLToPath(new URL('./HqWorkWorkShell.svelte', import.meta.url)),
  'utf8',
);

describe('visible desktop watcher lock status', () => {
  it('renders the waiting state with only the safe holder label supplied by Rust', () => {
    expect(watcherLockNoticeFromStatus({
      state: 'waiting-for-lock',
      holderCommand: 'hq sync',
    })).toBe('Waiting for another sync (hq sync)');
    expect(watcherLockNoticeFromStatus({ state: 'waiting-for-lock' }))
      .toBe('Waiting for another sync');
    expect(watcherLockNoticeFromStatus({ state: 'running' })).toBeNull();
  });

  it('subscribes the visible Work shell and renders its lock notice', () => {
    expect(shell).toContain("'sync:watcher-status'");
    expect(shell).toContain('watcherLockNoticeFromStatus(event.payload)');
    expect(shell).toContain('data-testid="sync-watcher-lock-status"');
    expect(shell).toContain('{watcherLockNotice}');
  });
});
