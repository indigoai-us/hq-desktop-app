import { describe, expect, it, vi } from "vitest";

import { clearAccountCaches, registerAccountCache } from "./account-caches.js";
import { createResourceCache } from "./resource-cache.svelte.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createResourceCache", () => {
  it("serves a fresh entry from memory and reloads after the TTL", async () => {
    let now = 0;
    const cache = createResourceCache({ ttlMs: 1_000, now: () => now });
    const loader = vi.fn(async () => ({ n: loader.mock.calls.length }));

    expect(await cache.load("a", loader)).toEqual({ n: 1 });
    now = 999;
    expect(await cache.load("a", loader)).toEqual({ n: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    now = 1_000;
    expect(await cache.load("a", loader)).toEqual({ n: 2 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent loads of one key into one request", async () => {
    const cache = createResourceCache();
    const gate = deferred<string>();
    const loader = vi.fn(() => gate.promise);

    const a = cache.load("k", loader);
    const b = cache.load("k", loader);
    gate.resolve("v");
    expect(await a).toBe("v");
    expect(await b).toBe("v");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used key past maxEntries", async () => {
    const cache = createResourceCache({ maxEntries: 2 });
    await cache.load("a", async () => "A");
    await cache.load("b", async () => "B");
    expect(cache.read("a")).toBe("A"); // touch a; b is now oldest
    await cache.load("c", async () => "C");

    expect(cache.size).toBe(2);
    expect(cache.inspect("a").data).toBe("A");
    expect(cache.read("c")).toBe("C");
    // b was evicted, so reading it creates an empty entry.
    expect(cache.read("b")).toBeNull();
  });

  it("never evicts an entry whose request is still in flight", async () => {
    const cache = createResourceCache({ maxEntries: 1 });
    const gate = deferred<string>();
    const pending = cache.load("slow", () => gate.promise);
    await cache.load("fast", async () => "F");
    gate.resolve("S");
    expect(await pending).toBe("S");
    expect(cache.inspect("slow").data).toBe("S");
  });

  it("stale-while-revalidate paints the stale copy and refreshes in the background", async () => {
    let now = 0;
    const cache = createResourceCache({ ttlMs: 100, now: () => now, staleWhileRevalidate: true });
    await cache.load("k", async () => "old");
    now = 500;

    const gate = deferred<string>();
    const loader = vi.fn(() => gate.promise);
    expect(await cache.load("k", loader)).toBe("old");
    // A second caller during the refresh also gets the stale copy, no new request.
    expect(await cache.load("k", loader)).toBe("old");
    expect(loader).toHaveBeenCalledTimes(1);

    const before = cache.revision;
    gate.resolve("new");
    await gate.promise;
    await Promise.resolve();
    expect(cache.read("k")).toBe("new");
    expect(cache.revision).toBeGreaterThan(before);
  });

  it("stale-while-revalidate keeps the stale copy when the refresh fails", async () => {
    let now = 0;
    const cache = createResourceCache({ ttlMs: 100, now: () => now, staleWhileRevalidate: true });
    await cache.load("k", async () => "old");
    now = 500;
    const failure = new Error("offline");
    expect(await cache.load("k", async () => { throw failure; })).toBe("old");
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.read("k")).toBe("old");
    expect(cache.inspect("k").error).toBe(failure);
  });

  it("force bypasses stale-while-revalidate and waits for the new data", async () => {
    const cache = createResourceCache({ staleWhileRevalidate: true });
    await cache.load("k", async () => "old");
    expect(await cache.load("k", async () => "new", true)).toBe("new");
  });

  it("a request started before clear() does not refill the cache", async () => {
    const cache = createResourceCache();
    const gate = deferred<string>();
    const pending = cache.load("k", () => gate.promise);
    cache.clear();
    gate.resolve("from-previous-account");
    await pending;
    expect(cache.read("k")).toBeNull();
  });
});

describe("account caches", () => {
  it("clears every registered cache on sign-out, even when one throws", () => {
    const a = createResourceCache();
    const offA = registerAccountCache(() => a.clear());
    const offBad = registerAccountCache(() => {
      throw new Error("boom");
    });
    const second = new Map([["company-a", 1]]);
    const offB = registerAccountCache(() => second.clear());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    void a.load("company-a:summary", async () => "secret-a");
    return Promise.resolve().then(() => {
      clearAccountCaches();
      expect(a.size).toBe(0);
      expect(second.size).toBe(0);
      expect(warn).toHaveBeenCalled();
      offA();
      offBad();
      offB();
      warn.mockRestore();
    });
  });
});
