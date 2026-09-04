import { describe, expect, it, vi } from "vitest";

import {
  createWorkSessionFeed,
  isLiveWakeKind,
  shouldTreatAsWorkSessionWake,
  type FeedTimerHost,
} from "./work-session-feed";

function fakeTimers(): FeedTimerHost & { tick(): void; active: number } {
  let fns: Array<() => void> = [];
  return {
    setInterval(fn: () => void) {
      fns.push(fn);
      return fn;
    },
    clearInterval(handle: unknown) {
      fns = fns.filter((f) => f !== handle);
    },
    tick() {
      for (const f of [...fns]) f();
    },
    get active() {
      return fns.length;
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
    timers.tick();
    timers.tick();
    expect(refresh).toHaveBeenCalledTimes(3);

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
