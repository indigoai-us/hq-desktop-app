import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  companyMark,
  defaultMeetingId,
  EMPTY_MEETINGS_FILTER,
  meetingsRailSections,
  roomStrip,
  signalGroups,
  signalTotal,
} from "./meetings-rail-model";
import type { MeetingEvent, ScheduledBot } from "./meetings-model";

const now = new Date(2026, 9, 1, 10, 14);
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

function ev(id: string, start: string, end: string, extra: Partial<MeetingEvent> = {}): MeetingEvent {
  return { id, summary: id, status: "confirmed", start: { dateTime: start }, end: { dateTime: end }, meetingUrl: `https://zoom.us/j/${id}`, ...extra };
}

const events: MeetingEvent[] = [
  ev("standup", at(1, 10), at(1, 10, 30)),
  ev("flow", at(1, 11), at(1, 11, 30), { sourceCompanyUid: "cmp_lr" }),
  ev("pricing", at(2, 9, 30), at(2, 10)),
  ev("readout", new Date(2026, 8, 30, 15).toISOString(), new Date(2026, 8, 30, 16).toISOString()),
  ev("later", at(9, 9), at(9, 10)),
  ev("gone", at(1, 12), at(1, 13), { status: "cancelled" }),
];
const names = new Map([["cmp_lr", "LiveRecover"]]);
const bots = new Map<string, ScheduledBot>([
  ["readout", { botId: "b1", meetingUrl: "", platform: "zoom", status: "completed", calendarEventId: "readout", autoScheduled: false, sourceLanded: true }],
]);

describe("meetingsRailSections", () => {
  const sections = meetingsRailSections({ events, botsByEventId: bots, companyNamesByUid: names, now });

  it("groups into Live, Today, Past, hides Tomorrow while today has meetings ahead, and drops later days and cancelled", () => {
    expect(sections.map((s) => s.id)).toEqual(["live", "today", "past"]);
    expect(sections[0].rows.map((r) => r.id)).toEqual(["standup"]);
    expect(sections[0].rows[0].time).toBe("14m");
    expect(sections[1].label).toBe("TODAY · OCT 1");
    expect(sections[2].label).toBe("YESTERDAY · SEP 30");
    expect(sections[1].rows.map((r) => r.id)).toEqual(["flow"]);
    expect(sections[2].rows.map((r) => r.id)).toEqual(["readout"]);
  });

  it("shows time, company mark, and the recap mark on past rows", () => {
    expect(sections[1].rows[0]).toMatchObject({ time: "11:00", companyMark: "LR" });
    // The day lives in the header; past rows carry only the start time.
    expect(sections[2].rows[0]).toMatchObject({ time: "15:00", hasRecap: true });
    expect(defaultMeetingId(sections)).toBe("standup");
  });

  it("applies filters", () => {
    const f = { ...EMPTY_MEETINGS_FILTER, companyUid: "cmp_lr" };
    expect(activeFilterCount(f)).toBe(1);
    const only = meetingsRailSections({ events, botsByEventId: bots, companyNamesByUid: names, filter: f, now });
    expect(only.flatMap((s) => s.rows.map((r) => r.id))).toEqual(["flow"]);
    const recap = meetingsRailSections({ events, botsByEventId: bots, companyNamesByUid: names, filter: { ...EMPTY_MEETINGS_FILTER, hasRecap: true }, now });
    expect(recap.flatMap((s) => s.rows.map((r) => r.id))).toEqual(["readout"]);
  });
});

