// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearMeetingsCache,
  loadMeetingsCache,
  saveMeetingsCache,
  type MeetingsSnapshot,
} from "./meetings-cache";
import { createTenantStorage } from "../identity/tenant-storage";

const snapshot: MeetingsSnapshot = {
  events: [{ id: "event-a" }],
  botsByEventId: [],
  companyNamesByUid: [],
  accounts: [],
  accountEmailById: [],
  calendarsByAccount: [],
  enabledCalIdsByAccount: [],
  calendarSummaryByKey: [],
};

afterEach(() => localStorage.clear());

describe("meetings cache account isolation", () => {
  it("keeps account A's warm snapshot unavailable after an account-B restart", () => {
    const accountA = createTenantStorage(localStorage, {
      accountId: "account-a",
      companyId: "all",
    });
    const accountB = createTenantStorage(localStorage, {
      accountId: "account-b",
      companyId: "all",
    });
    saveMeetingsCache(snapshot, accountA);

    expect(loadMeetingsCache(accountB)).toBeNull();
    expect(loadMeetingsCache(accountA)).toEqual(snapshot);
  });

  it("clears only the requested account cache key", () => {
    const accountA = createTenantStorage(localStorage, {
      accountId: "account-a",
      companyId: "all",
    });
    const accountB = createTenantStorage(localStorage, {
      accountId: "account-b",
      companyId: "all",
    });
    saveMeetingsCache(snapshot, accountA);
    saveMeetingsCache({ ...snapshot, events: [{ id: "event-b" }] }, accountB);

    clearMeetingsCache(accountA);

    expect(loadMeetingsCache(accountA)).toBeNull();
    expect(loadMeetingsCache(accountB)?.events).toEqual([{ id: "event-b" }]);
  });
});
