import { describe, expect, it, vi } from "vitest";

import {
  MIN_POLL_INTERVAL_MS,
  POLL_JITTER_RATIO,
  RETRY_CAP_MS,
  createThrottleSignal,
  fullJitterBackoffMs,
  isRetryableStatus,
  jitterIntervalMs,
  nextPollDelayMs,
  parseRetryAfterMs,
  retryThrottled,
  startJitteredPoll,
} from "./request-policy.js";

/** Collects the delays a test slept, so assertions read in milliseconds. */
function recordingSleep(): { slept: number[]; sleep: (ms: number) => Promise<void> } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfterMs("2", 0)).toBe(2_000);
    expect(parseRetryAfterMs(" 30 ", 0)).toBe(30_000);
  });

  it("reads an HTTP-date and never goes negative", () => {
    const raw = "Wed, 21 Oct 2015 07:28:00 GMT";
    const at = Date.parse(raw);
    expect(parseRetryAfterMs(raw, at - 5_000)).toBe(5_000);
    expect(parseRetryAfterMs(raw, at + 5_000)).toBe(0);
  });

  it("is null when absent or unparseable", () => {
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs(undefined, 0)).toBeNull();
    expect(parseRetryAfterMs("", 0)).toBeNull();
    expect(parseRetryAfterMs("soon", 0)).toBeNull();
  });
});

describe("isRetryableStatus", () => {
  it("covers 429 and 503 only", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    for (const status of [200, 204, 400, 401, 404, 500, 502, 504]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
    expect(isRetryableStatus(null)).toBe(false);
  });
});

describe("retryThrottled", () => {
  // (a) The regression test for R2. Reverting the policy makes the second
  // attempt never happen and the slept delay disappear.
  it("a 429 with Retry-After: 2 waits at least two seconds, then succeeds", async () => {
    const { slept, sleep } = recordingSleep();
    const responses = [
      { status: 429, retryAfter: "2", body: null },
      { status: 200, retryAfter: null, body: { ok: true } },
    ];
    const attempt = vi.fn(async (index: number) => responses[index]!);

    const result = await retryThrottled(
      attempt,
      (r) => ({ status: r.status, retryAfter: r.retryAfter }),
      { sleep, throttle: null },
    );

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(2_000);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
  });

  it("honours an HTTP-date Retry-After the same way", async () => {
    const { slept, sleep } = recordingSleep();
    const nowMs = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    const at = new Date(nowMs + 3_000).toUTCString();
    const responses = [
      { status: 503, retryAfter: at },
      { status: 200, retryAfter: null },
    ];

    await retryThrottled(
      async (index: number) => responses[index]!,
      (r) => ({ status: r.status, retryAfter: r.retryAfter }),
      { sleep, now: () => nowMs, throttle: null },
    );

    expect(slept[0]).toBeGreaterThanOrEqual(3_000);
  });

  // (b) No header ⇒ jittered exponential backoff, inside the documented bounds.
  it("a 429 without Retry-After backs off with jitter inside base/cap bounds", async () => {
    const { slept, sleep } = recordingSleep();
    const draws = [0.9, 0.5, 0.25];
    let draw = 0;
    const attempt = vi.fn(async () => ({ status: 429, retryAfter: null }));

    const result = await retryThrottled(
      attempt,
      (r) => ({ status: r.status, retryAfter: r.retryAfter }),
      {
        sleep,
        throttle: null,
        random: () => draws[draw++ % draws.length]!,
      },
    );

    // 4 attempts in total ⇒ 3 waits.
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(slept).toHaveLength(3);
    // Full jitter: delay ∈ [0, min(cap, base * 2^n)). Never immediate, because
    // each draw here is well above zero.
    expect(slept[0]).toBeGreaterThan(0);
    expect(slept[0]).toBeLessThan(1_000);
    expect(slept[1]).toBeLessThan(2_000);
    expect(slept[2]).toBeLessThan(4_000);
    for (const ms of slept) expect(ms).toBeLessThanOrEqual(RETRY_CAP_MS);
    // The caller still gets the throttled result — never a thrown crash.
    expect(result.status).toBe(429);
  });

  it("does not retry a status outside the policy", async () => {
    const { slept, sleep } = recordingSleep();
    const attempt = vi.fn(async () => ({ status: 500, retryAfter: null }));

    const result = await retryThrottled(
      attempt,
      (r) => ({ status: r.status, retryAfter: r.retryAfter }),
      { sleep, throttle: null },
    );

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(result.status).toBe(500);
  });

  it("refuses to sleep off a Retry-After beyond the cap", async () => {
    const { slept, sleep } = recordingSleep();
    const throttle = createThrottleSignal();
    const attempt = vi.fn(async () => ({ status: 429, retryAfter: "3600" }));

    const result = await retryThrottled(
      attempt,
      (r) => ({ status: r.status, retryAfter: r.retryAfter }),
      { sleep, throttle },
    );

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(result.status).toBe(429);
    // The app does not hang, but the pollers still honour the full hour.
    expect(throttle.waitMs()).toBeGreaterThan(3_000_000);
  });

  it("marks the throttle signal so background polls back off", async () => {
    const throttle = createThrottleSignal();
    const { sleep } = recordingSleep();

    await retryThrottled(
      async () => ({ status: 429, retryAfter: "5" }),
      (r) => ({ status: r.status, retryAfter: r.retryAfter }),
      { sleep, throttle, maxAttempts: 2 },
    );

    expect(throttle.waitMs()).toBeGreaterThan(4_000);
  });

  it("clears the throttle once the server answers cleanly", async () => {
    const throttle = createThrottleSignal();
    throttle.markThrottled(10_000);

    await retryThrottled(
      async () => ({ status: 200, retryAfter: null }),
      (r) => ({ status: r.status, retryAfter: r.retryAfter }),
      { throttle },
    );

    expect(throttle.waitMs()).toBe(0);
  });
});

