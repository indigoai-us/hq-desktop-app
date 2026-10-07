import { describe, expect, it, vi } from 'vitest';
import {
  afterFanoutPlan,
  afterSyncComplete,
  formatPollOnlyStatus,
  pollOnlyStatusMode,
  shouldRefreshPollOnlyTrayStatus,
} from './poll-only-status';

describe('poll-only sync status', () => {
  it('uses poll-only status only when the hq-flag is enabled', () => {
    expect(pollOnlyStatusMode('poll-only', false)).toBeNull();
    expect(pollOnlyStatusMode('poll-only', true)).toBe('poll-only');
  });

  it('keeps a completed poll-only plan out of the syncing state', () => {
    expect(afterFanoutPlan('poll-only', false)).toBe('poll-only');
  });

  it('keeps real transfers in the syncing state and returns to poll-only when complete', () => {
    expect(afterFanoutPlan('poll-only', true)).toBe('syncing');
    expect(afterSyncComplete('poll-only')).toBe('poll-only');
  });

  it('keeps the current plan and completion behavior when the status flag is off', () => {
    const modeWhenFlagOff = pollOnlyStatusMode('poll-only', false);
    expect(afterFanoutPlan(modeWhenFlagOff, false)).toBe('syncing');
    expect(afterSyncComplete(modeWhenFlagOff)).toBe('idle');
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

  it.each(['error', 'reauth', 'auth-error', 'conflict'] as const)(
    'does not set poll-only tray status on a 60-second refresh while sync state is %s',
    (syncState) => {
      const setTrayState = vi.fn();
      vi.useFakeTimers();
      try {
        const timer = setInterval(() => {
          if (shouldRefreshPollOnlyTrayStatus('poll-only', syncState, false, false, false)) {
            setTrayState('poll-only');
          }
        }, 60_000);

        vi.advanceTimersByTime(60_000);
        clearInterval(timer);

        expect(setTrayState).not.toHaveBeenCalledWith('poll-only');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('refreshes poll-only tray status only after sync and transfers are idle', () => {
    expect(shouldRefreshPollOnlyTrayStatus('poll-only', 'poll-only', false, false, false))
      .toBe(true);
    expect(shouldRefreshPollOnlyTrayStatus('poll-only', 'poll-only', true, false, false))
      .toBe(false);
    expect(shouldRefreshPollOnlyTrayStatus('poll-only', 'poll-only', false, true, false))
      .toBe(false);
    expect(shouldRefreshPollOnlyTrayStatus('poll-only', 'poll-only', false, false, true))
      .toBe(false);
    expect(shouldRefreshPollOnlyTrayStatus('realtime', 'poll-only', false, false, false))
      .toBe(false);
  });
});
