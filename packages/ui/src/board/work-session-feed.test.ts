import { describe, expect, it, vi } from "vitest";

import {
  createWorkSessionFeed,
  isLiveWakeKind,
  shouldTreatAsWorkSessionWake,
  type FeedTimerHost,
} from "./work-session-feed";

/**
 * The poll is jittered, so it re-arms one timeout per tick rather than
 * running on a fixed interval. `tick()` fires the pending timeout; `armed`
 * records every delay the feed scheduled.
 */
function fakeTimers(): FeedTimerHost & {
  tick(): void;
  active: number;
  armed: number[];
} {
  let pending: { fn: () => void; handle: number } | null = null;
  let nextHandle = 1;
  const armed: number[] = [];
  return {
    armed,
    setTimeout(fn: () => void, ms: number) {
      armed.push(ms);
      const handle = nextHandle++;
      pending = { fn, handle };
      return handle;
    },
    clearTimeout(handle: unknown) {
      if (pending?.handle === handle) pending = null;
    },
    tick() {
      const due = pending;
      pending = null;
      due?.fn();
    },
    get active() {
      return pending ? 1 : 0;
    },
  };
}

describe("work-session feed (US-008 AC3)", () => {
  it("polls until the first work-session wake, then goes wake-driven", async () => {
    const timers = fakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const feed = createWorkSessionFeed({ refresh, pollMs: 1000, timers });

    feed.start();
    expect(feed.mode).toBe("polling");
    expect(refresh).toHaveBeenCalledTimes(1); // immediate paint
    // Each tick re-arms only after its own refresh settles.
    timers.tick();
    await Promise.resolve();
    timers.tick();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(3);
    // Jittered, so the feed never arms the bare interval.
    expect(timers.armed.every((ms) => ms >= 800 && ms <= 1200)).toBe(true);

    // First observed wake (US-009 flip): stop polling, no code change needed.
    feed.wake();
    expect(feed.mode).toBe("wake-driven");
    expect(timers.active).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(4);

    // Ticks no longer refresh; wakes do.
    timers.tick();
    expect(refresh).toHaveBeenCalledTimes(4);
    feed.wake();
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  it("skips polling entirely when the capability probe reports wake support", () => {
    const timers = fakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const feed = createWorkSessionFeed({
      refresh,
      pollMs: 1000,
      timers,
      wakeSupported: () => true,
    });
    feed.start();
    expect(feed.mode).toBe("wake-driven");
    expect(timers.active).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the poll timer and ignores later wakes", () => {
    const timers = fakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const feed = createWorkSessionFeed({ refresh, pollMs: 1000, timers });
    feed.start();
    feed.stop();
    expect(timers.active).toBe(0);
    feed.wake();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(feed.mode).toBe("idle");
  });

  it("swallows refresh rejections (absent-safe until US-009 API exists)", async () => {
    const timers = fakeTimers();
    const refresh = vi.fn().mockRejectedValue(new Error("404"));
    const feed = createWorkSessionFeed({ refresh, pollMs: 1000, timers });
    feed.start();
    timers.tick();
    await Promise.resolve();
    expect(feed.mode).toBe("polling");
  });

  it("treats live kind as a wake signal and flips to wake-driven", () => {
    expect(isLiveWakeKind("live")).toBe(true);
    expect(isLiveWakeKind("work-session")).toBe(true);
    expect(isLiveWakeKind("presence")).toBe(false);
    expect(shouldTreatAsWorkSessionWake("live")).toBe(true);
    expect(shouldTreatAsWorkSessionWake("hq/prs_bob/work-session/sess-1")).toBe(
      true,
    );
    expect(
      shouldTreatAsWorkSessionWake("hq/cmp_acme/thread/proj/work-session-notes"),
    ).toBe(false);

    const timers = fakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const feed = createWorkSessionFeed({ refresh, pollMs: 1000, timers });
    feed.start();
    expect(feed.mode).toBe("polling");

    if (shouldTreatAsWorkSessionWake("live")) feed.wake();
    expect(feed.mode).toBe("wake-driven");
    expect(timers.active).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
