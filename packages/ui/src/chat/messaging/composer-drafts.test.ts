// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearDraft,
  COMPOSER_DRAFT_CHANGED_EVENT,
  COMPOSER_DRAFTS_STORAGE_KEY,
  listDraftRowIds,
  loadDraft,
  MAX_COMPOSER_DRAFT_CHARS,
  MAX_COMPOSER_DRAFTS,
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
