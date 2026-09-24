// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import {
  failure,
  ok,
  unavailable,
  type AdapterResult,
  type PlatformAdapter,
} from "@hq/platform";

import MeetingsPage from "./MeetingsPage.svelte";
import {
  configureMeetingsApi,
  meetingsStore,
  stopMeetingsStore,
} from "./meetings-store.svelte";

const upgradeUrl = "https://hq.computer/companies/acme/billing?upgrade=team";
const call = vi.fn<(method: string, payload?: unknown) => Promise<AdapterResult<unknown>>>();

const api = {
  listMemberships: () => call("listMemberships") as never,
  listUpcoming: () => call("listUpcoming") as never,
  listScheduledBots: () => call("listScheduledBots") as never,
  inviteBot: (payload: unknown) => call("inviteBot", payload) as never,
  cancelBot: (id: string) => call("cancelBot", id) as never,
  joinBotNow: (payload: unknown) => call("joinBotNow", payload) as never,
  listAccounts: () => call("listAccounts") as never,
  listCalendars: (accountId: string) => call("listCalendars", accountId) as never,
  connectCalendar: () => call("connectCalendar") as never,
  disconnectCalendar: (accountId: string) => call("disconnectCalendar", accountId) as never,
  permissionsState: () => Promise.resolve(unavailable("desktop-only")) as never,
  openPermissionsSetup: () => call("openPermissionsSetup") as never,
};

function fakeAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    meetings: api,
    feedback: { submitBugReport: () => call("submitBugReport") as never },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  call.mockReset();
  call.mockImplementation((method: string) => {
    if (method === "listCalendars") {
      return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
    }
    if (
      method === "listMemberships" ||
      method === "listUpcoming" ||
      method === "listScheduledBots" ||
      method === "listAccounts"
    ) {
      return Promise.resolve(ok([]));
    }
    if (method === "inviteBot") {
      return Promise.resolve(
        failure(
          "http-402",
          `bot/invite HTTP 402: {"code":"MEETING_PLAN_REQUIRED","upgradeUrl":"${upgradeUrl}"}`,
        ),
      );
    }
    throw new Error(`Unexpected api call: ${method}`);
  });
  localStorage.clear();
  stopMeetingsStore();
  meetingsStore.stopCalendarConnectWatch();
  configureMeetingsApi({
    meetings: api,
    feedback: { submitBugReport: () => call("submitBugReport") as never },
  });
});

afterEach(async () => {
  meetingsStore.stopCalendarConnectWatch();
  stopMeetingsStore();
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("MeetingsPage plan-required action", () => {
  it("shows and opens the server billing URL from the routed Meetings page", async () => {
    let finishOpen!: () => void;
    const openExternalResult = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const openExternal = vi.fn((_url: string) => openExternalResult);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MeetingsPage, {
      target: host,
      props: { adapter: fakeAdapter(), openExternal, storage: null },
    });
    await tick();

    const input = host.querySelector<HTMLInputElement>(
      '[aria-label="Paste a meeting URL to send the recording bot"]',
    );
    expect(input).not.toBeNull();
    input!.value = "https://meet.google.com/abc-defg-hij";
    input!.dispatchEvent(new Event("input", { bubbles: true }));

    const invite = host.querySelector<HTMLButtonElement>(
      '[data-testid="meetings-url-invite"]',
    );
    await vi.waitFor(() => expect(invite?.disabled).toBe(false));
    invite!.click();

    const upgrade = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>(
        '[data-testid="meetings-plan-upgrade"]',
      );
      expect(button?.textContent).toBe("Upgrade");
      return button!;
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "Meetings need HQ Workforce ($500/mo)",
    );
    upgrade.click();
    await vi.waitFor(() => expect(upgrade.disabled).toBe(true));
    expect(upgrade.textContent).toBe("Opening…");
    upgrade.click();
    expect(openExternal).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(upgradeUrl));
    finishOpen();
    await vi.waitFor(() => expect(upgrade.disabled).toBe(false));
    expect(call).toHaveBeenCalledWith("inviteBot", {
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      calendarEventId: null,
      calendarSeriesId: null,
      companyId: null,
    });
  });
});
