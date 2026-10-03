// @vitest-environment happy-dom

// AUDIT-3c: Meetings toasts never show raw error text.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, unavailable, type AdapterResult, type PlatformAdapter } from "@hq/platform";

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

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

async function render(openExternal?: (url: string) => Promise<void>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MeetingsPage, {
    target: host,
    props: { adapter: fakeAdapter(), ...(openExternal ? { openExternal } : {}) },
  });
  layer = mount(ToastStack, { target: host });
  await tick();
}

function toastText(): string {
  return document.querySelector('[data-testid="toast-stack"]')?.textContent ?? "";
}

function expectNoRaw(): void {
  expect(document.body.textContent ?? "").not.toContain("boom");
  expect(document.body.textContent ?? "").not.toContain("HTTP 500");
  for (const el of document.querySelectorAll("[title]")) {
    expect(el.getAttribute("title") ?? "").not.toContain("boom");
  }
}

describe("MeetingsPage raw errors (AUDIT-3c)", () => {
  it.each([
    ["Open Calendar", ".meetings-open-cal", "Couldn't open Calendar. Try again.", "[meetings] open Google Calendar failed"],
    ["Manage in console", '[data-testid="meetings-manage"]', "Couldn't open HQ Console. Try again.", "[meetings] open HQ Console failed"],
    ["Connect calendar", '[data-testid="meetings-connect-calendar"]', "Couldn't open the browser. Try again.", "[meetings] open calendar connect URL failed"],
  ])("%s failure toasts plain copy and logs the raw error", async (_n, selector, copy, tag) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    await render(async () => {
      throw err;
    });
    host.querySelector<HTMLButtonElement>(selector)!.click();
    await vi.waitFor(() => expect(toastText()).toContain(copy));
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith(tag, err);
    warn.mockRestore();
  });

  it("joining the up-next meeting toasts plain copy and logs the raw error", async () => {
    const start = new Date(Date.now() + 10 * 60_000).toISOString();
    const end = new Date(Date.now() + 40 * 60_000).toISOString();
    call.mockImplementation((method: string) => {
      if (method === "listUpcoming") {
        return Promise.resolve(
          ok([
            {
              id: "evt_1",
              summary: "Standup",
              start: { dateTime: start },
              end: { dateTime: end },
              startTime: start,
              endTime: end,
              hangoutLink: "https://meet.google.com/abc-defg-hij",
            },
          ]),
        );
      }
      if (method === "listCalendars") return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
      return Promise.resolve(ok([]));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    await render(async () => {
      throw err;
    });
    await vi.waitFor(() => expect(host.querySelector(".next-join")).not.toBeNull(), { timeout: 3000 });
    host.querySelector<HTMLButtonElement>(".next-join")!.click();
    await vi.waitFor(() => expect(toastText()).toContain("Couldn't open the meeting. Try again."));
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[meetings] open meeting link failed", err);
    warn.mockRestore();
  });

  it("a failed calendar connect request toasts plain copy, not the server JSON body", async () => {
    const BODY = '[invoke] connect_calendar failed: {"error":"boom: upstream oauth exploded"}';
    call.mockImplementation((method: string) => {
      if (method === "connectCalendar") return Promise.resolve(failure("invoke", BODY));
      if (method === "listCalendars") return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
      return Promise.resolve(ok([]));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await render(async () => {});
    host.querySelector<HTMLButtonElement>('[data-testid="meetings-connect-calendar"]')!.click();
    await vi.waitFor(() => expect(toastText()).toContain("Couldn't start calendar connect."));
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[meetings] request failed", expect.stringContaining("boom"));
    warn.mockRestore();
  });
});
