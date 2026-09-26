import { describe, expect, it } from 'vitest';
import {
  afterFanoutPlan,
  afterSyncComplete,
  formatPollOnlyStatus,
} from './poll-only-status';

describe('poll-only sync status', () => {
  it('keeps a completed poll-only plan out of the syncing state', () => {
    expect(afterFanoutPlan('poll-only', false)).toBe('poll-only');
  });

  it('keeps real transfers in the syncing state and returns to poll-only when complete', () => {
    expect(afterFanoutPlan('poll-only', true)).toBe('syncing');
    expect(afterSyncComplete('poll-only')).toBe('poll-only');
  });

  it('keeps the current plan and completion behavior when the status flag is off', () => {
    expect(afterFanoutPlan(null, false)).toBe('syncing');
    expect(afterSyncComplete(null)).toBe('idle');
  });

  it('shows last completed sync age and polling cadence', () => {
    expect(formatPollOnlyStatus('2026-09-26T08:00:00.000Z', 60_000, 600_000,
      Date.parse('2026-09-26T08:02:00.000Z'))).toBe(
      'Synced 2 min ago. Live updates are off. HQ checks every 1 to 10 min.',
    );
  });

  it('states when no completed sync is available yet', () => {
    expect(formatPollOnlyStatus(null)).toBe(
      'No completed sync yet. Live updates are off. HQ checks every 1 to 10 min.',
    );
  });
});
