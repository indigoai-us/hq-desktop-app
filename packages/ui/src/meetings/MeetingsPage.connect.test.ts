// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AdapterResult, type PlatformAdapter } from "@hq/platform";

import MeetingsPage from "./MeetingsPage.svelte";
import {
  configureMeetingsApi,
  meetingsStore,
  stopMeetingsStore,
} from "./meetings-store.svelte";

const consentUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?state=test-connect";

const call =
  vi.fn<
    (method: string, payload?: unknown) => Promise<AdapterResult<unknown>>
  >();

function wireApi() {
  configureMeetingsApi({
    meetings: {
      listMemberships: () => call("listMemberships") as never,
      listUpcoming: () => call("listUpcoming") as never,
      listScheduledBots: () => call("listScheduledBots") as never,
      inviteBot: () => call("inviteBot") as never,
      cancelBot: () => call("cancelBot") as never,
      joinBotNow: () => call("joinBotNow") as never,
      listAccounts: () => call("listAccounts") as never,
      listCalendars: () => call("listCalendars") as never,
      connectCalendar: () => call("connectCalendar") as never,
      disconnectCalendar: () => call("disconnectCalendar") as never,
    },
    feedback: {
      submitBugReport: () => call("submitBugReport") as never,
    },
  });
}

function fakeAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    meetings: {
      listMemberships: () => call("listMemberships") as never,
      listUpcoming: () => call("listUpcoming") as never,
      listScheduledBots: () => call("listScheduledBots") as never,
      inviteBot: () => call("inviteBot") as never,
      cancelBot: () => call("cancelBot") as never,
      joinBotNow: () => call("joinBotNow") as never,
      listAccounts: () => call("listAccounts") as never,
      listCalendars: () => call("listCalendars") as never,
      connectCalendar: () => call("connectCalendar") as never,
      disconnectCalendar: () => call("disconnectCalendar") as never,
    },
    feedback: {
      submitBugReport: () => call("submitBugReport") as never,
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  call.mockReset();
  call.mockImplementation((method: string) => {
    if (method === "connectCalendar") {
      return Promise.resolve(ok({ url: consentUrl }));
    }
    if (
      method === "listAccounts" ||
      method === "listMemberships" ||
      method === "listUpcoming" ||
      method === "listScheduledBots"
    ) {
      return Promise.resolve(ok([]));
    }
    if (method === "listCalendars") {
      return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
    }
    throw new Error(`Unexpected api call: ${method}`);
  });
  stopMeetingsStore();
  meetingsStore.stopCalendarConnectWatch();
  meetingsStore.clearConnectNotice();
  wireApi();
});

afterEach(async () => {
  meetingsStore.stopCalendarConnectWatch();
  stopMeetingsStore();
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("MeetingsPage calendar connect popup blocked (Fix 4)", () => {
  it("stops the connect watch when the default web opener gets a blocked popup", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MeetingsPage, {
      target: host,
      props: { adapter: fakeAdapter() },
    });
    await tick();

    const connectBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="meetings-connect-calendar"]',
    );
    expect(connectBtn).not.toBeNull();
    connectBtn?.click();

    await vi.waitFor(() => {
      expect(openSpy).toHaveBeenCalled();
      expect(meetingsStore.connectPending).toBe(false);
    });

    // Re-connectable — not stuck in "Waiting for Google…".
    expect(connectBtn?.disabled).toBe(false);
    expect(host.textContent).toMatch(
      /Popup blocked|Couldn't open the browser/i,
    );

    openSpy.mockRestore();
  });
});
