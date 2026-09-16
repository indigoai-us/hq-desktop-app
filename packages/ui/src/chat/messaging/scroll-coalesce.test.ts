import { describe, expect, it, vi } from "vitest";
import { coalesceScroll } from "./scroll-coalesce";

/** Hand-driven scheduler so frames advance only when the test says so. */
function fakeScheduler() {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    scheduler: {
      request: (cb: () => void) => {
        const h = next++;
        queued.set(h, cb);
        return h;
      },
      cancel: (h: number) => void queued.delete(h),
    },
    flush() {
      const due = [...queued.values()];
      queued.clear();
      due.forEach((cb) => cb());
    },
    get pending() {
      return queued.size;
    },
  };
}

describe("coalesceScroll", () => {
  it("runs the first event synchronously, so a scroll's effect is observable without waiting for a frame", () => {
    const run = vi.fn();
    const f = fakeScheduler();
    const { onScroll } = coalesceScroll(run, f.scheduler);

    onScroll();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst to two runs per frame instead of one per event", () => {
    const run = vi.fn();
    const f = fakeScheduler();
    const { onScroll } = coalesceScroll(run, f.scheduler);

    // A momentum flick: a dozen events inside one frame.
    for (let i = 0; i < 12; i++) onScroll();
    expect(run).toHaveBeenCalledTimes(1); // leading only, so far
    f.flush();
    expect(run).toHaveBeenCalledTimes(2); // plus one trailing
  });

  it("observes the resting position a burst ends on, not just where it started", () => {
    let position = 0;
    const seen: number[] = [];
    const f = fakeScheduler();
    const { onScroll } = coalesceScroll(() => seen.push(position), f.scheduler);

    onScroll(); // leading, at 0
    position = 40;
    onScroll();
    position = 120; // where the flick actually comes to rest
    onScroll();
    f.flush();

    expect(seen).toEqual([0, 120]);
  });

  it("does not run a trailing pass when the burst was a single event", () => {
    const run = vi.fn();
    const f = fakeScheduler();
    const { onScroll } = coalesceScroll(run, f.scheduler);

    onScroll();
    f.flush();
    // One event moved the scroller once; re-reading the same position is waste.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("re-arms for the next burst", () => {
    const run = vi.fn();
    const f = fakeScheduler();
    const { onScroll } = coalesceScroll(run, f.scheduler);

    onScroll();
    f.flush();
    onScroll();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending trailing run, so teardown cannot run against a dead component", () => {
    const run = vi.fn();
    const f = fakeScheduler();
    const { onScroll, cancel } = coalesceScroll(run, f.scheduler);

    onScroll();
    onScroll(); // arms a trailing pass
    expect(run).toHaveBeenCalledTimes(1);
    cancel();
    f.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel clears the suppressed flag, so a later burst cannot inherit a stale trailing run", () => {
    const run = vi.fn();
    const f = fakeScheduler();
    const { onScroll, cancel } = coalesceScroll(run, f.scheduler);

    onScroll();
    onScroll();
    cancel();
    onScroll(); // new burst, single event
    f.flush();
    expect(run).toHaveBeenCalledTimes(2); // two leadings, no phantom trailing
  });
});