describe("fullJitterBackoffMs", () => {
  it("stays inside min(cap, base * 2^attempt)", () => {
    for (const attempt of [0, 1, 2, 3, 10, 40]) {
      const ceiling = Math.min(RETRY_CAP_MS, 1_000 * 2 ** Math.min(attempt, 30));
      expect(fullJitterBackoffMs(attempt, { random: () => 0 })).toBe(0);
      expect(fullJitterBackoffMs(attempt, { random: () => 0.999_999 })).toBeLessThan(
        ceiling,
      );
    }
  });
});

// (c) Poll intervals are jittered within ±20% and never below a floor.
describe("jitterIntervalMs", () => {
  it("spreads a fixed interval across ±20% of nominal", () => {
    for (const intervalMs of [8_000, 15_000, 30_000, 120_000, 180_000]) {
      const low = jitterIntervalMs(intervalMs, { random: () => 0 });
      const high = jitterIntervalMs(intervalMs, { random: () => 0.999_999 });
      expect(low).toBe(Math.round(intervalMs * (1 - POLL_JITTER_RATIO)));
      expect(high).toBeGreaterThan(Math.round(intervalMs * (1 + POLL_JITTER_RATIO)) - 2);
      expect(high).toBeLessThanOrEqual(Math.round(intervalMs * (1 + POLL_JITTER_RATIO)));
      for (let i = 0; i < 200; i += 1) {
        const draw = jitterIntervalMs(intervalMs);
        expect(draw).toBeGreaterThanOrEqual(low);
        expect(draw).toBeLessThanOrEqual(high);
      }
    }
  });

  it("is actually spread, not a constant", () => {
    const draws = new Set(
      Array.from({ length: 200 }, () => jitterIntervalMs(30_000)),
    );
    expect(draws.size).toBeGreaterThan(50);
  });

  it("never schedules below the floor", () => {
    expect(jitterIntervalMs(100, { random: () => 0 })).toBe(MIN_POLL_INTERVAL_MS);
    expect(jitterIntervalMs(0, { random: () => 0 })).toBe(MIN_POLL_INTERVAL_MS);
    expect(jitterIntervalMs(30_000, { floorMs: 29_000, random: () => 0 })).toBe(29_000);
  });
});

