// @vitest-environment happy-dom

// The paste-a-link "Save bot to" company picker sits in the meetings page,
// which clips overflow. Like the live meeting picker, its list must open
// outside the page so every company shows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, unavailable, type AdapterResult, type PlatformAdapter } from "@hq/platform";

import MeetingsPage from "./MeetingsPage.svelte";
import InviteNotetakerSheet from "./InviteNotetakerSheet.svelte";
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
    expect(labels).toEqual(["Choose a company", "Indigo", "Holler", "Frogbear"]);

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(document.querySelector('[data-testid="url-invite-company-menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  function typeUrl(value: string): void {
    const input = host.querySelector<HTMLInputElement>(".url-input")!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function mountPage(): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MeetingsPage, { target: host, props: { adapter: fakeAdapter() } });
  }

  // Regression (PR #1674 review): the URL input defaulted to Personal, which
  // hq-pro always refuses with the HQ Workforce prompt.
  it("does not invite as Personal: with several companies Invite waits for a pick", async () => {
    mountPage();
    await vi.waitFor(() => expect(meetingsStore.companyNamesByUid.size).toBe(3));
    typeUrl("https://zoom.us/j/123");
    await tick();
    const invite = host.querySelector<HTMLButtonElement>('[data-testid="meetings-url-invite"]')!;
    expect(invite.disabled).toBe(true);
    invite.click();
    await tick();
    expect(call).not.toHaveBeenCalledWith("inviteBot");
  });

  it("invites to the sole company when the user has one", async () => {
    call.mockImplementation((method: string) => {
      if (method === "listMemberships") {
        return Promise.resolve(ok([{ companyUid: "co-indigo", companyName: "Indigo", status: "active" }]));
      }
      if (method === "inviteBot") return Promise.resolve(ok({ botId: "b1" }));
      if (method === "listAccounts" || method === "listUpcoming" || method === "listScheduledBots") {
        return Promise.resolve(ok([]));
      }
      if (method === "listCalendars") return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
      throw new Error(`Unexpected api call: ${method}`);
    });
    const spy = vi.spyOn(meetingsStore, "inviteBotByUrl");
    mountPage();
    await vi.waitFor(() => expect(meetingsStore.companyNamesByUid.size).toBe(1));
    typeUrl("https://zoom.us/j/123");
    await tick();
    const invite = host.querySelector<HTMLButtonElement>('[data-testid="meetings-url-invite"]')!;
    expect(invite.disabled).toBe(false);
    invite.click();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("https://zoom.us/j/123", "co-indigo"));
    spy.mockRestore();
  });
});

// Regression (PR #1674 review): the sheet chose its company once at open, so
// memberships that arrived later left Invite disabled with no picker.
describe("Invite notetaker sheet with memberships that load late", () => {
  it("preselects the sole company once the list arrives", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    call.mockImplementation(async (method: string) => {
      if (method === "listMemberships") {
        await gate;
        return ok([{ companyUid: "co-indigo", companyName: "Indigo", status: "active" }]);
      }
      if (method === "listAccounts" || method === "listUpcoming" || method === "listScheduledBots") return ok([]);
      throw new Error(`Unexpected api call: ${method}`);
    });
    // Start from an empty store: a new session generation resets the tenant
    // session, which clears the companies an earlier test loaded.
    localStorage.clear();
    configureMeetingsApi({
      meetings: meetingsApi(),
      feedback: { submitBugReport: () => call("submitBugReport") as never },
      sessionGeneration: 1674,
    });
    const spy = vi.spyOn(meetingsStore, "inviteBotByUrl").mockResolvedValue({ kind: "info", text: "ok" });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(InviteNotetakerSheet, { target: host, props: { onclose: () => {} } });
    const refreshing = meetingsStore.refresh(true);
    const link = host.querySelector<HTMLInputElement>('[data-testid="invite-notetaker-link"]')!;
    link.value = "https://zoom.us/j/999";
    link.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const confirm = () => host.querySelector<HTMLButtonElement>('[data-testid="invite-notetaker-confirm"]')!;
    expect(meetingsStore.companyNamesByUid.size).toBe(0);
    expect(confirm().disabled).toBe(true);

    release();
    await refreshing;
    await tick();
    expect(meetingsStore.companyNamesByUid.size).toBe(1);
    expect(confirm().disabled).toBe(false);
    confirm().click();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("https://zoom.us/j/999", "co-indigo"));
    spy.mockRestore();
  });
});
