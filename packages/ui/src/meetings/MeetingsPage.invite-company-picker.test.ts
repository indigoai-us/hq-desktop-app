// @vitest-environment happy-dom

// The paste-a-link "Save bot to" company picker sits in the meetings page,
// which clips overflow. Like the live meeting picker, its list must open
// outside the page so every company shows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, unavailable, type AdapterResult, type PlatformAdapter } from "@hq/platform";

import MeetingsPage from "./MeetingsPage.svelte";
import {
  configureMeetingsApi,
  meetingsStore,
  stopMeetingsStore,
} from "./meetings-store.svelte";

const call =
  vi.fn<
    (method: string, payload?: unknown) => Promise<AdapterResult<unknown>>
  >();

function meetingsApi() {
  return {
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
  };
}

function fakeAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    meetings: meetingsApi(),
    feedback: { submitBugReport: () => call("submitBugReport") as never },
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
    if (method === "listMemberships") {
      return Promise.resolve(
        ok([
          { companyUid: "co-indigo", companyName: "Indigo", status: "active" },
          { companyUid: "co-holler", companyName: "Holler", status: "active" },
          { companyUid: "co-frogbear", companyName: "Frogbear", status: "active" },
        ]),
      );
    }
    if (method === "listAccounts" || method === "listUpcoming" || method === "listScheduledBots") {
      return Promise.resolve(ok([]));
    }
    if (method === "listCalendars") {
      return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
    }
    throw new Error(`Unexpected api call: ${method}`);
  });
  stopMeetingsStore();
  configureMeetingsApi({
    meetings: meetingsApi(),
    feedback: { submitBugReport: () => call("submitBugReport") as never },
  });
});

afterEach(async () => {
  stopMeetingsStore();
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("MeetingsPage paste-a-link company picker", () => {
  it("opens the list outside the page with every company", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MeetingsPage, { target: host, props: { adapter: fakeAdapter() } });
    await vi.waitFor(() => expect(meetingsStore.companyNamesByUid.size).toBe(3));

    const input = host.querySelector<HTMLInputElement>(".url-input")!;
    input.value = "https://zoom.us/j/123";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const button = await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>('[data-testid="url-invite-company"]');
      if (!el) throw new Error("picker not loaded");
      return el;
    });

    button.click();
    await tick();
    await tick();
    const menu = document.querySelector<HTMLElement>('[data-testid="url-invite-company-menu"]')!;
    expect(menu).not.toBeNull();
    expect(host.querySelector(".meetings")?.contains(menu)).toBe(false);
    expect(menu.style.position).toBe("fixed");
    const labels = [...menu.querySelectorAll('[role="option"] .dd-label')].map((o) => o.textContent);
    expect(labels).toEqual(["Personal", "Indigo", "Holler", "Frogbear"]);

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(document.querySelector('[data-testid="url-invite-company-menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
