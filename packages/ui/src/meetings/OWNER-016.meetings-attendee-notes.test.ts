// @vitest-environment happy-dom
/**
 * OWNER-016: the Meetings list shows only meetings the signed-in person
 * attended or recorded (company role never widens it), past days get one
 * Messages-style day header instead of a date on every row, and a past
 * meeting shows Recap/Transcript/Notes only when real notes exist.
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MeetingsSidepane from "./MeetingsSidepane.svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import { EMPTY_MEETINGS_FILTER, meetingsRailSections } from "./meetings-rail-model";
import { pastNotesState } from "./meeting-states-model";
import type { MeetingEvent, ScheduledBot } from "./meetings-model";
import {
  loadRecordedSignals,
  ownRecordedMeetings,
  parseRecordedDetail,
  parseRecordedMeetings,
  signalBodyText,
  withRecordedEvents,
} from "./recorded-meetings";

// Row shape from `hq meetings list --json` (hq-pro GET /v1/meetings) on
// 2026-10-02: no attendee, organizer or recorder field on list rows.
const listWire = {
  meetings: [
    { meetingId: "bot-mine", sourceShape: "markdown", title: "Indigo dev standup", startTime: "2026-09-30T16:00:00.000Z", channel: "meeting", ingested_at: "2026-09-30T16:40:00.000Z", hasSignals: true, companyId: "cmp_indigo", attributed: true },
    { meetingId: "bot-emma", sourceShape: "markdown", title: "Emma Hughes and Jacob Posel", startTime: "2026-09-30T18:00:00.000Z", channel: "meeting", ingested_at: "2026-09-30T18:40:00.000Z", hasSignals: true, companyId: "cmp_indigo", attributed: true },
    { meetingId: "bot-cal", sourceShape: "markdown", title: "Pricing call", startTime: "2026-10-01T15:01:00.000Z", channel: "meeting", ingested_at: "2026-10-01T15:40:00.000Z", hasSignals: true, companyId: "unknown", attributed: false },
    { meetingId: "rec-local", sourceShape: "markdown", title: "Ad hoc", startTime: "2026-10-01T19:00:00.000Z", channel: "meeting", ingested_at: "2026-10-01T19:30:00.000Z", hasSignals: false, companyId: "cmp_indigo", attributed: true },
  ],
};

const myBots: Pick<ScheduledBot, "botId">[] = [{ botId: "bot-mine" }];
const myCalendar: MeetingEvent[] = [
  { id: "cal-1", summary: "Pricing call", status: "confirmed", start: { dateTime: "2026-10-01T15:00:00.000Z" }, end: { dateTime: "2026-10-01T15:30:00.000Z" } },
];

describe("attendee filter", () => {
  const rows = parseRecordedMeetings(listWire);
  const own = ownRecordedMeetings(rows, {
    botIds: myBots.map((b) => b.botId),
    calendarEvents: myCalendar,
    localRecordingIds: ["rec-local"],
  });
  const ids = own.map((m) => m.meetingId);

  it("shows a meeting recorded by the person's own notetaker", () => {
    expect(ids).toContain("bot-mine");
  });

  it("hides a company meeting the person did not attend, even as company owner", () => {
    // The owner can read every member's recording; that does not list it.
    expect(ids).not.toContain("bot-emma");
  });

  it("shows a meeting on the person's own calendar (attendee)", () => {
    expect(ids).toContain("bot-cal");
  });

  it("shows a meeting recorded from this device", () => {
    expect(ids).toContain("rec-local");
  });

  it("hides everything when no identity signal matches", () => {
    expect(ownRecordedMeetings(rows, { botIds: [], calendarEvents: [] })).toEqual([]);
  });

  it("filters the company view the same way", () => {
    const sections = meetingsRailSections({
      events: withRecordedEvents([], own),
      botsByEventId: new Map(),
      companyNamesByUid: new Map([["cmp_indigo", "Indigo"]]),
      filter: { ...EMPTY_MEETINGS_FILTER, companyUid: "cmp_indigo" },
      now: new Date("2026-10-02T20:00:00Z"),
    });
    const titles = sections.flatMap((s) => s.rows.map((r) => r.title));
    expect(titles).toEqual(["Ad hoc", "Indigo dev standup"]);
  });
});

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

function render(component: any, props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(component, { target, props: props as never }));
  flushSync();
  return target;
}

function pastEvent(id: string, title: string, start: Date, mins = 30, extra: Partial<MeetingEvent> = {}): MeetingEvent {
  return {
    id,
    summary: title,
    status: "confirmed",
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(start.getTime() + mins * 60_000).toISOString() },
    recorded: { meetingId: id, durationLabel: null, hasSignals: false },
    ...extra,
  };
}

describe("day headers in the Meetings list", () => {
  const now = new Date(2026, 9, 2, 16, 0);
  const events = [
    pastEvent("a", "Morning sync", new Date(2026, 9, 2, 9, 0)),
    pastEvent("b", "A very long meeting title that has to ellipsize instead of pushing the date", new Date(2026, 9, 1, 14, 30)),
    pastEvent("c", "Another yesterday call", new Date(2026, 9, 1, 11, 0)),
    pastEvent("d", "Wednesday review", new Date(2026, 8, 30, 10, 0)),
  ];
  const sections = meetingsRailSections({ events, botsByEventId: new Map(), companyNamesByUid: new Map(), now });

  it("shows the date once per day, not on every row", () => {
    expect(sections.map((s) => s.label)).toEqual(["TODAY · OCT 2", "YESTERDAY · OCT 1", "WEDNESDAY · SEP 30"]);
    expect(sections[1].rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(sections.flatMap((s) => s.rows).map((r) => r.time)).toEqual(["09:00", "14:30", "11:00", "10:00"]);
  });

  it("renders the shared Messages day header with the date on the right and rows without dates", () => {
    const el = render(MeetingsSidepane, {
      sections,
      events,
      companyNamesByUid: new Map(),
      selectedId: null,
      filter: EMPTY_MEETINGS_FILTER,
    });
    const heads = [...el.querySelectorAll('[data-testid="meetings-section"]')];
    expect(heads.map((h) => h.classList.contains("chat-day-head"))).toEqual([true, true, true]);
    expect(heads.map((h) => h.querySelector('[data-testid="chat-day-date"]')?.textContent)).toEqual([
      "OCT 2",
      "OCT 1",
      "SEP 30",
    ]);
    const longRow = el.querySelector('[data-row-id="b"]') as HTMLElement;
    const time = longRow.querySelector(".time") as HTMLElement;
    // One line: the slot holds only "14:30", no date words that could wrap.
    expect(time.textContent).toBe("14:30");
    expect(longRow.textContent).not.toMatch(/Oct|Sep/);
    expect(el.querySelector(".title")?.textContent).toBe("Meetings");
  });
});

describe("past meeting notes", () => {
  const now = new Date(2026, 9, 2, 16, 0);
  const longAgo = pastEvent("old", "Emma Hughes and Jacob Posel", new Date(2026, 8, 29, 10, 0), 30, {
    attendees: [{ email: "emma@example.com", displayName: "Emma Hughes" }],
    meetingUrl: "https://zoom.us/j/9",
  });

  it("shows one quiet line and calendar details, with no empty tabs, when nothing was saved", () => {
    expect(pastNotesState(longAgo, now)).toBe("none");
    const el = render(MeetingsStatesBody, { mode: "recap", event: longAgo, now });
    expect(el.querySelector('[data-testid="meeting-tabs"]')).toBeNull();
    expect(el.querySelector('[data-testid="meeting-recap"]')).toBeNull();
    const block = el.querySelector('[data-testid="meeting-no-notes"]') as HTMLElement;
    expect(block.textContent).toContain("No notes for this meeting");
    expect(el.textContent).not.toMatch(/No recap summary yet|No decisions recorded|No action items|No open questions/);
    expect(el.querySelector('[data-testid="meeting-when"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meeting-link"]')?.textContent).toBe("https://zoom.us/j/9");
    expect(el.querySelectorAll('[data-testid="meeting-attendee"]').length).toBe(1);
  });

  it("says notes are being prepared right after a recorded meeting ends", () => {
    const fresh = pastEvent("fresh", "Just ended", new Date(2026, 9, 2, 15, 30), 20);
    expect(pastNotesState(fresh, now)).toBe("preparing");
    const el = render(MeetingsStatesBody, { mode: "recap", event: fresh, now });
    expect(el.querySelector('[data-testid="meeting-no-notes"]')?.textContent).toContain("Notes are being prepared");
    expect(el.querySelector('[data-testid="meeting-tabs"]')).toBeNull();
  });

  it("renders the real saved notes and only the sections that have content", async () => {
    // Detail shape from `hq meetings get <id> --json`: signals grouped by
    // type, each with a presigned body URL and usually no title.
    const detail = {
      meetingId: "old",
      signals: {
        summary: [{ slug: "s1", path: "signals/s1.md", presigned_url: "https://s3.example/s1" }],
        decision: [{ slug: "d1", path: "signals/d1.md", presigned_url: "https://s3.example/d1" }],
      },
    };
    const bodies: Record<string, string> = {
      "https://s3.example/s1": "---\ntype: summary\n---\n# Summary\nPricing moves to the team plan.",
      "https://s3.example/d1": "---\ntype: decision\n---\nShip the attendee filter.",
    };
    const refs = parseRecordedDetail(detail);
    expect(refs.map((r) => r.kind)).toEqual(["summary", "decisions"]);
    const signals = await loadRecordedSignals(refs, async (url) => bodies[url]!);
    const withNotes = { ...longAgo, signals };
    expect(pastNotesState(withNotes, now)).toBe("ready");
    const el = render(MeetingsStatesBody, { mode: "recap", event: withNotes, now });
    expect(el.querySelector('[data-testid="meeting-tabs"]')).not.toBeNull();
    const recap = el.querySelector('[data-testid="meeting-recap"]') as HTMLElement;
    expect(recap.textContent).toContain("Pricing moves to the team plan.");
    expect(recap.textContent).toContain("Ship the attendee filter.");
    expect(recap.textContent).not.toMatch(/Action items|Open questions|No /);
  });

  it("holds a loading state while saved notes are fetched", () => {
    expect(pastNotesState(longAgo, now, { detailLoading: true })).toBe("loading");
  });

  it("strips frontmatter and headings from a signal body", () => {
    expect(signalBodyText("---\na: 1\n---\n## Title\nLine one\n\nLine two")).toBe("Title Line one Line two");
  });
});
