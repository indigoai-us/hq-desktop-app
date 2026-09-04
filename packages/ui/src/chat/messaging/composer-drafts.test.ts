// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearDraft,
  COMPOSER_DRAFT_CHANGED_EVENT,
  COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY,
  COMPOSER_DRAFTS_STORAGE_KEY,
  listDraftRowIds,
  loadDraft,
  MAX_COMPOSER_DRAFT_CHARS,
  MAX_COMPOSER_DRAFTS,
  MAX_COMPOSER_DRAFTS_BYTES,
  saveDraft,
  type ComposerDraftChangedDetail,
  type DraftStorage,
} from "./composer-drafts";

function memoryStorage(seed: Record<string, string> = {}): DraftStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const listeners: Array<(e: Event) => void> = [];
function captureEvents(): ComposerDraftChangedDetail[] {
  const seen: ComposerDraftChangedDetail[] = [];
  const fn = (e: Event) =>
    seen.push((e as CustomEvent<ComposerDraftChangedDetail>).detail);
  window.addEventListener(COMPOSER_DRAFT_CHANGED_EVENT, fn);
  listeners.push(fn);
  return seen;
}

afterEach(() => {
  for (const fn of listeners.splice(0)) {
    window.removeEventListener(COMPOSER_DRAFT_CHANGED_EVENT, fn);
  }
});

