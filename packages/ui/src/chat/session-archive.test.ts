import { describe, expect, it } from "vitest";

import {
  ARCHIVED_STORAGE_KEY,
  SHOW_ARCHIVED_STORAGE_KEY,
  archiveConversations,
  archivedRowCount,
  filterByArchived,
  isArchived,
  loadArchived,
  loadShowArchived,
  saveArchived,
  saveShowArchived,
  unarchiveConversations,
} from "./session-archive.js";
import { createTenantStorage } from "../identity/tenant-storage.js";
import type { ConversationRow } from "./sidebar-model.js";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function row(id: string, extra: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id,
    kind: "channel",
    title: id,
    companyUid: "cmp_1",
    unreadDot: false,
    lastActivityAt: 1,
    pinned: false,
    ...extra,
  };
}

describe("session archive", () => {
  it("archives and unarchives without touching row data", () => {
    const rows = [
      row("ch:a", { unreadCount: 4, unreadDot: true }),
      row("dm:b"),
    ];
    const archived = archiveConversations([], ["ch:a"]);
    expect(archived).toEqual(["ch:a"]);

    const visible = filterByArchived(rows, archived, false);
    expect(visible.map((r) => r.id)).toEqual(["dm:b"]);

    const restored = filterByArchived(rows, unarchiveConversations(archived, ["ch:a"]), false);
    expect(restored.map((r) => r.id)).toEqual(["ch:a", "dm:b"]);
    // Unread state survives the round trip — archive hides, never mutates.
    expect(restored[0].unreadCount).toBe(4);
    expect(restored[0].unreadDot).toBe(true);
  });

  it("bulk archives and collapses duplicates", () => {
    const archived = archiveConversations(["ch:a"], ["ch:a", "dm:b", "ch:c"]);
    expect(archived).toEqual(["ch:a", "dm:b", "ch:c"]);
  });

  it("bulk unarchives a selection", () => {
    const archived = unarchiveConversations(["ch:a", "dm:b", "ch:c"], [
      "ch:a",
      "ch:c",
    ]);
    expect(archived).toEqual(["dm:b"]);
  });

  it("shows archived rows when the filter is on", () => {
    const rows = [row("ch:a"), row("dm:b")];
    expect(filterByArchived(rows, ["ch:a"], true).map((r) => r.id)).toEqual([
      "ch:a",
      "dm:b",
    ]);
  });

  it("reports archived rows present in the list", () => {
    const rows = [row("ch:a"), row("dm:b")];
    expect(archivedRowCount(rows, ["ch:a", "gone:x"])).toBe(1);
    expect(archivedRowCount(rows, [])).toBe(0);
    expect(isArchived(new Set(["ch:a"]), "ch:a")).toBe(true);
  });

  it("round-trips through storage and ignores junk", () => {
    const storage = memoryStorage();
    saveArchived(["ch:a", "dm:b"], storage);
    expect(loadArchived(storage)).toEqual(["ch:a", "dm:b"]);
    expect(storage.map.get(ARCHIVED_STORAGE_KEY)).toBe('["ch:a","dm:b"]');

    storage.setItem(ARCHIVED_STORAGE_KEY, "{not json");
    expect(loadArchived(storage)).toEqual([]);
    storage.setItem(ARCHIVED_STORAGE_KEY, '{"a":1}');
    expect(loadArchived(storage)).toEqual([]);
    expect(loadArchived(null)).toEqual([]);
  });

  it("round-trips the Show archived preference", () => {
    const storage = memoryStorage();
    expect(loadShowArchived(storage)).toBe(false);
    saveShowArchived(true, storage);
    expect(storage.map.get(SHOW_ARCHIVED_STORAGE_KEY)).toBe("1");
    expect(loadShowArchived(storage)).toBe(true);
    saveShowArchived(false, storage);
    expect(storage.map.has(SHOW_ARCHIVED_STORAGE_KEY)).toBe(false);
    expect(loadShowArchived(storage)).toBe(false);
  });

  it("keeps archive state isolated per tenant", () => {
    const backing = memoryStorage();
    const indigo = createTenantStorage(backing, {
      accountId: "acct_ada",
      companyId: "cmp_indigo",
    });
    const other = createTenantStorage(backing, {
      accountId: "acct_ada",
      companyId: "cmp_other",
    });

    saveArchived(["ch:indigo"], indigo);
    expect(loadArchived(indigo)).toEqual(["ch:indigo"]);
    expect(loadArchived(other)).toEqual([]);

    saveShowArchived(true, indigo);
    expect(loadShowArchived(other)).toBe(false);

    const strangerAccount = createTenantStorage(backing, {
      accountId: "acct_bob",
      companyId: "cmp_indigo",
    });
    expect(loadArchived(strangerAccount)).toEqual([]);
  });

  it("no-ops before an account is known", () => {
    const backing = memoryStorage();
    const unbound = createTenantStorage(backing, {
      accountId: null,
      companyId: "cmp_indigo",
    });
    saveArchived(["ch:a"], unbound);
    expect(backing.map.size).toBe(0);
    expect(loadArchived(unbound)).toEqual([]);
  });
});
