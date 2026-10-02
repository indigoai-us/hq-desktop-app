// @vitest-environment happy-dom
/**
 * US-022: a past row opens the recap with Summary, Decisions, and Action items.
 * Transcript stays in-app. Upcoming Join follows the 10-minute lead. The new
 * meeting sheet has the storyboard fields.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import { defaultMeetingId, meetingsRailSections } from "./meetings-rail-model";
import { draftToEvent, emptyNewMeetingDraft, joinAvailable, meetingPhase, recapModel } from "./meeting-states-model";
import type { MeetingEvent } from "./meetings-model";

const now = new Date(2026, 9, 1, 10, 14);
const past: MeetingEvent = {
  id: "standup",
  summary: "Indigo dev standup",
  status: "confirmed",
  start: { dateTime: new Date(2026, 8, 30, 10).toISOString() },
  end: { dateTime: new Date(2026, 8, 30, 10, 31).toISOString() },
  meetingUrl: "https://zoom.us/j/1",
  signals: {
    summary: "Welcome v2 ships Thursday. Atlas is the landing page.",
    decisions: [{ id: "d1", title: "Atlas is the company landing", owner: "Corey", when: "10:21" }],
    actions: [{ id: "a1", title: "Patch the create-time seam", owner: "Eric B.", status: "Open" }],
    questions: [{ id: "q1", title: "Charge on activation or first run?", status: "Unanswered" }],
    transcript: [{ id: "t1", at: "10:02", speaker: "Corey", text: "Atlas becomes the company landing.", signal: "Decision" }],
  },
  notes: [{ id: "n1", author: "deacon", text: "Notes file line." }],
};
const soon: MeetingEvent = {
  id: "flow",
  summary: "Flow review",
  status: "confirmed",
  start: { dateTime: new Date(2026, 9, 1, 10, 20).toISOString() },
  end: { dateTime: new Date(2026, 9, 1, 10, 50).toISOString() },
  meetingUrl: "https://zoom.us/j/2",
  outline: [{ id: "o1", title: "Rail order" }],
};
const later: MeetingEvent = {
  id: "copy",
  summary: "Nestlé copy sync",
  status: "confirmed",
  start: { dateTime: new Date(2026, 9, 1, 13, 30).toISOString() },
  end: { dateTime: new Date(2026, 9, 1, 14).toISOString() },
  meetingUrl: "https://meet.google.com/abc-defg-hij",
};

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

function render(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(MeetingsStatesBody, { target, props: props as never }));
  flushSync();
  return target;
}

describe("US-022 meeting states", () => {
  it("shows Summary, Decisions, and Action items for a past meeting", () => {
    expect(meetingPhase(past, now)).toBe("past");
    const model = recapModel(past);
    expect(model.summary).toContain("Welcome v2");
    expect(model.decisions).toHaveLength(1);
    expect(model.actions).toHaveLength(1);
    const el = render({ mode: "recap", event: past, now });
    const recap = el.querySelector('[data-testid="meeting-recap"]');
    expect(recap?.textContent).toContain("Summary");
    expect(recap?.textContent).toContain("Decisions");
    expect(recap?.textContent).toContain("Action items");
    expect(recap?.textContent).toContain("Atlas is the company landing");
    (el.querySelector('[data-testid="meeting-tabs"] button:nth-child(2)') as HTMLButtonElement).click();
    flushSync();
    const tx = el.querySelector('[data-testid="meeting-transcript"]');
    expect(tx?.textContent).toContain("Atlas becomes the company landing.");
    expect(el.querySelector('[data-testid="meeting-transcript"] input')).not.toBeNull();
  });

  it("keeps Join closed until 10 minutes before and copies the link", () => {
    expect(joinAvailable(soon, now)).toBe(true);
    expect(joinAvailable(later, now)).toBe(false);
    const openExternal = vi.fn();
    const oncopy = vi.fn();
    const el = render({ mode: "upcoming", event: later, now, openExternal, oncopy });
    const join = el.querySelector('[data-testid="meeting-join"]') as HTMLButtonElement;
    expect(join.disabled).toBe(true);
    (el.querySelector('[data-testid="meeting-copy"]') as HTMLButtonElement).click();
    expect(oncopy).toHaveBeenCalledWith("https://meet.google.com/abc-defg-hij");
    const ready = render({ mode: "upcoming", event: soon, now, openExternal, oncopy });
    (ready.querySelector('[data-testid="meeting-join"]') as HTMLButtonElement).click();
    expect(openExternal).toHaveBeenCalledWith("https://zoom.us/j/2");
  });

  it("opens the new meeting sheet with title, when, people, notetaker, link, and agenda", () => {
    const oncreate = vi.fn();
    const el = render({ mode: "empty", sheetOpen: true, now, sections: [], oncreate, people: [{ id: "p1", kind: "person", name: "Eric B.", detail: "", meta: "", live: false, companyUid: null }] });
    const sheet = el.querySelector('[data-testid="new-meeting-sheet"]');
    expect(sheet?.textContent).toContain("Title");
    expect(sheet?.querySelector('[data-testid="duration-tabs"]')?.textContent).toContain("45");
    expect(sheet?.querySelector('[data-testid="people-picker"]')).not.toBeNull();
    expect(sheet?.textContent).toContain("Notetaker");
    expect(sheet?.querySelector('[data-testid="link-tabs"]')?.textContent).toContain("Zoom");
    expect(sheet?.querySelector('[aria-label="Agenda"]')).not.toBeNull();
    const title = sheet?.querySelector("input.field") as HTMLInputElement;
    title.value = "Desktop storyboard review";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    (sheet?.querySelector('[data-testid="create-meeting"]') as HTMLButtonElement).click();
    flushSync();
    expect(oncreate).toHaveBeenCalledWith(expect.objectContaining({ summary: "Desktop storyboard review" }));
  });

  it("does not auto-select a past or upcoming row when nothing is live", () => {
    const sections = meetingsRailSections({
      events: [past, later],
      botsByEventId: new Map(),
      companyNamesByUid: new Map(),
      now,
    });
    expect(defaultMeetingId(sections)).toBeNull();
    const el = render({
      mode: "empty",
      now,
      sections,
      onselect: vi.fn(),
    });
    expect(el.querySelector('[data-testid="meetings-empty"]')?.textContent).toContain("Nestlé copy sync");
  });

  it("rejects a draft with no title", () => {
    expect(draftToEvent(emptyNewMeetingDraft(now), "x")).toBeNull();
  });
});
