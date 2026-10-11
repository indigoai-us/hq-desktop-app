import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisibleInterval, type VisibilitySource } from "./visible-interval.js";

function fakeVisibility(hidden = false) {
  const listeners = new Set<() => void>();
  const source: { hidden: boolean; set(hidden: boolean): void; listeners: Set<() => void> } & Omit<
    VisibilitySource,
    "hidden"
  > = {
    hidden,
    listeners,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    set(next) {
      this.hidden = next;
      for (const fn of listeners) fn();
    },
  };
  return source;
}

describe("startVisibleInterval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks on its period while visible", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval(tick, 1000, { visibility: fakeVisibility() });
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not tick while hidden", () => {
    const tick = vi.fn();
    const vis = fakeVisibility();
    const stop = startVisibleInterval(tick, 1000, { visibility: vis });
    vis.set(true);
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it("refreshes at once when shown, then resumes the period", () => {
    const tick = vi.fn();
    const vis = fakeVisibility(true);
    const stop = startVisibleInterval(tick, 1000, { visibility: vis });
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
    vis.set(false);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores a visible event when already running", () => {
    const tick = vi.fn();
    const vis = fakeVisibility();
    const stop = startVisibleInterval(tick, 1000, { visibility: vis });
    vis.set(false);
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it("stop clears the timer and the listener", () => {
    const tick = vi.fn();
    const vis = fakeVisibility();
    const stop = startVisibleInterval(tick, 1000, { visibility: vis });
    stop();
    expect(vis.listeners.size).toBe(0);
    vis.set(true);
    vis.set(false);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("runs as a plain interval when there is no document", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval(tick, 1000, { visibility: null });
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });
});
