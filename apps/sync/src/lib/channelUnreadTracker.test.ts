import { describe, expect, it } from 'vitest';
import { ChannelUnreadTracker } from './channelUnreadTracker';

describe('ChannelUnreadTracker', () => {
  it('merges realtime changes into an in-flight initial snapshot so the aggregate is complete', () => {
    const tracker = new ChannelUnreadTracker();
    const token = tracker.beginSnapshot();

    expect(tracker.applyEvent('ch-release', 4)).toBe(4);
    expect(
      tracker.commitSnapshot(token, [
        { channelId: 'ch-release', unread: 1 },
        { channelId: 'ch-general', unread: 3 },
      ]),
    ).toBe(7);
    expect(tracker.get('ch-release')).toBe(4);
    expect(tracker.get('ch-general')).toBe(3);
    expect(tracker.total()).toBe(7);
    expect(tracker.hasCompleteSnapshot()).toBe(true);
  });

  it('lets the newest concurrent snapshot replace the prior channel set', () => {
    const tracker = new ChannelUnreadTracker();
    const older = tracker.beginSnapshot();
    const newer = tracker.beginSnapshot();

    expect(
      tracker.commitSnapshot(older, [{ channelId: 'ch-old', unread: 9 }]),
    ).toBeNull();
    expect(
      tracker.commitSnapshot(newer, [
        { channelId: 'ch-one', unread: 2 },
        { channelId: 'ch-two', unread: 3 },
      ]),
    ).toBe(5);
    expect(tracker.get('ch-old')).toBe(0);
    expect(tracker.total()).toBe(5);
  });

  it('normalizes missing, negative, and non-finite counts', () => {
    const tracker = new ChannelUnreadTracker();
    const token = tracker.beginSnapshot();

    expect(
      tracker.commitSnapshot(token, [
        { channelId: 'missing' },
        { channelId: 'negative', unread: -3 },
        { channelId: 'invalid', unread: Number.NaN },
        { channelId: 'valid', unread: 2.8 },
      ]),
    ).toBe(2);
    expect(tracker.get('missing')).toBe(0);
    expect(tracker.get('negative')).toBe(0);
    expect(tracker.get('invalid')).toBe(0);
    expect(tracker.get('valid')).toBe(2);
  });

  it('reports an incomplete aggregate until a snapshot succeeds', () => {
    const tracker = new ChannelUnreadTracker();

    tracker.applyEvent('ch-one', 2);

    expect(tracker.total()).toBe(2);
    expect(tracker.hasCompleteSnapshot()).toBe(false);
  });

  it('abandons failed snapshot bookkeeping without marking the aggregate complete', () => {
    const tracker = new ChannelUnreadTracker();
    const token = tracker.beginSnapshot();

    tracker.abandonSnapshot(token);

    expect(
      tracker.commitSnapshot(token, [{ channelId: 'late', unread: 9 }]),
    ).toBeNull();
    expect(tracker.hasCompleteSnapshot()).toBe(false);
  });

  it('clears every count and invalidates in-flight snapshots on sign-out', () => {
    const tracker = new ChannelUnreadTracker();
    const staleSnapshot = tracker.beginSnapshot();
    tracker.applyEvent('ch-one', 7);

    tracker.reset();

    expect(tracker.total()).toBe(0);
    expect(tracker.get('ch-one')).toBe(0);
    expect(tracker.hasCompleteSnapshot()).toBe(false);
    expect(
      tracker.commitSnapshot(staleSnapshot, [{ channelId: 'ch-one', unread: 7 }]),
    ).toBeNull();
  });
});