describe("meetingsRailSections Today/Tomorrow grouping", () => {
  // Oct 6 2026 in the test's local zone: two ended meetings, two still ahead.
  const day = (h: number, m = 0, d = 6) => new Date(2026, 9, d, h, m).toISOString();
  const recapBots = new Map<string, ScheduledBot>([
    ["vyg", { botId: "b2", meetingUrl: "", platform: "zoom", status: "completed", calendarEventId: "vyg", autoScheduled: false, sourceLanded: true }],
    ["dev", { botId: "b3", meetingUrl: "", platform: "zoom", status: "completed", calendarEventId: "dev", autoScheduled: false, sourceLanded: true }],
  ]);
  const todayEvents: MeetingEvent[] = [
    ev("cut30", day(19), day(20)),
    ev("vyg", day(7, 30), day(8)),
    ev("lr", day(12, 30), day(13)),
    ev("dev", day(9), day(9, 30)),
    ev("tmrw-a", day(9, 0, 7), day(9, 30, 7)),
    ev("tmrw-b", day(11, 0, 7), day(11, 30, 7)),
    ev("yday", day(15, 0, 5), day(16, 0, 5)),
  ];
  const build = (at: Date, list = todayEvents) =>
    meetingsRailSections({ events: list, botsByEventId: recapBots, companyNamesByUid: names, now: at });

  it("mid-day: one Today section in start order and no Tomorrow", () => {
    const s = build(new Date(2026, 9, 6, 10, 0));
    expect(s.map((x) => x.id)).toEqual(["today", "past"]);
    expect(s[0].rows.map((r) => r.id)).toEqual(["vyg", "dev", "lr", "cut30"]);
    expect(s[0].rows.map((r) => r.time)).toEqual(["07:30", "09:00", "12:30", "19:00"]);
    expect(s.some((x) => x.label.startsWith("EARLIER TODAY"))).toBe(false);
    expect(s[1].label).toBe("YESTERDAY · OCT 5");
  });

  it("keeps the recap mark on ended rows and flags them as past", () => {
    const rows = build(new Date(2026, 9, 6, 10, 0))[0].rows;
    expect(rows.filter((r) => r.past).map((r) => r.id)).toEqual(["vyg", "dev"]);
    expect(rows.filter((r) => r.hasRecap).map((r) => r.id)).toEqual(["vyg", "dev"]);
    expect(rows.find((r) => r.id === "lr")?.past).toBeFalsy();
  });

  it("hides Tomorrow while the last meeting of today is live", () => {
    const s = build(new Date(2026, 9, 6, 19, 30));
    expect(s.map((x) => x.id)).toEqual(["live", "today", "past"]);
  });

  it("shows Tomorrow under Today once today's last meeting has ended", () => {
    const s = build(new Date(2026, 9, 6, 20, 0));
    expect(s.map((x) => x.id)).toEqual(["today", "tomorrow", "past"]);
    expect(s[0].rows.map((r) => r.id)).toEqual(["vyg", "dev", "lr", "cut30"]);
    expect(s[0].rows.every((r) => r.past)).toBe(true);
    expect(s[1].rows.map((r) => r.id)).toEqual(["tmrw-a", "tmrw-b"]);
  });

  it("shows Tomorrow when today has no meetings", () => {
    const s = build(new Date(2026, 9, 6, 8, 0), todayEvents.filter((e) => e.id.startsWith("tmrw") || e.id === "yday"));
    expect(s.map((x) => x.id)).toEqual(["tomorrow", "past"]);
  });

  it("rolls over at midnight: yesterday's Today moves to Past and the new day's meetings are Today", () => {
    const s = build(new Date(2026, 9, 7, 0, 1));
    expect(s.map((x) => x.id)).toEqual(["today", "past", "past"]);
    expect(s[0].rows.map((r) => r.id)).toEqual(["tmrw-a", "tmrw-b"]);
    expect(s[0].label).toBe("TODAY · OCT 7");
    expect(s[1].label).toBe("YESTERDAY · OCT 6");
    expect(s[1].rows.map((r) => r.id)).toEqual(["cut30", "lr", "dev", "vyg"]);
    expect(s[1].rows.some((r) => r.past)).toBe(false);
  });
});

describe("companyMark", () => {
  it("builds two-letter marks", () => {
    expect(companyMark("LiveRecover")).toBe("LR");
    expect(companyMark("Indigo")).toBe("IN");
    expect(companyMark("ramen bae")).toBe("RB");
    expect(companyMark("")).toBeNull();
  });
});

describe("roomStrip", () => {
  it("rings the speaker first and summarizes the room", () => {
    const strip = roomStrip(
      ev("s", at(1, 10), at(1, 11), {
        room: {
          live: true,
          speakerId: "corey",
          participants: [
            { id: "eric", name: "Eric B." },
            { id: "corey", name: "Corey L" },
            { id: "deacon", name: "deacon", kind: "bot" },
          ],
        },
        attendees: [{ email: "andrew@x.com", displayName: "Andrew N" }, { email: "eric" }],
      }),
    );
    expect(strip.people[0]).toMatchObject({ id: "corey", speaking: true, live: true, initials: "CL" });
    expect(strip.speaker?.id).toBe("corey");
    expect(strip.people.find((p) => p.id === "andrew@x.com")).toMatchObject({ invited: true, live: false });
    expect(strip.people.filter((p) => p.id === "eric")).toHaveLength(1);
    expect(strip.summary).toBe("Corey is speaking · 2 people, 1 bot in the room · Andrew invited");
  });

  it("is empty without an event", () => {
    expect(roomStrip(null)).toEqual({ people: [], speaker: null, summary: "" });
  });
});

describe("signalGroups", () => {
  const event = ev("s", at(1, 10), at(1, 11), {
    signals: {
      actions: [{ id: "a1", title: "Patch billActivation", owner: "Eric", at: "10:10", quote: "Eric patches" }],
      decisions: ["Both seams ship together"],
      questions: [{ title: "Charge on activation or first run?" }],
    },
  });

  it("returns all four groups in order with the right actions", () => {
    const groups = signalGroups(event);
    expect(groups.map((g) => g.label)).toEqual(["Action items", "Decisions", "Open questions", "Risks"]);
    expect(groups[0].items[0]).toMatchObject({ owner: "Eric", at: "10:10", quote: "Eric patches", actions: ["confirm", "edit", "dismiss"] });
    expect(groups[2].items[0].actions).toEqual(["answer", "park"]);
    expect(groups[3].items).toEqual([]);
    expect(signalTotal(groups)).toBe(3);
  });

  it("drops hidden items", () => {
    expect(signalTotal(signalGroups(event, new Set(["a1"])))).toBe(2);
  });
});
