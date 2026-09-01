import { describe, expect, it } from "vitest";
import { createTenantStorage } from "../identity/tenant-storage.js";
import { loadMeetingsCache, saveMeetingsCache } from "./meetings-cache.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const snapshot = {
  events: [{ id: "meeting-a", summary: "A-private agenda" }],
  botsByEventId: [],
  companyNamesByUid: [],
  accounts: [],
  accountEmailById: [],
  calendarsByAccount: [],
  enabledCalIdsByAccount: [],
  calendarSummaryByKey: [],
};

describe("meetings cache tenant boundary", () => {
  it("never replays account A's meeting metadata to account B", () => {
    const raw = memoryStorage();
    const accountA = createTenantStorage(raw, {
      accountId: "acct_a",
      companyId: "all",
    });
    const accountB = createTenantStorage(raw, {
      accountId: "acct_b",
      companyId: "all",
    });

    saveMeetingsCache(snapshot, accountA);

    expect(loadMeetingsCache(accountA)?.events).toEqual(snapshot.events);
    expect(loadMeetingsCache(accountB)).toBeNull();
  });
});
