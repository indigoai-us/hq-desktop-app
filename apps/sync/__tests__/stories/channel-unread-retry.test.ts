import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');

describe('channel unread startup completeness', () => {
  it('retries a failed or superseded initial snapshot until the aggregate is complete', () => {
    expect(app).toContain('channelUnreadTracker.hasCompleteSnapshot()');
    expect(app).toContain('scheduleChannelUnreadRetry');
    expect(app).toMatch(
      /if \(channelUnread === null\)[\s\S]*?scheduleChannelUnreadRetry/,
    );
    expect(app).toMatch(
      /list_channels unread summary failed:[\s\S]*?scheduleChannelUnreadRetry/,
    );
    expect(app).toContain('channelUnreadTracker.abandonSnapshot(snapshotToken)');
  });
});
