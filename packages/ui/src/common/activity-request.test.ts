import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_REQUEST_TIMEOUT_MS,
  ActivityRequestTimeoutError,
  withActivityRequestDeadline,
} from "./activity-request";

afterEach(() => {
  vi.useRealTimers();
});

describe("withActivityRequestDeadline", () => {
  it("passes through a successful response and clears its deadline", async () => {
    vi.useFakeTimers();
    const result = await withActivityRequestDeadline(
      Promise.resolve({ files: 4 }),
    );
    expect(result).toEqual({ files: 4 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes through a backend rejection without waiting for the deadline", async () => {
    vi.useFakeTimers();
    await expect(
      withActivityRequestDeadline(
        Promise.reject(new Error("backend unavailable")),
      ),
    ).rejects.toThrow("backend unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a never-settling request at the deadline", async () => {
    vi.useFakeTimers();
    const request = withActivityRequestDeadline(new Promise(() => undefined));
    const rejection = expect(request).rejects.toBeInstanceOf(
      ActivityRequestTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(ACTIVITY_REQUEST_TIMEOUT_MS);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
