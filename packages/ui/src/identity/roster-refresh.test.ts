import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRosterRefresher,
  ROSTER_REFRESH_EVENTS,
  ROSTER_RETRY_DELAYS_MS,
  subscribeRosterRefreshEvents,
} from "./roster-refresh.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRosterRefresher", () => {
  it("retries a failed load on the bounded backoff and stops once it applies", async () => {
    const results = [false, false, true];
    const load = vi.fn(async () => results.shift() ?? true);
    const refresher = createRosterRefresher({ load, delaysMs: [10, 20, 40] });

    await expect(refresher.refresh()).resolves.toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(refresher.retryPending).toBe(true);

    await vi.advanceTimersByTimeAsync(10);
    expect(load).toHaveBeenCalledTimes(2);
    expect(refresher.retryPending).toBe(true);

    await vi.advanceTimersByTimeAsync(20);
    expect(load).toHaveBeenCalledTimes(3);
    expect(refresher.retryPending).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retry budget instead of retrying forever", async () => {
    const load = vi.fn(async () => {
      throw new Error("vault unreachable");
    });
    const refresher = createRosterRefresher({ load, delaysMs: [5, 5] });
    await refresher.refresh();
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(refresher.retryPending).toBe(false);
  });

  it("an explicit refresh supersedes the armed retry and resets the backoff on success", async () => {
    const results = [false, true, false];
    const load = vi.fn(async () => results.shift() ?? true);
    const refresher = createRosterRefresher({ load, delaysMs: [100, 200] });
    await refresher.refresh();
    expect(refresher.retryPending).toBe(true);

    // The native event fires before the 100ms timer: it IS the retry.
    await expect(refresher.refresh()).resolves.toBe(true);
    expect(refresher.retryPending).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);

    // Backoff restarted from the first delay after a success.
    await refresher.refresh();
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(99);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("coalesces refreshes requested while a fetch is in flight into one more pass", async () => {
    let release: (value: boolean) => void = () => {};
    const load = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(true);
    const refresher = createRosterRefresher({ load, delaysMs: [] });
    const first = refresher.refresh();
    const second = refresher.refresh();
    const third = refresher.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    release(true);
    await Promise.all([first, second, third]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending retry and dispose ignores late results", async () => {
    const load = vi.fn(async () => false);
    const refresher = createRosterRefresher({ load, delaysMs: [10] });
    await refresher.refresh();
    expect(refresher.retryPending).toBe(true);
    refresher.cancel();
    expect(refresher.retryPending).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(load).toHaveBeenCalledTimes(1);

    await refresher.refresh();
    expect(refresher.retryPending).toBe(true);
    refresher.dispose();
    expect(refresher.retryPending).toBe(false);
    await expect(refresher.refresh()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("cancel abandons an in-flight load so the next refresh starts at once", async () => {
    let releaseStale: (value: boolean) => void = () => {};
    const load = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseStale = resolve;
          }),
      )
      .mockResolvedValue(true);
    const refresher = createRosterRefresher({ load, delaysMs: [10] });
    const stale = refresher.refresh();
    expect(load).toHaveBeenCalledTimes(1);

    // Tenant boundary: the old tenant's fetch is still hanging.
    refresher.cancel();
    await expect(refresher.refresh()).resolves.toBe(true);
    expect(load).toHaveBeenCalledTimes(2);

    // The stale fetch failing later must not arm a retry for the new tenant.
    releaseStale(false);
    await expect(stale).resolves.toBe(true);
    expect(refresher.retryPending).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ships a bounded production backoff", () => {
    expect(ROSTER_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    expect(ROSTER_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(5);
    expect(Math.max(...ROSTER_RETRY_DELAYS_MS)).toBeLessThanOrEqual(30_000);
  });
});

describe("subscribeRosterRefreshEvents", () => {
  it("listens to both sync events and tears down every registration", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const unlistens = new Map<string, ReturnType<typeof vi.fn>>();
    const listen = vi.fn(
      async (event: string, handler: (event: { payload: unknown }) => void) => {
        handlers.set(event, handler);
        const unlisten = vi.fn();
        unlistens.set(event, unlisten);
        return unlisten;
      },
    );
    const onRefresh = vi.fn();
    const teardown = subscribeRosterRefreshEvents(listen, onRefresh);
    await Promise.resolve();
    expect([...handlers.keys()].sort()).toEqual([...ROSTER_REFRESH_EVENTS].sort());

    handlers.get("sync:company-provisioned")?.({
      payload: { companyUid: "cmp_acme", companySlug: "acme" },
    });
    handlers.get("sync:all-complete")?.({ payload: { errors: [] } });
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenNthCalledWith(1, "sync:company-provisioned");
    expect(onRefresh).toHaveBeenNthCalledWith(2, "sync:all-complete");

    teardown();
    await Promise.resolve();
    await Promise.resolve();
    handlers.get("sync:all-complete")?.({ payload: { errors: [] } });
    expect(onRefresh).toHaveBeenCalledTimes(2);
    for (const unlisten of unlistens.values()) expect(unlisten).toHaveBeenCalledOnce();
  });

  it("survives a listen seam that rejects", async () => {
    const listen = vi.fn(async () => {
      throw new Error("Tauri event listener is unavailable");
    });
    const teardown = subscribeRosterRefreshEvents(listen, vi.fn());
    await Promise.resolve();
    expect(() => teardown()).not.toThrow();
  });
});
