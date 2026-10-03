import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meetingsRailSections, recapHeading } from "./meetings-rail-model.js";
import type { MeetingEvent } from "./meetings-model.js";

// QA-098: the empty Meetings canvas labelled any past meeting "Yesterday's
// recap", so an Oct 2 meeting read Yesterday on the evening of Oct 2 in
// America/Denver (already Oct 3 in UTC). The heading compares local days.
const previousTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Denver";
});
afterAll(() => {
  process.env.TZ = previousTz;
});

describe("recapHeading (QA-098)", () => {
  it("runs in a zone that is behind UTC", () => {
    expect(new Date("2026-10-03T01:26:00Z").getDate()).toBe(2);
  });

  it("calls a meeting from earlier today Today's recap after UTC has rolled over", () => {
    const now = new Date("2026-10-03T01:26:00Z"); // Oct 2, 19:26 MDT
    expect(recapHeading(Date.parse("2026-10-02T19:00:00Z"), now)).toBe("Today's recap"); // 13:00 MDT
  });

  it("keeps 00:30 and 23:30 local on their own local day", () => {
    const now = new Date(2026, 9, 2, 23, 45);
    expect(recapHeading(new Date(2026, 9, 2, 0, 30).getTime(), now)).toBe("Today's recap");
    expect(recapHeading(new Date(2026, 9, 2, 23, 30).getTime(), now)).toBe("Today's recap");
    expect(recapHeading(new Date(2026, 9, 1, 23, 30).getTime(), now)).toBe("Yesterday's recap");
    const earlyMorning = new Date(2026, 9, 3, 0, 15);
    expect(recapHeading(new Date(2026, 9, 2, 23, 30).getTime(), earlyMorning)).toBe("Yesterday's recap");
    expect(recapHeading(new Date(2026, 9, 3, 0, 5).getTime(), earlyMorning)).toBe("Today's recap");
  });

  it("uses a neutral heading for older or undated meetings", () => {
    const now = new Date(2026, 9, 2, 12, 0);
    expect(recapHeading(new Date(2026, 8, 30, 10, 0).getTime(), now)).toBe("Latest recap");
    expect(recapHeading(null, now)).toBe("Latest recap");
  });

  it("carries the start time on past rail rows", () => {
    const now = new Date("2026-10-03T01:26:00Z");
    const event = {
      id: "m1",
      summary: "Emma Hughes and Jacob Posel",
      status: "confirmed",
      start: { dateTime: "2026-10-02T19:00:00Z" },
      end: { dateTime: "2026-10-02T19:30:00Z" },
      recorded: { hasSignals: true, durationLabel: "30m" },
    } as unknown as MeetingEvent;
    const sections = meetingsRailSections({
      events: [event],
      botsByEventId: new Map(),
      companyNamesByUid: new Map(),
      now,
    });
    const row = sections.find((s) => s.id === "past")?.rows[0];
    expect(row?.startMs).toBe(Date.parse("2026-10-02T19:00:00Z"));
    expect(recapHeading(row?.startMs, now)).toBe("Today's recap");
  });
});
