// @vitest-environment happy-dom
/**
 * AUDIT-3-16 / BLANK-2: a calendar read that fails is not "no calendar".
 * Drives the real meetings store with an adapter whose accounts read fails
 * (or whose whole refresh fails) and checks the empty canvas shows the
 * failed-read line and Try again, never "Connect your calendar". A read that
 * succeeds with no accounts still offers Connect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type AdapterResult } from "@hq/platform";

vi.mock("./meetings-cache", () => ({
  loadMeetingsCache: vi.fn(() => null),
  saveMeetingsCache: vi.fn(),
}));

import { configureMeetingsApi, meetingsStore, stopMeetingsStore } from "./meetings-store.svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";

type Answers = Partial<Record<string, () => Promise<AdapterResult<unknown>>>>;
let generation = 100;

function wire(answers: Answers): void {
  const answer = (name: string) => (answers[name] ?? (async () => ok([])))();
  generation += 1;
  configureMeetingsApi({
    accountId: `acct-${generation}`,
    sessionGeneration: generation,
    meetings: {
      listMemberships: () => answer("listMemberships") as never,
      listUpcoming: () => answer("listUpcoming") as never,
      listScheduledBots: () => answer("listScheduledBots") as never,
      listRecorded: () => answer("listRecorded") as never,
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

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
  stopMeetingsStore();
  vi.restoreAllMocks();
});

function render(): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(MeetingsStatesBody, { target, props: { mode: "empty", sections: [], now: new Date() } }));
  flushSync();
  return target;
}

describe("Meetings failed calendar read (AUDIT-3-16)", () => {
  it("a failed accounts read shows the failed line and Try again, not Connect your calendar", async () => {
    wire({ listAccounts: () => Promise.reject(new Error("HTTP 503 calendar")) });
    await meetingsStore.refresh();
    const el = render();
    expect(el.querySelector('[data-testid="meetings-no-calendar"]')).toBeNull();
    expect(el.textContent).not.toContain("Connect your calendar");
    const failed = el.querySelector('[data-testid="meetings-calendar-failed"]');
    expect(failed?.textContent).toContain("Couldn't read your calendar.");
    expect(el.querySelector('[data-testid="meetings-calendar-retry"]')).toBeTruthy();
    expect(el.textContent).not.toContain("HTTP 503");
  });

  it("a refresh that fails outright shows the failed line, not Connect your calendar", async () => {
    wire({ listUpcoming: () => Promise.reject(new Error("HTTP 500")) });
    await meetingsStore.refresh();
    const el = render();
    expect(el.textContent).not.toContain("Connect your calendar");
    expect(el.querySelector('[data-testid="meetings-calendar-failed"]')).toBeTruthy();
  });

  it("Try again re-reads and a successful empty answer offers Connect", async () => {
    let fail = true;
    wire({ listAccounts: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve(ok([]))) });
    await meetingsStore.refresh();
    const el = render();
    fail = false;
    (el.querySelector('[data-testid="meetings-calendar-retry"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      flushSync();
      expect(el.querySelector('[data-testid="meetings-no-calendar"]')).toBeTruthy();
    });
    expect(el.querySelector('[data-testid="meetings-calendar-failed"]')).toBeNull();
  });
});
