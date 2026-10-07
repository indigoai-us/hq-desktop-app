import { afterEach, describe, expect, it, vi } from "vitest";
import { RELATIVE_TIME_TICK_MS, startNowTicker } from "./now-ticker.js";

describe("startNowTicker (QA-069)", () => {
  afterEach(() => vi.useRealTimers());

  it("ticks every 30 s and stops on cleanup", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T18:00:00Z"));
    const seen: number[] = [];
    const stop = startNowTicker((now) => seen.push(now));
    vi.advanceTimersByTime(RELATIVE_TIME_TICK_MS * 2);
    expect(seen).toEqual([
      Date.parse("2026-10-02T18:00:30Z"),
      Date.parse("2026-10-02T18:01:00Z"),
    ]);
    stop();
    vi.advanceTimersByTime(RELATIVE_TIME_TICK_MS * 2);
    expect(seen).toHaveLength(2);
  });
});