describe("composer-drafts", () => {
  it("round-trips a draft per row id and lists rows with drafts", () => {
    const storage = memoryStorage();
    expect(loadDraft(storage, "ch:a")).toBe("");
    saveDraft(storage, "ch:a", "hello");
    saveDraft(storage, "dm:prs_1", "  hi there");
    expect(loadDraft(storage, "ch:a")).toBe("hello");
    expect(loadDraft(storage, "dm:prs_1")).toBe("  hi there");
    expect(listDraftRowIds(storage).sort()).toEqual(["ch:a", "dm:prs_1"]);
    // One tenant-scoped blob.
    expect([...storage.map.keys()]).toEqual([COMPOSER_DRAFTS_STORAGE_KEY]);
    clearDraft(storage, "ch:a");
    expect(loadDraft(storage, "ch:a")).toBe("");
    expect(listDraftRowIds(storage)).toEqual(["dm:prs_1"]);
    clearDraft(storage, "dm:prs_1");
    expect(storage.map.size).toBe(0);
  });

  it("whitespace-only text removes the entry", () => {
    const storage = memoryStorage();
    saveDraft(storage, "ch:a", "keep me");
    saveDraft(storage, "ch:a", "   \n ");
    expect(loadDraft(storage, "ch:a")).toBe("");
    expect(listDraftRowIds(storage)).toEqual([]);
  });

  it("caps a single draft's length and prunes the oldest past the entry cap", () => {
    const storage = memoryStorage();
    saveDraft(storage, "ch:long", "x".repeat(MAX_COMPOSER_DRAFT_CHARS + 50));
    expect(loadDraft(storage, "ch:long")).toHaveLength(MAX_COMPOSER_DRAFT_CHARS);

    for (let i = 0; i < MAX_COMPOSER_DRAFTS + 5; i += 1) {
      saveDraft(storage, `ch:${i}`, `draft ${i}`, 1_000 + i);
    }
    const ids = listDraftRowIds(storage);
    expect(ids).toHaveLength(MAX_COMPOSER_DRAFTS);
    // "ch:long" (updatedAt = now, newest) survives; the oldest numbered go.
    expect(ids).toContain("ch:long");
    expect(ids).not.toContain("ch:0");
    expect(ids).not.toContain("ch:5");
    expect(ids).toContain("ch:6");
    expect(ids).toContain(`ch:${MAX_COMPOSER_DRAFTS + 4}`);
  });

  it("swallows quota errors and corrupt blobs", () => {
    const throwing: DraftStorage = {
      getItem: () => {
        throw new Error("boom");
      },
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("boom");
      },
    };
    expect(() => saveDraft(throwing, "ch:a", "text")).not.toThrow();
    expect(() => clearDraft(throwing, "ch:a")).not.toThrow();
    expect(loadDraft(throwing, "ch:a")).toBe("");
    expect(listDraftRowIds(throwing)).toEqual([]);

    const corrupt = memoryStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: "{nope" });
    expect(listDraftRowIds(corrupt)).toEqual([]);
    const wrongShape = memoryStorage({
      [COMPOSER_DRAFTS_STORAGE_KEY]: JSON.stringify({
        "ch:a": { text: 42 },
        "ch:b": "str",
        "ch:c": { text: "ok" },
      }),
    });
    expect(listDraftRowIds(wrongShape)).toEqual(["ch:c"]);
    expect(loadDraft(null, "ch:c")).toBe("");
    expect(listDraftRowIds(undefined)).toEqual([]);
  });

  it("reports a failed write instead of pretending it persisted", () => {
    let failing = true;
    const storage = memoryStorage();
    const flaky: DraftStorage = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
      setItem: (k, v) => {
        if (failing) throw new DOMException("quota", "QuotaExceededError");
        storage.setItem(k, v);
      },
    };
    const seen = captureEvents();
    expect(saveDraft(flaky, "ch:a", "lost?")).toBe(false);
    expect(loadDraft(flaky, "ch:a")).toBe("");
    expect(seen, "no change event for a write storage rejected").toEqual([]);
    failing = false;
    expect(saveDraft(flaky, "ch:a", "lost?")).toBe(true);
    expect(loadDraft(flaky, "ch:a")).toBe("lost?");
    expect(seen).toEqual([{ rowId: "ch:a", hasDraft: true }]);
    // Clearing an absent row is a success; a rejected removal is not.
    expect(clearDraft(flaky, "ch:zzz")).toBe(true);
    const stuck: DraftStorage = {
      ...flaky,
      removeItem: () => {
        throw new Error("boom");
      },
    };
    expect(clearDraft(stuck, "ch:a")).toBe(false);
    expect(loadDraft(stuck, "ch:a")).toBe("lost?");
    expect(saveDraft(null, "ch:a", "x")).toBe(false);
    expect(saveDraft(storage, "", "x")).toBe(false);
  });

  it("parks a corrupt blob under a sibling key before starting a fresh map", () => {
    const corruptRaw = '{"ch:other":{"text":"someone else\'s draft","updatedAt":1}';
    const storage = memoryStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: corruptRaw });
    // Reads never touch the blob.
    expect(listDraftRowIds(storage)).toEqual([]);
    expect(clearDraft(storage, "ch:other")).toBe(true);
    expect(storage.map.get(COMPOSER_DRAFTS_STORAGE_KEY)).toBe(corruptRaw);
    expect(storage.map.has(COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY)).toBe(false);

    expect(saveDraft(storage, "ch:a", "new draft")).toBe(true);
    expect(loadDraft(storage, "ch:a")).toBe("new draft");
    expect(
      storage.map.get(COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY),
      "original blob preserved for recovery",
    ).toBe(corruptRaw);

    // A second corruption does not clobber the first backup.
    storage.map.set(COMPOSER_DRAFTS_STORAGE_KEY, "[1,2");
    expect(saveDraft(storage, "ch:b", "again")).toBe(true);
    expect(storage.map.get(COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY)).toBe(corruptRaw);
    expect(listDraftRowIds(storage)).toEqual(["ch:b"]);

    // Wrong top-level shape counts as corrupt too.
    const arr = memoryStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: "[]" });
    expect(saveDraft(arr, "ch:a", "x")).toBe(true);
    expect(arr.map.get(COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY)).toBe("[]");

    // If the backup itself cannot be written, refuse to overwrite.
    const noBackup = memoryStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: "{nope" });
    const refusing: DraftStorage = {
      getItem: noBackup.getItem,
      removeItem: noBackup.removeItem,
      setItem: (k, v) => {
        if (k === COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY) throw new Error("quota");
        noBackup.setItem(k, v);
      },
    };
    expect(saveDraft(refusing, "ch:a", "x")).toBe(false);
    expect(noBackup.map.get(COMPOSER_DRAFTS_STORAGE_KEY)).toBe("{nope");
  });

  it("prunes the oldest drafts until the serialized blob fits the byte cap", () => {
    const storage = memoryStorage();
    const big = "y".repeat(MAX_COMPOSER_DRAFT_CHARS);
    // Enough max-length drafts to blow well past the cap while staying under
    // the entry cap, so only the byte cap can be responsible for the pruning.
    const count = Math.ceil(MAX_COMPOSER_DRAFTS_BYTES / MAX_COMPOSER_DRAFT_CHARS) + 5;
    expect(count).toBeLessThan(MAX_COMPOSER_DRAFTS);
    for (let i = 0; i < count; i += 1) {
      expect(saveDraft(storage, `ch:${i}`, big, 1_000 + i)).toBe(true);
    }
    const blob = storage.map.get(COMPOSER_DRAFTS_STORAGE_KEY)!;
    expect(new TextEncoder().encode(blob).length).toBeLessThanOrEqual(
      MAX_COMPOSER_DRAFTS_BYTES,
    );
    const ids = listDraftRowIds(storage);
    expect(ids.length).toBeLessThan(count);
    expect(ids.length).toBeGreaterThan(1);
    expect(ids).not.toContain("ch:0");
    expect(ids).toContain(`ch:${count - 1}`);
    // Survivors are exactly the newest N.
    expect(ids.sort()).toEqual(
      Array.from({ length: ids.length }, (_, k) => `ch:${count - 1 - k}`).sort(),
    );
    // Non-ASCII text is measured in UTF-8 bytes, not chars.
    const wide = memoryStorage();
    const emoji = "😀".repeat(MAX_COMPOSER_DRAFT_CHARS / 2);
    for (let i = 0; i < 40; i += 1) saveDraft(wide, `ch:${i}`, emoji, i);
    expect(
      new TextEncoder().encode(wide.map.get(COMPOSER_DRAFTS_STORAGE_KEY)!).length,
    ).toBeLessThanOrEqual(MAX_COMPOSER_DRAFTS_BYTES);
    expect(listDraftRowIds(wide).length).toBeLessThan(40);
  });

  it("dispatches hq:composer-draft-changed on save and clear", () => {
    const seen = captureEvents();
    const storage = memoryStorage();
    saveDraft(storage, "ch:a", "hello");
    saveDraft(storage, "ch:a", "   ");
    saveDraft(storage, "ch:b", "b");
    clearDraft(storage, "ch:b");
    expect(seen).toEqual([
      { rowId: "ch:a", hasDraft: true },
      { rowId: "ch:a", hasDraft: false },
      { rowId: "ch:b", hasDraft: true },
      { rowId: "ch:b", hasDraft: false },
    ]);
  });

  it("dispatches exactly one window event per save", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    const storage = memoryStorage();
    saveDraft(storage, "ch:a", "x");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
