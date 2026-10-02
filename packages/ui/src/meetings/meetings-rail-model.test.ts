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

  it("groups into Live, Today, Tomorrow, Past and drops later days and cancelled", () => {
    expect(sections.map((s) => s.id)).toEqual(["live", "today", "tomorrow", "past"]);
    expect(sections[0].rows.map((r) => r.id)).toEqual(["standup"]);
    expect(sections[0].rows[0].time).toBe("14m");
    expect(sections[1].label).toBe("Today · Oct 1");
    expect(sections[1].rows.map((r) => r.id)).toEqual(["flow"]);
    expect(sections[2].rows.map((r) => r.id)).toEqual(["pricing"]);
    expect(sections[3].rows.map((r) => r.id)).toEqual(["readout"]);
  });

  it("shows time, company mark, and the recap mark on past rows", () => {
    expect(sections[1].rows[0]).toMatchObject({ time: "11:00", companyMark: "LR" });
    expect(sections[3].rows[0]).toMatchObject({ time: "Sep 30", hasRecap: true });
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
