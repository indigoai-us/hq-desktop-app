// @vitest-environment happy-dom
/**
 * OWNER-R3: invite the notetaker to a meeting. The upcoming meeting toolbar
 * offers Invite notetaker (and Remove notetaker with plain status once one is
 * scheduled); the Meetings header + opens one link field. The store actions
 * are mocked; no real route is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { MeetingEvent, ScheduledBot } from "./meetings-model";

const store = vi.hoisted(() => ({
  pendingActionsByEventId: new Map<string, string>(),
  inviteBot: vi.fn(),
  cancelBot: vi.fn(),
  inviteBotByUrl: vi.fn(),
  scheduledBots: [] as ScheduledBot[],
}));
vi.mock("./meetings-store.svelte", () => ({ meetingsStore: store }));

import NotetakerControl from "./NotetakerControl.svelte";
import InviteNotetakerSheet from "./InviteNotetakerSheet.svelte";
import MeetingsSidepane from "./MeetingsSidepane.svelte";
import { EMPTY_MEETINGS_FILTER } from "./meetings-rail-model";
import { notetakerLinkProblem, notetakerStatus } from "./notetaker-invite";

const event: MeetingEvent = {
  id: "review",
  summary: "Flow review",
  status: "confirmed",
  start: { dateTime: new Date(2026, 9, 3, 15).toISOString() },
  end: { dateTime: new Date(2026, 9, 3, 15, 30).toISOString() },
  meetingUrl: "https://zoom.us/j/123",
};
const scheduled: ScheduledBot = {
  botId: "b1",
  meetingUrl: "https://zoom.us/j/123",
  platform: "zoom",
  status: "scheduled",
  calendarEventId: "review",
  autoScheduled: false,
};

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
});
beforeEach(() => {
  store.pendingActionsByEventId = new Map();
  store.inviteBot.mockReset();
  store.cancelBot.mockReset();
  store.inviteBotByUrl.mockReset();
  store.scheduledBots = [];
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(component: any, props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

function q<T extends Element = HTMLElement>(el: ParentNode, id: string): T | null {
  return el.querySelector<T>(`[data-testid="${id}"]`);
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("OWNER-R3 notetaker words", () => {
  it("validates a pasted link in plain words", () => {
    expect(notetakerLinkProblem("")).toBeNull();
    expect(notetakerLinkProblem("zoom.us/j/1")).toBe("Paste the full link, starting with https://.");
    expect(notetakerLinkProblem("https://example.com/x")).toBe("That isn't a Zoom, Google Meet, Teams, or Webex meeting link.");
    expect(notetakerLinkProblem("https://meet.google.com/abc-defg-hij")).toBeNull();
    expect(notetakerLinkProblem("https://teams.microsoft.com/l/meetup-join/19%3Ameeting")).toBeNull();
  });

  it("describes the notetaker status in plain words", () => {
    expect(notetakerStatus(undefined)).toEqual({ label: "", action: "invite" });
    expect(notetakerStatus(scheduled)).toEqual({ label: "Notetaker invited", action: "remove" });
    expect(notetakerStatus({ ...scheduled, status: "recording" })).toEqual({ label: "Notetaker is in the meeting", action: "remove" });
    expect(notetakerStatus({ ...scheduled, status: "processing" })).toEqual({ label: "Notetaker is saving the notes", action: "none" });
    expect(notetakerStatus({ ...scheduled, status: "failed", failureReason: "Zoom requires sign-in." })).toEqual({
      label: "Notetaker couldn't join", action: "invite", detail: "Zoom requires sign-in.",
    });
    expect(notetakerStatus({ ...scheduled, status: "failed" })).toEqual({
      label: "Notetaker couldn't join", action: "invite", detail: "The notetaker couldn't join this meeting.",
    });
  });
});

describe("OWNER-R3 Invite notetaker on an upcoming meeting", () => {
  it("invites through the existing store action", async () => {
    store.inviteBot.mockResolvedValue({ kind: "info", text: "Bot invited." });
    const el = render(NotetakerControl, { event, url: event.meetingUrl });
    const button = q<HTMLButtonElement>(el, "meeting-notetaker-invite")!;
    expect(button.textContent).toBe("Invite notetaker");
    button.click();
    await settle();
    expect(store.inviteBot).toHaveBeenCalledWith(event);
    expect(q(el, "meeting-notetaker-failed")).toBeNull();
  });

  it("is disabled with a reason when the meeting has no link", () => {
    const el = render(NotetakerControl, { event: { ...event, meetingUrl: null }, url: "" });
    const button = q<HTMLButtonElement>(el, "meeting-notetaker-invite")!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("This meeting has no link to send the notetaker to");
  });

  it("shows Inviting… while the row is pending", () => {
    store.pendingActionsByEventId = new Map([["review", "invite"]]);
    const el = render(NotetakerControl, { event, url: event.meetingUrl });
    const button = q<HTMLButtonElement>(el, "meeting-notetaker-invite")!;
    expect(button.textContent).toBe("Inviting…");
    expect(button.disabled).toBe(true);
  });

  it("shows a plain failure with Try again, which retries", async () => {
    store.inviteBot.mockResolvedValueOnce({ kind: "warn", text: "Server hiccup — try again in a moment." });
    const el = render(NotetakerControl, { event, url: event.meetingUrl });
    q<HTMLButtonElement>(el, "meeting-notetaker-invite")!.click();
    await settle();
    expect(q(el, "meeting-notetaker-failed")?.textContent).toBe("Server hiccup — try again in a moment.");
    store.inviteBot.mockResolvedValueOnce({ kind: "info", text: "Bot invited." });
    q<HTMLButtonElement>(el, "meeting-notetaker-retry")!.click();
    await settle();
    expect(store.inviteBot).toHaveBeenCalledTimes(2);
    expect(q(el, "meeting-notetaker-failed")).toBeNull();
  });

  it("shows the status and removes a scheduled notetaker", async () => {
    store.cancelBot.mockResolvedValue({ kind: "info", text: "Bot uninvited." });
    const el = render(NotetakerControl, { event, bot: scheduled, url: event.meetingUrl });
    expect(q(el, "meeting-notetaker-status")?.textContent).toBe("Notetaker invited");
    expect(q(el, "meeting-notetaker-invite")).toBeNull();
    q<HTMLButtonElement>(el, "meeting-notetaker-remove")!.click();
    await settle();
    expect(store.cancelBot).toHaveBeenCalledWith(event);
  });

  it("renders the failed join reason with a retry action", () => {
    const failed = { ...scheduled, status: "failed", failureReason: "Zoom requires sign-in." };
    const el = render(NotetakerControl, { event, bot: failed, url: event.meetingUrl });
    expect(q(el, "meeting-notetaker-status")?.textContent).toBe("Notetaker couldn't join");
    expect(q(el, "meeting-notetaker-detail")?.textContent).toBe("Zoom requires sign-in.");
    expect(q<HTMLButtonElement>(el, "meeting-notetaker-invite")?.textContent).toContain("Try again");
  });
});

describe("OWNER-R3 Invite notetaker to a meeting (header +)", () => {
  it("the header + is labeled Invite notetaker to a meeting and opens the sheet", () => {
    const oninvite = vi.fn();
    const el = render(MeetingsSidepane, {
      sections: [],
      events: [],
      companyNamesByUid: new Map(),
      selectedId: null,
      filter: EMPTY_MEETINGS_FILTER,
      oninvite,
    });
    const plus = q<HTMLButtonElement>(el, "meetings-invite-notetaker")!;
    expect(plus.getAttribute("aria-label")).toBe("Invite notetaker to a meeting");
    plus.click();
    expect(oninvite).toHaveBeenCalledTimes(1);
  });

  it("has one link field, validates it, and invites on confirm", async () => {
    let resolve: (v: unknown) => void = () => {};
    store.inviteBotByUrl.mockReturnValue(new Promise((r) => (resolve = r)));
    const el = render(InviteNotetakerSheet, { onclose: vi.fn() });
    const sheet = q(el, "invite-notetaker-sheet")!;
    expect(sheet.querySelectorAll("input, textarea, select")).toHaveLength(1);
    const confirm = q<HTMLButtonElement>(el, "invite-notetaker-confirm")!;
    expect(confirm.disabled).toBe(true);
    type(q<HTMLInputElement>(el, "invite-notetaker-link")!, "https://example.com/x");
    expect(q(el, "invite-notetaker-problem")?.textContent).toContain("isn't a Zoom");
    expect(confirm.disabled).toBe(true);
    type(q<HTMLInputElement>(el, "invite-notetaker-link")!, " https://zoom.us/j/999 ");
    expect(q(el, "invite-notetaker-problem")).toBeNull();
    confirm.click();
    flushSync();
    expect(store.inviteBotByUrl).toHaveBeenCalledWith("https://zoom.us/j/999", null);
    expect(q<HTMLButtonElement>(el, "invite-notetaker-confirm")!.textContent?.trim()).toBe("Inviting…");
    resolve({ kind: "info", text: "Bot invited — meeting will save to Personal." });
    await settle();
    expect(q(el, "invite-notetaker-done")?.textContent).toContain("Notetaker invited.");
  });

  it("shows a plain failure and Try again calls the invite again", async () => {
    store.inviteBotByUrl.mockResolvedValueOnce({ kind: "warn", text: "Couldn't invite the bot." });
    const el = render(InviteNotetakerSheet, { onclose: vi.fn() });
    type(q<HTMLInputElement>(el, "invite-notetaker-link")!, "https://meet.google.com/abc-defg-hij");
    q<HTMLButtonElement>(el, "invite-notetaker-confirm")!.click();
    await settle();
    expect(q(el, "invite-notetaker-failed")?.textContent).toBe("Couldn't invite the bot.");
    const retry = q<HTMLButtonElement>(el, "invite-notetaker-confirm")!;
    expect(retry.textContent?.trim()).toBe("Try again");
    store.inviteBotByUrl.mockResolvedValueOnce({ kind: "info", text: "ok" });
    retry.click();
    await settle();
    expect(store.inviteBotByUrl).toHaveBeenCalledTimes(2);
    expect(q(el, "invite-notetaker-done")).not.toBeNull();
  });

  it("shows the server's terminal join reason after an invite refresh", async () => {
    store.scheduledBots = [{ ...scheduled, status: "failed", failureReason: "Zoom requires sign-in." }];
    store.inviteBotByUrl.mockResolvedValueOnce({ kind: "info", text: "Notetaker invited." });
    const el = render(InviteNotetakerSheet, { onclose: vi.fn() });
    type(q<HTMLInputElement>(el, "invite-notetaker-link")!, scheduled.meetingUrl);
    q<HTMLButtonElement>(el, "invite-notetaker-confirm")!.click();
    await settle();
    expect(q(el, "invite-notetaker-failed")?.textContent).toBe("Zoom requires sign-in.");
  });

  it("clears an earlier terminal failure when a retry is active", async () => {
    store.scheduledBots = [
      { ...scheduled, botId: "failed", status: "failed", failureReason: "Zoom requires sign-in." },
      { ...scheduled, botId: "retry", status: "scheduled" },
    ];
    store.inviteBotByUrl.mockResolvedValueOnce({ kind: "info", text: "Notetaker invited." });
    const el = render(InviteNotetakerSheet, { onclose: vi.fn() });
    type(q<HTMLInputElement>(el, "invite-notetaker-link")!, scheduled.meetingUrl);
    q<HTMLButtonElement>(el, "invite-notetaker-confirm")!.click();
    await settle();
    expect(q(el, "invite-notetaker-done")).not.toBeNull();
  });
});
