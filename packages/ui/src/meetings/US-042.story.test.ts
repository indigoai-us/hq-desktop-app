// @vitest-environment happy-dom
/**
 * US-042: Meetings toolbar calendar chip and paste-a-link (storyboard
 * revision 10). Chip states, link detection and matching, the no-calendar
 * first-run canvas, and the New meeting Link field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { GoogleAccount, MeetingEvent } from "./meetings-model";

const store = vi.hoisted(() => ({
  accounts: [] as GoogleAccount[],
  events: [] as MeetingEvent[],
  initialLoadPending: false,
  fetchError: null as string | null,
  connectPending: false,
  lastSyncedAt: 0,
  accountEmailById: new Map<string, string>(),
  disconnectPendingByAccountId: new Set<string>(),
  beginCalendarConnect: vi.fn(),
  stopCalendarConnectWatch: vi.fn(),
  disconnectCalendar: vi.fn(),
  inviteBotByUrl: vi.fn(),
}));
vi.mock("./meetings-store.svelte", () => ({ meetingsStore: store }));

import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import MeetingsToolbarControls from "./MeetingsToolbarControls.svelte";
import { calendarChipLabel, detectMeetingProvider, matchUpcomingMeeting, zoomMeetingLabel } from "./meeting-link";
import { draftToEvent, emptyNewMeetingDraft } from "./meeting-states-model";

const now = new Date(2026, 9, 1, 10, 12);
const flow: MeetingEvent = {
  id: "flow",
  summary: "LiveRecover flow v2 review",
  status: "confirmed",
  start: { dateTime: new Date(2026, 9, 1, 11).toISOString() },
  end: { dateTime: new Date(2026, 9, 1, 11, 30).toISOString() },
  meetingUrl: "https://zoom.us/j/88412290117?pwd=abc",
};
const zoom = "https://zoom.us/j/88412290117?pwd=abc";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
});
beforeEach(() => {
  store.accounts = [];
  store.events = [];
  store.initialLoadPending = false;
  store.fetchError = null;
  store.inviteBotByUrl.mockReset().mockResolvedValue({ kind: "info", text: "Notetaker invited." });
  store.beginCalendarConnect.mockReset();
});

function render(component: unknown, props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(component as never, { target, props: props as never }));
  flushSync();
  return target;
}

async function opened(el: HTMLElement, testId: string): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    if (!el.querySelector(`[data-testid="${testId}"]`)) throw new Error(`${testId} not loaded`);
  }, { timeout: 5000 });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
  flushSync();
}

describe("US-042 calendar chip", () => {
  it("reads No calendar with no account and the provider plus count when connected", () => {
    expect(calendarChipLabel([])).toEqual({ connected: false, provider: "No calendar", count: "" });
    expect(calendarChipLabel([{ accountId: "a1" }])).toEqual({ connected: true, provider: "Google", count: "1 account" });
    expect(calendarChipLabel([{ accountId: "a1" }, { accountId: "a2" }]).count).toBe("2 accounts");

    const off = render(MeetingsToolbarControls, {});
    expect(off.querySelector('[data-testid="meetings-calendar-chip"]')?.textContent).toContain("No calendar");
    store.accounts = [{ accountId: "a1", email: "corey@getindigo.ai" }];
    const on = render(MeetingsToolbarControls, {});
    const chip = on.querySelector('[data-testid="meetings-calendar-chip"]') as HTMLButtonElement;
    expect(chip.dataset.connected).toBe("true");
    expect(chip.textContent).toContain("Google");
    expect(chip.textContent).toContain("1 account");
  });

  it("paints a skeleton on click, then the panel with Google, Microsoft, and the recap note", async () => {
    store.accounts = [{ accountId: "a1", email: "corey@getindigo.ai" }];
    const el = render(MeetingsToolbarControls, {});
    (el.querySelector('[data-testid="meetings-calendar-chip"]') as HTMLButtonElement).click();
    flushSync();
    expect(el.querySelector('[data-testid="meetings-toolbar-skeleton"]')).not.toBeNull();
    await opened(el, "calendar-connect-google");
    const panel = el.querySelector('[data-testid="meetings-calendar-panel"]')!;
    expect(panel.textContent).toContain("corey@getindigo.ai");
    expect(panel.querySelector('[data-testid="calendar-connect-google"]')?.textContent).toContain("Reconnect");
    expect(panel.querySelector('[data-testid="calendar-provider-microsoft"]')?.textContent).toContain("Connect");
    expect(panel.textContent).toContain("Connect another account");
    expect(panel.textContent).toContain("Disconnect corey@getindigo.ai");
    expect(panel.textContent).toContain("recaps stay");
    expect(panel.textContent).not.toContain("Manage in console");
  });

  it("Connect starts the existing Google OAuth path and opens the consent page", async () => {
    store.beginCalendarConnect.mockResolvedValue({ url: "https://accounts.google.com/o/oauth2/x", toast: null });
    const openExternal = vi.fn();
    const el = render(MeetingsToolbarControls, { openExternal });
    (el.querySelector('[data-testid="meetings-calendar-chip"]') as HTMLButtonElement).click();
    await opened(el, "calendar-connect-google");
    (el.querySelector('[data-testid="calendar-connect-google"]') as HTMLButtonElement).click();
    await settle();
    expect(store.beginCalendarConnect).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/x");
  });
});

describe("US-042 paste detection", () => {
  it("detects Zoom, Meet, and Teams and rejects other links", () => {
    expect(detectMeetingProvider(zoom)).toBe("zoom");
    expect(detectMeetingProvider("https://us02web.zoom.us/j/123456789")).toBe("zoom");
    expect(detectMeetingProvider("https://meet.google.com/abc-defg-hij")).toBe("meet");
    expect(detectMeetingProvider("https://teams.microsoft.com/l/meetup-join/19%3Ameeting_N2E")).toBe("teams");
    expect(detectMeetingProvider("https://example.com/j/1")).toBeNull();
    expect(detectMeetingProvider("zoom.us/j/1")).toBeNull();
    expect(zoomMeetingLabel(zoom)).toBe("Meeting 884 1229 0117");
  });

  it("matches the upcoming meeting with the same room and ignores ended ones", () => {
    expect(matchUpcomingMeeting("https://zoom.us/j/88412290117", [flow], now)?.id).toBe("flow");
    const after = new Date(2026, 9, 1, 12);
    expect(matchUpcomingMeeting(zoom, [flow], after)).toBeNull();
    expect(matchUpcomingMeeting("https://zoom.us/j/1234567890", [flow], now)).toBeNull();
  });

  it("paste box shows the provider and match, offers the attach list, and Join now opens the link", async () => {
    // The box reads the wall clock, so this meeting starts 48 minutes from now.
    const start = Date.now() + 48 * 60_000;
    store.events = [{ ...flow, start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 30 * 60_000).toISOString() } }];
    const openExternal = vi.fn();
    const el = render(MeetingsToolbarControls, { openExternal });
    (el.querySelector('[data-testid="meetings-paste-link"]') as HTMLButtonElement).click();
    flushSync();
    expect(el.querySelector('[data-testid="meetings-toolbar-skeleton"]')).not.toBeNull();
    await opened(el, "paste-link-input");
    const input = el.querySelector('[data-testid="paste-link-input"]') as HTMLInputElement;
    input.value = zoom;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(el.querySelector('[data-testid="paste-link-provider"]')?.textContent).toBe("Zoom");
    expect(el.querySelector('[data-testid="paste-link-detect"]')?.textContent).toContain("LiveRecover flow v2 review");
    (el.querySelector('[data-testid="paste-link-attach"]') as HTMLButtonElement).click();
    flushSync();
    const list = el.querySelector('[data-testid="paste-link-attach-list"]')!;
    expect(list.textContent).toContain("suggested");
    expect(list.textContent).toContain("New meeting with this link");
    (el.querySelector('[data-testid="paste-link-join"]') as HTMLButtonElement).click();
    await settle();
    expect(openExternal).toHaveBeenCalledWith(zoom);
    expect(store.inviteBotByUrl).toHaveBeenCalledWith(zoom, null);
  });
});

describe("US-042 no-calendar canvas", () => {
  it("shows the connect state with Google, Microsoft, and a paste box; Join opens a Zoom link", async () => {
    const openExternal = vi.fn();
    const el = render(MeetingsStatesBody, { mode: "empty", sections: [], now, openExternal });
    const state = el.querySelector('[data-testid="meetings-no-calendar"]')!;
    expect(state.textContent).toContain("Connect your calendar to see meetings here");
    expect(state.querySelector('[data-testid="no-calendar-connect-google"]')?.textContent).toContain("Connect Google");
    expect(state.querySelector('[data-testid="no-calendar-connect-microsoft"]')?.textContent).toContain("Connect Microsoft");
    expect(el.querySelector('[data-testid="meetings-calendar-chip"]')?.textContent).toContain("No calendar");
    const input = state.querySelector('[data-testid="no-calendar-paste-input"]') as HTMLInputElement;
    input.value = zoom;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(state.querySelector('[data-testid="no-calendar-paste-provider"]')?.textContent).toBe("Zoom");
    (state.querySelector('[data-testid="no-calendar-paste-join"]') as HTMLButtonElement).click();
    await settle();
    expect(openExternal).toHaveBeenCalledWith(zoom);
  });

  it("hides the connect state once an account is linked or while the first load is pending", () => {
    store.accounts = [{ accountId: "a1" }];
    const linked = render(MeetingsStatesBody, { mode: "empty", sections: [], now });
    expect(linked.querySelector('[data-testid="meetings-no-calendar"]')).toBeNull();
    store.accounts = [];
    store.initialLoadPending = true;
    const loading = render(MeetingsStatesBody, { mode: "empty", sections: [], now });
    expect(loading.querySelector('[data-testid="meetings-no-calendar"]')).toBeNull();
  });
});

describe("US-042 New meeting link field", () => {
  it("offers New Zoom, New Meet, Paste link, None; pasting selects Paste link and shows the provider", () => {
    store.accounts = [{ accountId: "a1" }];
    const el = render(MeetingsStatesBody, { mode: "empty", sheetOpen: true, sections: [], now });
    const tabs = el.querySelector('[data-testid="link-tabs"]')!;
    expect([...tabs.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["New Zoom", "New Meet", "Paste link", "None"]);
    const sheet = el.querySelector('[data-testid="new-meeting-sheet"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_N2E" } });
    sheet.dispatchEvent(paste);
    flushSync();
    expect(tabs.querySelector('[aria-pressed="true"]')?.textContent).toBe("Paste link");
    expect(el.querySelector('[data-testid="sheet-paste-provider"]')?.textContent).toContain("Teams");
    expect((el.querySelector('[data-testid="sheet-paste-input"]') as HTMLInputElement).value).toContain("teams.microsoft.com");
  });

  it("seeds the sheet from New meeting with this link and keeps the room as is", () => {
    store.accounts = [{ accountId: "a1" }];
    const el = render(MeetingsStatesBody, { mode: "empty", sheetOpen: true, sheetLink: zoom, sections: [], now });
    expect(el.querySelector('[data-testid="link-tabs"] [aria-pressed="true"]')?.textContent).toBe("Paste link");
    const draft = { ...emptyNewMeetingDraft(now), title: "Sync", link: "paste" as const, pastedUrl: zoom };
    expect(draftToEvent(draft, "x")?.meetingUrl).toBe(zoom);
  });
});

describe("New meeting sheet Escape (QA-017)", () => {
  it("asks the host to close the sheet on Escape", () => {
    store.accounts = [{ accountId: "a1" }];
    const oncloseSheet = vi.fn();
    render(MeetingsStatesBody, { mode: "empty", sheetOpen: true, sections: [], now, oncloseSheet });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(oncloseSheet).toHaveBeenCalledTimes(1);
  });
});

describe("Later today rows (design lane 8 broken click)", () => {
  it("selects the meeting when a Later today row is clicked", () => {
    const row = (id: string, time: string, title: string) => ({
      id, title, time, companyUid: null, companyMark: null, live: false, hasRecap: false, hasRecording: false,
    });
    const onselect = vi.fn();
    const el = render(MeetingsStatesBody, {
      mode: "empty",
      now,
      onselect,
      sections: [{ id: "today", label: "Today", rows: [row("a", "11:00", "Creative review"), row("b", "15:30", "Standup")] }],
    });
    const later = el.querySelector<HTMLButtonElement>("button.later");
    expect(later?.textContent).toContain("Standup");
    later!.click();
    expect(onselect).toHaveBeenCalledWith("b");
  });
});
