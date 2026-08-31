// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearMeetingsCache,
  loadMeetingsCache,
  saveMeetingsCache,
  type MeetingsSnapshot,
} from "./meetings-cache";

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
    saveMeetingsCache("account-a", snapshot);

    expect(loadMeetingsCache("account-b")).toBeNull();
    expect(loadMeetingsCache("account-a")).toEqual(snapshot);
    // An anonymous/missing identity is intentionally a cache miss rather
    // than a shared browser-local fallback.
    expect(loadMeetingsCache()).toBeNull();
  });

  it("clears only the requested account cache key", () => {
    saveMeetingsCache("account-a", snapshot);
    saveMeetingsCache("account-b", { ...snapshot, events: [{ id: "event-b" }] });

    clearMeetingsCache("account-a");

    expect(loadMeetingsCache("account-a")).toBeNull();
    expect(loadMeetingsCache("account-b")?.events).toEqual([{ id: "event-b" }]);
  });
});
