import { describe, expect, it } from 'vitest';
import { UnreadSummaryTracker } from './unreadSummaryTracker';

describe('UnreadSummaryTracker', () => {
  it('invalidates an in-flight summary when authentication resets', () => {
    const tracker = new UnreadSummaryTracker();
    const stale = tracker.beginSnapshot();
    const staleAuthEpoch = tracker.captureAuthEpoch();

    tracker.reset();

    expect(tracker.isAuthEpochCurrent(staleAuthEpoch)).toBe(false);
    expect(
      tracker.commitSnapshot(
        stale,
        { unreadDms: 8, pendingRequests: 3 },
        { unreadDms: 0, pendingRequests: 0 },
      ),
    ).toBeNull();
  });

  it('lets only the newest overlapping summary commit', () => {
    const tracker = new UnreadSummaryTracker();
    const older = tracker.beginSnapshot();
    const newer = tracker.beginSnapshot();

    expect(
      tracker.commitSnapshot(
        older,
        { unreadDms: 9, pendingRequests: 9 },
        { unreadDms: 0, pendingRequests: 0 },
      ),
    ).toBeNull();
    expect(
      tracker.commitSnapshot(
        newer,
        { unreadDms: 2, pendingRequests: 1 },
        { unreadDms: 0, pendingRequests: 0 },
      ),
    ).toEqual({ unreadDms: 2, pendingRequests: 1 });
  });

  it('preserves a newer DM event while reconciling the request snapshot', () => {
    const tracker = new UnreadSummaryTracker();
    const token = tracker.beginSnapshot();

    tracker.noteDmEvent();

    expect(
      tracker.commitSnapshot(
        token,
        { unreadDms: 1, pendingRequests: 4 },
        { unreadDms: 5, pendingRequests: 0 },
      ),
    ).toEqual({ unreadDms: 5, pendingRequests: 4 });
  });

  it('preserves a newer request event while reconciling the DM snapshot', () => {
    const tracker = new UnreadSummaryTracker();
    const token = tracker.beginSnapshot();

    tracker.noteRequestEvent();

    expect(
      tracker.commitSnapshot(
        token,
        { unreadDms: 6, pendingRequests: 1 },
        { unreadDms: 0, pendingRequests: 2 },
      ),
    ).toEqual({ unreadDms: 6, pendingRequests: 2 });
  });

  it('normalizes malformed snapshot and current counts', () => {
    const tracker = new UnreadSummaryTracker();
    const token = tracker.beginSnapshot();

    expect(
      tracker.commitSnapshot(
        token,
        { unreadDms: Number.NaN, pendingRequests: -2 },
        { unreadDms: 0, pendingRequests: 0 },
      ),
    ).toEqual({ unreadDms: 0, pendingRequests: 0 });
  });
});
