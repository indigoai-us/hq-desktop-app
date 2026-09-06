import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createImagePreviewStore, type StoredImagePreview } from "./image-preview-store";

function record(key: string, account = "alice", usedAt = Date.now()): StoredImagePreview {
  return { key, account, blob: new Blob(["12345"], { type: "image/png" }), width: 2, height: 2, usedAt };
}
describe("persistent chat image store", () => {
  it("restores actual blob bytes through a new store instance", async () => {
    const factory = new IDBFactory();
    const first = createImagePreviewStore(factory)!;
    await first.put(record("photo"));
    const second = createImagePreviewStore(factory)!;
    const saved = await second.get("photo");
    expect(await saved?.blob.text()).toBe("12345");
    expect(saved?.width).toBe(2);
  });
  it("evicts least recently used records to its byte budget", async () => {
    const store = createImagePreviewStore(new IDBFactory(), 10)!;
    await store.put(record("old", "alice", Date.now() - 1000));
    await store.put(record("middle", "alice", Date.now() - 500));
    await store.put(record("new"));
    expect(await store.get("old")).toBeNull();
    expect(await store.get("middle")).not.toBeNull();
    expect(await store.get("new")).not.toBeNull();
  });
  it("clears only the signing-out account", async () => {
    const store = createImagePreviewStore(new IDBFactory())!;
    await store.put(record("alice-image"));
    await store.put(record("bob-image", "bob"));
    await store.clearAccount("alice");
    expect(await store.get("alice-image")).toBeNull();
    expect(await store.get("bob-image")).not.toBeNull();
  });
  it("expires old records and removes explicitly invalidated entries", async () => {
    const store = createImagePreviewStore(new IDBFactory())!;
    await store.put(record("expired", "alice", Date.now() - 8 * 24 * 3600 * 1000));
    expect(await store.get("expired")).toBeNull();
    await store.put(record("bad"));
    await store.delete("bad");
    expect(await store.get("bad")).toBeNull();
  });
});
