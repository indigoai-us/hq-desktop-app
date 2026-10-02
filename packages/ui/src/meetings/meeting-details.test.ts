// @vitest-environment happy-dom
/**
 * Regression: the upcoming meeting canvas showed "No agenda yet." (wrapped one
 * word per line) and "No attendees on the calendar event." for real calendar
 * events. The host now passes description, attendees, organizer, and location
 * through; these tests pin the mapping and the agenda column layout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import {
  agendaItems,
  attendeeViews,
  descriptionLines,
  locationLabel,
  meetingJoinUrl,
  organizerLabel,
} from "./meeting-details";
import { isBusyBlock, meetingsRailSections } from "./meetings-rail-model";
import type { MeetingEvent } from "./meetings-model";

const now = new Date(2026, 9, 2, 8, 30);
const standup: MeetingEvent = {
  id: "standup",
  summary: "HQ Dev Standup",
  status: "confirmed",
  start: { dateTime: new Date(2026, 9, 2, 9, 30).toISOString() },
  end: { dateTime: new Date(2026, 9, 2, 10, 30).toISOString() },
  description: "<p>1. Wins since yesterday<br>2. Blockers &amp; asks</p><ul><li>Release check</li></ul>",
  location: "Office · Room 2",
  attendees: [
    { email: "b@example.com", displayName: "Bea", responseStatus: "needsAction" },
    { email: "room@resource.calendar.google.com", displayName: "Room 2", responseStatus: "accepted", resource: true },
    { email: "a@example.com", displayName: "Ada", responseStatus: "accepted" },
    { email: "c@example.com", responseStatus: "declined" },
  ],
  organizer: { email: "a@example.com", displayName: "Ada" },
  conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/99" }] },
};

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

function render(event: MeetingEvent): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(MeetingsStatesBody, { target, props: { mode: "upcoming", event, now } as never }));
  flushSync();
  return target;
}

describe("meeting details mapping", () => {
  it("reads the HTML description as agenda lines", () => {
    expect(descriptionLines(standup.description)).toEqual([
      "Wins since yesterday",
      "Blockers & asks",
      "Release check",
    ]);
    expect(agendaItems(standup).map((i) => i.title)).toHaveLength(3);
  });

  it("prefers the notetaker outline over the description", () => {
    const withOutline = { ...standup, outline: [{ id: "o1", title: "Rail order" }] };
    expect(agendaItems(withOutline).map((i) => i.title)).toEqual(["Rail order"]);
  });

  it("lists people with their response, organizer first, rooms dropped", () => {
    const views = attendeeViews(standup);
    expect(views.map((v) => v.name)).toEqual(["Ada", "Bea", "c@example.com"]);
    expect(views[0]).toMatchObject({ organizer: true, response: "Accepted" });
    expect(views[1].response).toBe("Invited");
    expect(views[2].response).toBe("Declined");
    expect(organizerLabel(standup)).toBe("Ada");
  });

  it("finds the join link in conference data or the location", () => {
    expect(meetingJoinUrl(standup)).toBe("https://zoom.us/j/99");
    const inLocation: MeetingEvent = { ...standup, conferenceData: null, location: "Zoom https://zoom.us/j/7 pw" };
    expect(meetingJoinUrl(inLocation)).toBe("https://zoom.us/j/7");
    expect(locationLabel(standup)).toBe("Office · Room 2");
    expect(locationLabel({ ...standup, location: "https://zoom.us/j/7" })).toBe("");
  });

  it("renders attendees, agenda, and organizer on the upcoming canvas", () => {
    const el = render(standup);
    const agenda = el.querySelector('[data-testid="meeting-agenda"]');
    expect(agenda?.textContent).toContain("Wins since yesterday");
    expect(agenda?.textContent).not.toContain("No agenda yet.");
    const people = [...el.querySelectorAll('[data-testid="meeting-attendee"]')].map((n) => n.textContent);
    expect(people).toHaveLength(3);
    expect(people[0]).toContain("Ada");
    expect(people[0]).toContain("Organizer");
    expect(el.querySelector('[data-testid="meeting-organizer"]')?.textContent).toContain("Ada");
    expect(el.querySelector('[data-testid="meeting-location"]')?.textContent).toContain("Room 2");
  });
});

describe("agenda column width", () => {
  const source = readFileSync(join(import.meta.dirname, "MeetingsStatesBody.svelte"), "utf8");

  it("keeps the agenda column at 240 px minimum", () => {
    expect(source).toMatch(/\.split\s*\{[^}]*grid-template-columns:\s*minmax\(240px,\s*1fr\)\s+300px/);
  });

  it("does not put the empty agenda row in the 22 px number column", () => {
    const el = render({ ...standup, description: null });
    const empty = el.querySelector('[data-testid="meeting-agenda"] li');
    expect(empty?.textContent).toBe("No agenda yet.");
    expect(empty?.classList.contains("ag-empty")).toBe(true);
    expect(source).toMatch(/\.ag li\.ag-empty\s*\{\s*display:\s*block;/);
  });
});

describe("busy blocks", () => {
  const busy: MeetingEvent = {
    id: "busy-1",
    summary: "Busy",
    status: "confirmed",
    sourceCompanyUid: "cmp_1",
    start: { dateTime: new Date(2026, 9, 2, 9).toISOString() },
    end: { dateTime: new Date(2026, 9, 2, 9, 30).toISOString() },
  };

  it("renders a free/busy block as a quiet row without a company mark", () => {
    expect(isBusyBlock(busy)).toBe(true);
    expect(isBusyBlock({ ...busy, meetingUrl: "https://zoom.us/j/1" })).toBe(false);
    const sections = meetingsRailSections({
      events: [busy, { ...standup, sourceCompanyUid: "cmp_1" }],
      botsByEventId: new Map(),
      scheduledBots: [],
      companyNamesByUid: new Map([["cmp_1", "Indigo"]]),
      filter: { companyUid: null, hasRecording: false, hasRecap: false, liveOnly: false },
      now,
    } as never);
    const rows = sections.flatMap((s) => s.rows);
    const busyRow = rows.find((r) => r.id === "busy-1")!;
    const realRow = rows.find((r) => r.id === "standup")!;
    expect(busyRow).toMatchObject({ busy: true, companyMark: null });
    expect(realRow.busy).toBe(false);
    expect(realRow.companyMark).not.toBeNull();
  });
});
