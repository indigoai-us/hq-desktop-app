import { describe, expect, it, vi } from "vitest";

import type { AdapterResult, StorageApi, StorageStatus } from "@hq/platform";
import { cachedAgeCopy, joinStatus, statusInFlight } from "./storage-load.js";

const STATUS = { local: { available: false, tranches: [] }, cloud: [] } as unknown as StorageStatus;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function apiWith(status: () => Promise<AdapterResult<StorageStatus>>): StorageApi {
  return { status } as unknown as StorageApi;
}

describe("joinStatus", () => {
  it("joins a read already running instead of starting another", async () => {
    const gate = deferred<AdapterResult<StorageStatus>>();
    const status = vi.fn(() => gate.promise);
    const api = apiWith(status);
    const a = joinStatus(api);
    const b = joinStatus(api);
    const c = joinStatus(api);
    expect(statusInFlight(api)).toBe(true);
    gate.resolve({ ok: true, value: STATUS });
    await expect(Promise.all([a, b, c])).resolves.toHaveLength(3);
    expect(status).toHaveBeenCalledTimes(1);
    expect(statusInFlight(api)).toBe(false);
  });

  it("reads again once the earlier read is over", async () => {
    const status = vi.fn(async () => ({ ok: true as const, value: STATUS }));
    const api = apiWith(status);
    await joinStatus(api);
    await joinStatus(api);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("after a delete or move, waits for the stale read and reads once more, never overlapping", async () => {
    let live = 0;
    let peak = 0;
    const gates = [deferred<void>(), deferred<void>()];
    let call = 0;
    const status = vi.fn(async () => {
      const mine = gates[call++];
      live++;
      peak = Math.max(peak, live);
      await mine.promise;
      live--;
      return { ok: true as const, value: STATUS };
    });
    const api = apiWith(status);
    const stale = joinStatus(api);
    const fresh = joinStatus(api, { afterWrite: true });
    // A later plain request joins the fresh read.
    const joined = joinStatus(api);
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(status).toHaveBeenCalledTimes(1);
    gates[0].resolve();
    await stale;
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    gates[1].resolve();
    await fresh;
    await joined;
    expect(status).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  it("turns a thrown host error into a failure result and frees the slot", async () => {
    const api = apiWith(async () => {
      throw new Error("ipc down");
    });
    await expect(joinStatus(api)).resolves.toMatchObject({ ok: false, message: "ipc down" });
    expect(statusInFlight(api)).toBe(false);
  });
});

describe("cachedAgeCopy", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  it.each([
    ["2026-10-11T11:59:40Z", "Figures from just now."],
    ["2026-10-11T11:40:00Z", "Figures from 20 min ago."],
    ["2026-10-11T09:00:00Z", "Figures from 3 h ago."],
    ["2026-10-10T11:00:00Z", "Figures from 1 day ago."],
    ["2026-10-08T11:00:00Z", "Figures from 3 days ago."],
  ])("%s → %s", (at, copy) => {
    expect(cachedAgeCopy(at, now)).toBe(copy);
  });

  it("is null without a usable time", () => {
    expect(cachedAgeCopy(null, now)).toBeNull();
    expect(cachedAgeCopy("not a date", now)).toBeNull();
  });
});
