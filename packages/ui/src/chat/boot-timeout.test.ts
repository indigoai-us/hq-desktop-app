import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BootTimeoutError,
  DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS,
  raceTimeout,
} from "./boot-timeout.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("raceTimeout", () => {
  it("returns the settled value when the request finishes in time", async () => {
    await expect(raceTimeout(Promise.resolve("ok"), 50, "contacts")).resolves.toBe(
      "ok",
    );
  });

  it("propagates a 404/failure instead of hanging", async () => {
    await expect(
      raceTimeout(
        Promise.reject(new Error("[http-404] GET /v1/notify/channels failed")),
        50,
        "channel-directory",
      ),
    ).rejects.toThrow("[http-404]");
  });

  it("rejects a hung request so first paint can continue", async () => {
    vi.useFakeTimers();
    const pending = raceTimeout(new Promise(() => {}), 40, "channel-directory");
    const expectation = expect(pending).rejects.toBeInstanceOf(BootTimeoutError);
    await vi.advanceTimersByTimeAsync(40);
    await expectation;
  });

  it("disables the timer when ms is not positive", async () => {
    await expect(raceTimeout(Promise.resolve(1), 0, "x")).resolves.toBe(1);
  });
});

describe("DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS", () => {
  it("is a finite first-paint bound, not unlimited", () => {
    expect(DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
