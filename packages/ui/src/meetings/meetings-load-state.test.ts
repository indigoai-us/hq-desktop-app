// @vitest-environment happy-dom
/**
 * Meetings load time and honest loading state (owner report 2026-10-06):
 * a cached agenda paints before any network read answers, the detail pane
 * and header chip never claim "Nothing scheduled" / "Nothing live" while
 * the first read is still out, a background refresh keeps the open
 * selection, and a cache write the webview silently drops is retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type AdapterResult } from "@hq/platform";

import { loadMeetingsCache, saveMeetingsCache, type MeetingsSnapshot } from "./meetings-cache";
import {
  configureMeetingsApi,
  meetingsStore,
  startMeetingsStore,
  stopMeetingsStore,
} from "./meetings-store.svelte";
import { meetingsRailState } from "./meetings-rail-state.svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import MeetingsToolbarControls from "./MeetingsToolbarControls.svelte";

type Answer = () => Promise<AdapterResult<unknown>>;
let generation = 500;

function event(id: string, minutesFromNow: number) {
  const start = new Date(Date.now() + minutesFromNow * 60_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  return {
    id,
    summary: `Meeting ${id}`,
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };
}

function never(): Promise<AdapterResult<unknown>> {
  return new Promise(() => {});
}

function wire(answers: Partial<Record<string, Answer>>, storage: Storage | null = null): void {
  const answer = (name: string) => (answers[name] ?? (async () => ok([])))();
  generation += 1;
  configureMeetingsApi({
    accountId: `acct-${generation}`,
    sessionGeneration: generation,
    storage,
    meetings: {
      listMemberships: () => answer("listMemberships") as never,
      listUpcoming: () => answer("listUpcoming") as never,
      listScheduledBots: () => answer("listScheduledBots") as never,
      listRecorded: () => Promise.resolve(ok({ meetings: [] })) as never,
      getRecorded: () => answer("getRecorded") as never,
      inviteBot: () => answer("inviteBot") as never,
      cancelBot: () => answer("cancelBot") as never,
      joinBotNow: () => answer("joinBotNow") as never,
      listAccounts: () => answer("listAccounts") as never,
      listCalendars: () => answer("listCalendars") as never,
      connectCalendar: () => answer("connectCalendar") as never,
      disconnectCalendar: () => answer("disconnectCalendar") as never,
      permissionsState: () => answer("permissionsState") as never,
      openPermissionsSetup: () => answer("openPermissionsSetup") as never,
    },
  } as never);
}

function snapshot(events: unknown[]): MeetingsSnapshot {
  return {
    events,
    scheduledBots: [],
    botsByEventId: [],
    companyNamesByUid: [],
    accounts: [{ accountId: "g1", email: "a@example.com" }],
    accountEmailById: [["g1", "a@example.com"]],
    calendarsByAccount: [],
    enabledCalIdsByAccount: [],
    calendarSummaryByKey: [],
  };
}

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
  stopMeetingsStore();
  meetingsRailState.select(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderEmpty(): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(MeetingsStatesBody, { target, props: { mode: "empty", sections: [], now: new Date() } }));
  flushSync();
  return target;
}

describe("Meetings cache-first paint", () => {
  it("renders cached rows before any network read answers", () => {
    saveMeetingsCache(snapshot([event("cached-1", 60)]), localStorage);
    wire({ listUpcoming: never, listMemberships: never, listAccounts: never }, localStorage);
    startMeetingsStore();
    void meetingsStore.refresh();
    expect(meetingsStore.initialLoadPending).toBe(false);
    expect(meetingsStore.events.map((e) => e.id)).toEqual(["cached-1"]);
  });

  it("paints a snapshot that is days old instead of a cold load", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now - 3 * 86_400_000);
    saveMeetingsCache(snapshot([event("old", 60)]), localStorage);
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(loadMeetingsCache(localStorage)?.events).toHaveLength(1);
  });

  it("cold start paints agenda rows once the calendar answers, before bots and calendars", async () => {
    wire({
      listUpcoming: async () => ok([event("live-1", 60)]),
      listScheduledBots: never,
    });
    startMeetingsStore();
    void meetingsStore.refresh();
    expect(meetingsStore.initialLoadPending).toBe(true);
    await vi.waitFor(() => expect(meetingsStore.events.map((e) => e.id)).toEqual(["live-1"]));
    expect(meetingsStore.initialLoadPending).toBe(false);
  });

  it("a background refresh keeps the open selection", async () => {
    saveMeetingsCache(snapshot([event("keep", 60), event("other", 120)]), localStorage);
    wire({ listUpcoming: async () => ok([event("keep", 60), event("other", 120), event("new", 180)]) }, localStorage);
    startMeetingsStore();
    meetingsRailState.select("keep");
    await meetingsStore.refresh();
    expect(meetingsStore.events.map((e) => e.id)).toContain("new");
    expect(meetingsRailState.selectedId).toBe("keep");
  });
});

describe("Meetings detail pane while loading", () => {
  it("shows neither Nothing scheduled nor Nothing live before the first read resolves", () => {
    wire({ listUpcoming: never });
    startMeetingsStore();
    void meetingsStore.refresh();
    const el = renderEmpty();
    expect(el.textContent).not.toContain("Nothing scheduled");
    expect(el.textContent).not.toContain("Nothing live");
    expect(el.querySelector('[data-testid="meetings-live-chip"]')).toBeNull();
    expect(el.querySelector('[data-testid="meetings-next-pending"]')).toBeTruthy();
  });

  it("says Nothing scheduled and Nothing live only after a resolved empty read", async () => {
    wire({ listAccounts: async () => ok([{ accountId: "g1", email: "a@example.com" }]) });
    startMeetingsStore();
    await meetingsStore.refresh();
    const el = renderEmpty();
    expect(el.querySelector('[data-testid="meetings-next-pending"]')).toBeNull();
    expect(el.textContent).toContain("Nothing scheduled");
    expect(el.querySelector('[data-testid="meetings-live-chip"]')?.textContent).toBe("Nothing live");
  });
});

describe("Meetings calendar chip while loading", () => {
  function chipText(): string {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(MeetingsToolbarControls, { target, props: {} }));
    flushSync();
    return target.querySelector('[data-testid="meetings-calendar-chip"]')?.textContent ?? "";
  }

  it("does not say No calendar before the accounts read answers", () => {
    wire({ listAccounts: never });
    startMeetingsStore();
    void meetingsStore.refresh();
    expect(chipText()).not.toContain("No calendar");
  });

  it("says No calendar after a resolved read with no accounts", async () => {
    wire({});
    startMeetingsStore();
    await meetingsStore.refresh();
    expect(chipText()).toContain("No calendar");
  });
});

describe("Meetings cache write", () => {
  function fullStorage(limit: number) {
    const values = new Map<string, string>();
    const used = () => [...values.values()].reduce((n, v) => n + v.length, 0);
    return {
      values,
      getItem: (k: string) => values.get(k) ?? null,
      // Like a tenant-scoped wrapper over a full origin: drops the write silently.
      setItem: (k: string, v: string) => {
        const without = used() - (values.get(k)?.length ?? 0);
        if (without + v.length <= limit) values.set(k, v);
      },
      removeItem: (k: string) => void values.delete(k),
    };
  }

  it("frees its own stale entry and retries when the write is silently dropped", () => {
    const storage = fullStorage(4_000);
    storage.values.set("other-app-data", "x".repeat(1_500));
    const big = snapshot(Array.from({ length: 8 }, (_, i) => event(`e${i}`, i * 10)));
    expect(saveMeetingsCache(big, storage)).toBe(true);
    const fresh = snapshot([event("fresh", 30)]);
    // Fits only once the previous meetings entry is gone.
    storage.values.set("other-app-data", "x".repeat(4_000 - 1_200 - (storage.values.get("hq-sync:meetings-window:v2")?.length ?? 0) + 1));
    expect(saveMeetingsCache(fresh, storage)).toBe(true);
    expect(loadMeetingsCache(storage)?.events.map((e) => (e as { id: string }).id)).toEqual(["fresh"]);
  });

  it("reports and logs a write that still fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fullStorage(10);
    expect(saveMeetingsCache(snapshot([event("x", 30)]), storage)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[meetings-cache] snapshot write failed"));
  });

  it("persists bots once, not twice", async () => {
    const bot = { botId: "b1", calendarEventId: "keep", status: "scheduled" };
    wire({ listUpcoming: async () => ok([event("keep", 60)]), listScheduledBots: async () => ok([bot]) }, localStorage);
    startMeetingsStore();
    await meetingsStore.refresh();
    const cached = loadMeetingsCache(localStorage)!;
    expect(cached.botsByEventId).toEqual([]);
    expect(cached.scheduledBots).toHaveLength(1);
  });
});
