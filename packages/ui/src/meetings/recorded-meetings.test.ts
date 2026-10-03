import { describe, expect, it } from "vitest";
import {
  mergeRecordedMeetings,
  parseRecordedMeetings,
  recordedDurationLabel,
  recordedToEvent,
  withRecordedEvents,
} from "./recorded-meetings";
import { meetingsRailSections } from "./meetings-rail-model";

// Envelope and row shape as returned by hq-pro GET /v1/meetings on 2026-10-02.
const wire = {
  meetings: [
    {
      meetingId: "29e397d9-001d-45dc-b214-29a02e107e25",
      sourceShape: "markdown",
      title: "GTM Sync",
      startTime: "2026-07-01T11:30:00-06:00",
      channel: "meeting",
      ingested_at: "2026-07-01T18:30:00.000Z",
      hasSignals: true,
      companyId: "unknown",
      attributed: false,
    },
    {
      meetingId: "6e448aaa-ea2c-42e4-8252-36703f127ee8",
      sourceShape: "markdown",
      startTime: "2026-06-30T17:01:35.566Z",
      channel: "meeting",
      ingested_at: "2026-06-30T17:30:00.000Z",
      hasSignals: false,
      companyId: "cmp_indigo",
      attributed: true,
      duration: 2700,
    },
    { meetingId: "no-start", title: "Broken", companyId: "unknown" },
    "not-an-object",
  ],
  nextToken: "abc",
};

describe("parseRecordedMeetings", () => {
  it("coerces the real envelope and drops rows without an id or start", () => {
    const rows = parseRecordedMeetings(wire);
    expect(rows).toEqual([
      {
        meetingId: "29e397d9-001d-45dc-b214-29a02e107e25",
        title: "GTM Sync",
        startTime: "2026-07-01T11:30:00-06:00",
        endTime: null,
        durationSec: null,
        companyUid: null,
        hasSignals: true,
      },
      {
        meetingId: "6e448aaa-ea2c-42e4-8252-36703f127ee8",
        title: "Untitled meeting",
        startTime: "2026-06-30T17:01:35.566Z",
        endTime: null,
        durationSec: 2700,
        companyUid: "cmp_indigo",
        hasSignals: false,
      },
    ]);
  });

  it("returns nothing for shapes that are not a meetings list", () => {
    expect(parseRecordedMeetings(null)).toEqual([]);
    expect(parseRecordedMeetings({ meetings: "oops" })).toEqual([]);
    expect(parseRecordedMeetings({ items: [] })).toEqual([]);
  });
});

describe("mergeRecordedMeetings", () => {
  it("dedupes by id preferring the attributed copy, newest first", () => {
    const [personal, company] = parseRecordedMeetings(wire);
    const dup = { ...personal, companyUid: "cmp_indigo" };
    const merged = mergeRecordedMeetings([[personal, company], [dup]]);
    expect(merged.map((m) => [m.meetingId, m.companyUid])).toEqual([
      [personal.meetingId, "cmp_indigo"],
      [company.meetingId, "cmp_indigo"],
    ]);
  });
});

describe("recordedDurationLabel", () => {
  it("formats seconds and end times, null when unknown", () => {
    expect(recordedDurationLabel({ durationSec: 2700, startTime: "2026-01-01T00:00:00Z", endTime: null })).toBe("45m");
    expect(recordedDurationLabel({ durationSec: null, startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-01T01:05:00Z" })).toBe("1h 05m");
    expect(recordedDurationLabel({ durationSec: null, startTime: "2026-01-01T00:00:00Z", endTime: null })).toBeNull();
  });
});

describe("recorded meetings in the rail", () => {
  const recorded = parseRecordedMeetings(wire);
  const names = new Map([["cmp_indigo", "Indigo"]]);
  const now = new Date("2026-10-02T20:00:00Z");

  it("lists recorded history under Past with date, duration and company", () => {
    const sections = meetingsRailSections({
      events: withRecordedEvents([], recorded),
      botsByEventId: new Map(),
      companyNamesByUid: names,
      now,
    });
    // One day header per meeting day; rows carry the start time only.
    expect(sections.map((s) => [s.id, s.label])).toEqual([
      ["past", "JUL 1"],
      ["past", "JUN 30"],
    ]);
    expect(
      sections.flatMap((s) => s.rows).map((r) => [r.title, r.duration, r.companyLabel, r.companyMark, r.hasRecap]),
    ).toEqual([
      ["GTM Sync", null, null, null, true],
      ["Untitled meeting", "45m", "Indigo", "IN", false],
    ]);
    for (const row of sections.flatMap((s) => s.rows)) expect(row.time).toMatch(/^\d\d:\d\d$/);
  });

  it("shows only the selected company's meetings in company scope", () => {
    const sections = meetingsRailSections({
      events: withRecordedEvents([], recorded),
      botsByEventId: new Map(),
      companyNamesByUid: names,
      filter: { companyUid: "cmp_indigo", hasRecording: false, hasRecap: false, liveOnly: false },
      now,
    });
    expect(sections[0].rows.map((r) => r.title)).toEqual(["Untitled meeting"]);
  });

  it("keeps up to a full page of history instead of the 8-row calendar cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...recorded[0],
      meetingId: `m${i}`,
      startTime: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
    }));
    const sections = meetingsRailSections({
      events: withRecordedEvents([], many),
      botsByEventId: new Map(),
      companyNamesByUid: names,
      now,
    });
    const rows = sections.flatMap((s) => s.rows);
    expect(rows).toHaveLength(20);
    expect(rows[0].id).toBe("recorded:m19");
  });

  it("maps to a past event the canvas can open by id", () => {
    const event = recordedToEvent(recorded[1]);
    expect(event.id).toBe("recorded:6e448aaa-ea2c-42e4-8252-36703f127ee8");
    expect(event.end.dateTime).toBe("2026-06-30T17:46:35.566Z");
    expect(event.sourceCompanyUid).toBe("cmp_indigo");
  });
});