// (d) A throttled poll delays its next tick.
describe("nextPollDelayMs", () => {
  it("waits out the throttle instead of firing on schedule", () => {
    let nowMs = 0;
    const throttle = createThrottleSignal(() => nowMs);
    expect(nextPollDelayMs(15_000, { throttle, random: () => 0.5 })).toBe(15_000);

    throttle.markThrottled(45_000);
    expect(nextPollDelayMs(15_000, { throttle, random: () => 0.5 })).toBe(45_000);

    nowMs += 44_000;
    expect(nextPollDelayMs(15_000, { throttle, random: () => 0.5 })).toBe(15_000);
  });

  it("keeps the longest outstanding pushback", () => {
    const throttle = createThrottleSignal(() => 0);
    throttle.markThrottled(30_000);
    throttle.markThrottled(5_000);
    expect(throttle.waitMs()).toBe(30_000);
  });
});

describe("startJitteredPoll", () => {
  /** Minimal timer double: `flush()` runs the one pending timeout. */
  function fakeTimers() {
    let pending: { fn: () => void; ms: number } | null = null;
    let nextHandle = 1;
    const armed: number[] = [];
    return {
      armed,
      pendingMs: () => pending?.ms ?? null,
      flush: () => {
        const due = pending;
        pending = null;
        due?.fn();
      },
      setTimeoutFn: (fn: () => void, ms: number) => {
        armed.push(ms);
        pending = { fn, ms };
        return nextHandle++;
      },
      clearTimeoutFn: () => {
        pending = null;
      },
    };
  }

  it("arms every tick at a jittered delay, never the bare interval", async () => {
    const timers = fakeTimers();
    const draws = [0, 0.5, 0.999_999];
    let draw = 0;
    const stop = startJitteredPoll({
      intervalMs: 30_000,
      tick: () => {},
      throttle: null,
      random: () => draws[draw++ % draws.length]!,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    timers.flush();
    await Promise.resolve();
    timers.flush();
    await Promise.resolve();
    stop();

    expect(timers.armed).toHaveLength(3);
    expect(timers.armed[0]).toBe(24_000);
    expect(timers.armed[1]).toBe(30_000);
    expect(timers.armed[2]).toBe(36_000);
  });

  it("delays its next tick after the request was throttled", async () => {
    const timers = fakeTimers();
    let nowMs = 0;
    const throttle = createThrottleSignal(() => nowMs);
    let ticks = 0;
    const stop = startJitteredPoll({
      intervalMs: 15_000,
      // The tick's own request is what gets throttled.
      tick: () => {
        ticks += 1;
        if (ticks === 1) throttle.markThrottled(60_000);
      },
      throttle,
      random: () => 0.5,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      immediate: true,
    });

    await Promise.resolve();
    expect(ticks).toBe(1);
    expect(timers.pendingMs()).toBe(60_000);

    nowMs += 60_000;
    timers.flush();
    await Promise.resolve();
    expect(ticks).toBe(2);
    expect(timers.pendingMs()).toBe(15_000);
    stop();
  });

  it("keeps polling after a tick throws", async () => {
    const timers = fakeTimers();
    let ticks = 0;
    const stop = startJitteredPoll({
      intervalMs: 15_000,
      tick: () => {
        ticks += 1;
        throw new Error("boom");
      },
      throttle: null,
      random: () => 0.5,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      immediate: true,
    });

    await Promise.resolve();
    expect(ticks).toBe(1);
    expect(timers.pendingMs()).toBe(15_000);
    stop();
  });

  it("stops firing once stopped", async () => {
    const timers = fakeTimers();
    let ticks = 0;
    const stop = startJitteredPoll({
      intervalMs: 15_000,
      tick: () => {
        ticks += 1;
      },
      throttle: null,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    stop();
    timers.flush();
    await Promise.resolve();
    expect(ticks).toBe(0);
  });
});
