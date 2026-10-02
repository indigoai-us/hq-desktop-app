// @vitest-environment happy-dom
/**
 * US-021 end-to-end check: given a live meeting, when Meetings opens, the
 * meeting is under Live and the room strip shows the speaker ringed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MeetingsSidepane from "./MeetingsSidepane.svelte";
import MeetingCanvas from "./MeetingCanvas.svelte";
import { EMPTY_MEETINGS_FILTER, meetingsRailSections } from "./meetings-rail-model";
import type { MeetingEvent } from "./meetings-model";

const now = new Date(2026, 9, 1, 10, 14);
const live: MeetingEvent = {
  id: "standup",
  summary: "Indigo dev standup",
  status: "confirmed",
  start: { dateTime: new Date(2026, 9, 1, 10).toISOString() },
  end: { dateTime: new Date(2026, 9, 1, 10, 30).toISOString() },
  meetingUrl: "https://zoom.us/j/1",
  room: {
    live: true,
    speakerId: "corey",
    participants: [
      { id: "corey", name: "Corey L" },
      { id: "eric", name: "Eric B" },
      { id: "deacon", name: "deacon", kind: "bot" },
    ],
  },
  signals: {
    actions: [{ id: "a1", title: "Patch the create-time seam", owner: "Eric", quote: "Eric patches it" }],
    questions: [{ id: "q1", title: "Charge on activation or first run?" }],
  },
};
const tomorrow: MeetingEvent = {
  id: "pricing",
  summary: "Pricing call",
  status: "confirmed",
  start: { dateTime: new Date(2026, 9, 2, 9, 30).toISOString() },
  end: { dateTime: new Date(2026, 9, 2, 10).toISOString() },
};

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

function render(component: any, props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
}

describe("US-021 Meetings sidepane and live canvas", () => {
  const sections = meetingsRailSections({
    events: [live, tomorrow],
    botsByEventId: new Map(),
    companyNamesByUid: new Map(),
    now,
  });

  it("lists the live meeting under Live with filter and new-meeting controls", () => {
    const onselect = vi.fn();
    const el = render(MeetingsSidepane, {
      sections,
      events: [live, tomorrow],
      companyNamesByUid: new Map(),
      selectedId: "standup",
      filter: EMPTY_MEETINGS_FILTER,
      onselect,
    });
    const labels = [...el.querySelectorAll('[data-testid="meetings-section"]')].map((n) => n.getAttribute("data-section"));
    expect(labels).toEqual(["live", "tomorrow"]);
    const liveRow = el.querySelector('[data-row-id="standup"]') as HTMLButtonElement;
    expect(liveRow.dataset.live).toBe("true");
    expect(liveRow.getAttribute("aria-current")).toBe("page");
    expect(el.querySelector('[aria-label="Filter"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="New meeting"]')).not.toBeNull();
    (el.querySelector('[data-row-id="pricing"]') as HTMLButtonElement).click();
    expect(onselect).toHaveBeenCalledWith("pricing");
  });

  it("opens the filter popover from the header", () => {
    const el = render(MeetingsSidepane, {
      sections,
      events: [live],
      companyNamesByUid: new Map(),
      selectedId: null,
      filter: EMPTY_MEETINGS_FILTER,
    });
    (el.querySelector('[data-testid="meetings-filter-button"]') as HTMLButtonElement).click();
    flushSync();
    expect(el.querySelector('[data-testid="meetings-filter-popover"]')?.textContent).toContain("Has recording");
  });

  it("paints shimmer rows, not a spinner, on a cold start", () => {
    const el = render(MeetingsSidepane, {
      sections: [],
      events: [],
      companyNamesByUid: new Map(),
      selectedId: null,
      filter: EMPTY_MEETINGS_FILTER,
      loading: true,
    });
    expect(el.querySelector('[data-testid="meetings-sidepane-skeleton"]')).not.toBeNull();
  });

  it("rings the speaker in the room strip and lays out three columns", () => {
    const el = render(MeetingCanvas, { event: live, now });
    const speaking = el.querySelector('[data-testid="room-person"][data-speaking="true"]');
    expect(speaking?.textContent).toContain("CL");
    expect(speaking?.classList.contains("speaking")).toBe(true);
    expect(el.querySelector('[data-testid="meeting-room-strip"]')?.textContent).toContain("Corey is speaking");
    expect(el.querySelector('[data-testid="meeting-live-chip"]')?.textContent).toContain("Live · 14m");
    for (const id of ["meeting-outline", "meeting-notes", "meeting-signals"]) {
      expect(el.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });

  it("offers Confirm, Edit, Dismiss on actions and Answer, Park on questions", () => {
    const onsignal = vi.fn();
    const el = render(MeetingCanvas, { event: live, now, onsignal });
    const items = [...el.querySelectorAll('[data-testid="signal-item"]')];
    const actions = (i: Element) => [...i.querySelectorAll("[data-action]")].map((b) => b.textContent);
    expect(actions(items[0])).toEqual(["Confirm", "Edit", "Dismiss"]);
    expect(actions(items[1])).toEqual(["Answer", "Park"]);
    (items[0].querySelector('[data-action="dismiss"]') as HTMLButtonElement).click();
    flushSync();
    expect(onsignal).toHaveBeenCalledWith("dismiss", expect.objectContaining({ id: "a1" }));
    expect(el.querySelectorAll('[data-testid="signal-item"]')).toHaveLength(1);
  });
});
