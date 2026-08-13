import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatedPoller, documentIsHidden } from './visibility-poller';

describe('createGatedPoller (perf: visibility + subscriber gating)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not tick before any subscriber acquires', () => {
    const tick = vi.fn();
    createGatedPoller({ intervalMs: 30_000, tick, isHidden: () => false });
    vi.advanceTimersByTime(120_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('ticks immediately on first acquire, then on the interval', () => {
    const tick = vi.fn();
    const poller = createGatedPoller({
      intervalMs: 30_000,
      tick,
      isHidden: () => false,
    });
    poller.acquire();
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(29_999);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it('stops the interval when the last subscriber releases', () => {
    const tick = vi.fn();
    const poller = createGatedPoller({
      intervalMs: 30_000,
      tick,
      isHidden: () => false,
    });
    const releaseA = poller.acquire();
    const releaseB = poller.acquire();
    expect(poller.subscriberCount()).toBe(2);
    // Second acquire must not double-tick or double-schedule.
    expect(tick).toHaveBeenCalledTimes(1);
    releaseA();
    expect(poller.isRunning()).toBe(true);
    releaseB();
    expect(poller.isRunning()).toBe(false);
    vi.advanceTimersByTime(300_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent (double release cannot underflow the refcount)', () => {
    const tick = vi.fn();
    const poller = createGatedPoller({
      intervalMs: 30_000,
      tick,
      isHidden: () => false,
    });
    const releaseA = poller.acquire();
    const releaseB = poller.acquire();
    releaseA();
    releaseA();
    expect(poller.isRunning()).toBe(true);
    expect(poller.subscriberCount()).toBe(1);
    releaseB();
    expect(poller.isRunning()).toBe(false);
  });

  it('skips interval ticks while hidden and resumes when visible', () => {
    const tick = vi.fn();
    let hidden = false;
    const poller = createGatedPoller({
      intervalMs: 30_000,
      tick,
      isHidden: () => hidden,
    });
    poller.acquire();
    expect(tick).toHaveBeenCalledTimes(1);
    hidden = true;
    vi.advanceTimersByTime(120_000);
    expect(tick).toHaveBeenCalledTimes(1); // all hidden ticks skipped
    hidden = false;
    vi.advanceTimersByTime(30_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('re-acquiring after full release restarts with an immediate tick', () => {
    const tick = vi.fn();
    const poller = createGatedPoller({
      intervalMs: 30_000,
      tick,
      isHidden: () => false,
    });
    const release = poller.acquire();
    release();
    poller.acquire();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(poller.isRunning()).toBe(true);
  });

  it('documentIsHidden is false when no document exists', () => {
    // Node test environment for this file has no DOM document.
    expect(documentIsHidden()).toBe(false);
  });
});
