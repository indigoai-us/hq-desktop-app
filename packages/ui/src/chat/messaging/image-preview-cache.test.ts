import { describe, expect, it, vi } from "vitest";
import { ImagePreviewCache } from "./image-preview-cache";
import type { ImagePreviewStore, StoredImagePreview } from "./image-preview-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const blob = new Blob(["image"], { type: "image/png" });
function setup(overrides: Partial<ConstructorParameters<typeof ImagePreviewCache>[0]> = {}) {
  let sequence = 0;
  const load = vi.fn(async () => blob);
  const revokeUrl = vi.fn();
  const cache = new ImagePreviewCache({
    account: "alice", load, revokeUrl,
    prepare: async (value) => ({ blob: value, width: 2, height: 2 }),
    createUrl: () => "blob:preview-" + ++sequence,
    ...overrides,
  });
  return { cache, load, revokeUrl };
}
function memoryStore(): ImagePreviewStore {
  const records = new Map<string, StoredImagePreview>();
  return {
    get: async (key) => records.get(key) ?? null,
    put: async (value) => { records.set(value.key, value); },
    delete: async (key) => { records.delete(key); },
    clearAccount: async (account) => {
      for (const [key, value] of records) if (value.account === account) records.delete(key);
    },
  };
}

describe("chat image preview ownership", () => {
  it("reuses previews across channel unmount/remount without another network call", async () => {
    const { cache, load, revokeUrl } = setup();
    const first = await cache.acquire("company", "photo");
    first.release();
    expect(cache.peek("company", "photo")?.url).toBe(first.url);
    const second = await cache.acquire("company", "photo");
    expect(second.url).toBe(first.url);
    expect(load).toHaveBeenCalledTimes(1);
    expect(revokeUrl).not.toHaveBeenCalled();
    second.release();
    cache.dispose();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(first.url);
  });
  it("deduplicates concurrent chat/reply loads without revoking a leased image", async () => {
    const pending = deferred<Blob>();
    const load = vi.fn(() => pending.promise);
    const { cache, revokeUrl } = setup({ load, memoryBudget: 1 });
    const first = cache.acquire("company", "photo");
    const second = cache.acquire("company", "photo");
    pending.resolve(blob);
    const [a, b] = await Promise.all([first, second]);
    expect(load).toHaveBeenCalledTimes(1);
    a.release(); a.release();
    expect(revokeUrl).not.toHaveBeenCalled();
    b.release();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(a.url);
  });
  it("evicts unused previews and reloads them, keeping active previews alive", async () => {
    const { cache, revokeUrl } = setup({ memoryBudget: 25 });
    const a = await cache.acquire("company", "a");
    const b = await cache.acquire("company", "b");
    expect(revokeUrl).not.toHaveBeenCalled();
    a.release();
    expect(cache.peek("company", "a")).toBeNull();
    expect(cache.peek("company", "b")?.url).toBe(b.url);
    b.release();
  });
  it("isolates both accounts and vault scopes in persistent storage", async () => {
    const store = memoryStore();
    const first = setup({ store });
    (await first.cache.acquire("company-a", "same-id")).release();
    (await first.cache.acquire("company-b", "same-id")).release();
    expect(first.load).toHaveBeenCalledTimes(2);
    first.cache.dispose();
    const reopened = setup({ store });
    (await reopened.cache.acquire("company-a", "same-id")).release();
    expect(reopened.load).not.toHaveBeenCalled();
    const bob = setup({ store, account: "bob" });
    (await bob.cache.acquire("company-a", "same-id")).release();
    expect(bob.load).toHaveBeenCalledTimes(1);
    await reopened.cache.clearAccount();
    const aliceAgain = setup({ store });
    (await aliceAgain.cache.acquire("company-a", "same-id")).release();
    expect(aliceAgain.load).toHaveBeenCalledTimes(1);
    const bobAgain = setup({ store, account: "bob" });
    (await bobAgain.cache.acquire("company-a", "same-id")).release();
    expect(bobAgain.load).not.toHaveBeenCalled();
  });
  it("drops late account responses instead of retaining or persisting them", async () => {
    const pending = deferred<Blob>();
    const store = memoryStore();
    const put = vi.spyOn(store, "put");
    const { cache } = setup({ store, load: () => pending.promise });
    const acquiring = cache.acquire("company", "photo");
    const rejection = expect(acquiring).rejects.toThrow("closed");
    await Promise.resolve();
    cache.dispose();
    pending.resolve(blob);
    await rejection;
    expect(put).not.toHaveBeenCalled();
    expect(cache.peek("company", "photo")).toBeNull();
  });
  it("retries failed fetches and seeds local uploads without downloading", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(blob);
    const { cache } = setup({ load });
    await expect(cache.acquire("company", "photo")).rejects.toThrow("offline");
    (await cache.acquire("company", "photo")).release();
    await cache.warm("company", "upload", blob);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.peek("company", "upload")).not.toBeNull();
  });
  it("limits cold preview work to two at a time", async () => {
    const gates = [deferred<Blob>(), deferred<Blob>(), deferred<Blob>()];
    const load = vi.fn((_scope, path) => gates[Number(path)].promise);
    const { cache } = setup({ load });
    const requests = [0, 1, 2].map((i) => cache.acquire("company", String(i)));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    gates[0].resolve(blob);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    gates[1].resolve(blob); gates[2].resolve(blob);
    (await Promise.all(requests)).forEach((lease) => lease.release());
  });
  it("still renders when local persistence is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore();
    store.get = async () => { throw new Error("disabled"); };
    store.put = async () => { throw new Error("quota"); };
    const { cache, load } = setup({ store });
    const lease = await cache.acquire("company", "photo");
    expect(lease.url).toContain("blob:");
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
