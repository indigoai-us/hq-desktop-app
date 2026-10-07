// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, unavailable, type AdapterResult, type PlatformAdapter } from "@hq/platform";

import MeetingsPage from "./MeetingsPage.svelte";
import ToastStack from "../shell/ToastStack.svelte";
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
      listRecorded: () => Promise.resolve({ ok: true, value: { meetings: [] } }) as never,
      getRecorded: () => Promise.resolve({ ok: true, value: { signals: {} } }) as never,
      readRecordedBody: () => Promise.resolve({ ok: true, value: "" }) as never,
      inviteBot: () => call("inviteBot") as never,
      cancelBot: () => call("cancelBot") as never,
      joinBotNow: () => call("joinBotNow") as never,
      listAccounts: () => call("listAccounts") as never,
      listCalendars: () => call("listCalendars") as never,
      connectCalendar: () => call("connectCalendar") as never,
      disconnectCalendar: () => call("disconnectCalendar") as never,
      permissionsState: () => Promise.resolve(unavailable("desktop-only")) as never,
      openPermissionsSetup: () => call("openPermissionsSetup") as never,
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
      listRecorded: () => Promise.resolve({ ok: true, value: { meetings: [] } }) as never,
      getRecorded: () => Promise.resolve({ ok: true, value: { signals: {} } }) as never,
      readRecordedBody: () => Promise.resolve({ ok: true, value: "" }) as never,
      inviteBot: () => call("inviteBot") as never,
      cancelBot: () => call("cancelBot") as never,
      joinBotNow: () => call("joinBotNow") as never,
      listAccounts: () => call("listAccounts") as never,
      listCalendars: () => call("listCalendars") as never,
      connectCalendar: () => call("connectCalendar") as never,
      disconnectCalendar: () => call("disconnectCalendar") as never,
      permissionsState: () => Promise.resolve(unavailable("desktop-only")) as never,
      openPermissionsSetup: () => call("openPermissionsSetup") as never,
    },
    feedback: {
      submitBugReport: () => call("submitBugReport") as never,
    },
    identity: {
      whoami: () => Promise.resolve(ok({ personUid: "prs_fixture", email: "" })) as never,
      hasFeature: () => Promise.resolve(ok(false)) as never,
      subscribeFeature: () => () => {},
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
  if (layer) await unmount(layer);
  layer = null;
  host?.remove();
});
let layer: ReturnType<typeof mount> | null = null;

describe("MeetingsPage calendar connect popup blocked (Fix 4)", () => {
  it("stops the connect watch when the default web opener gets a blocked popup", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MeetingsPage, {
      target: host,
      props: { adapter: fakeAdapter() },
    });
    layer = mount(ToastStack, { target: host });
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
    // OWNER-003: page feedback renders on the shared toast layer.
    expect(document.querySelector('[data-testid="toast-stack"]')?.textContent).toMatch(
      /Popup blocked|Couldn't open the browser/i,
    );

    openSpy.mockRestore();
  });
});
