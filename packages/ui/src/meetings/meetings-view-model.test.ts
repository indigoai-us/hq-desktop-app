import { describe, expect, it } from "vitest";
import {
  MEETINGS_PAGE_DEK,
  MEETINGS_PAGE_TITLE_LINE,
  MEETINGS_PAST_EMPTY,
  formatLastSyncedRelative,
  formatMeetingsFooterLabel,
  groupMeetingsForAgenda,
  notetakerToggleForEvent,
  notetakerToggleState,
  partitionUpcomingPast,
  takeAgendaWindow,
  type NotetakerToggleModel,
} from "./meetings-view-model";
import type { MeetingEvent, ScheduledBot } from "./meetings-model";

const now = new Date(2026, 4, 27, 12, 0, 0); // Wed May 27 2026, 12:00 local

function eventAt(id: string, startLocal: Date, durationMin = 30): MeetingEvent {
  return {
    id,
    status: "confirmed",
    summary: id,
    start: { dateTime: startLocal.toISOString() },
    end: {
      dateTime: new Date(
        startLocal.getTime() + durationMin * 60_000,
      ).toISOString(),
    },
  };
}

function bot(overrides: Partial<ScheduledBot> = {}): ScheduledBot {
  return {
    botId: "bot-1",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    status: "scheduled",
    autoScheduled: true,
    ...overrides,
  };
}

describe("meetings-view-model (US-017)", () => {
  describe("partitionUpcomingPast", () => {
    it("puts end >= now in upcoming (start ascending) and end < now in past (newest first)", () => {
      const pastOlder = eventAt("past-old", new Date(2026, 4, 26, 9, 0, 0));
      const pastNewer = eventAt("past-new", new Date(2026, 4, 27, 10, 0, 0));
      const upSoon = eventAt("up-soon", new Date(2026, 4, 27, 13, 0, 0));
      const upLater = eventAt("up-later", new Date(2026, 4, 28, 9, 0, 0));
      // Currently in progress: started earlier, ends after now → upcoming
      const live = eventAt("live", new Date(2026, 4, 27, 11, 30, 0), 60);

      const { upcoming, past } = partitionUpcomingPast(
        [upLater, pastOlder, live, pastNewer, upSoon],
        now,
      );

      expect(upcoming.map((e) => e.id)).toEqual([
        "live",
        "up-soon",
        "up-later",
      ]);
      expect(past.map((e) => e.id)).toEqual(["past-new", "past-old"]);
    });

    it("treats missing end as upcoming", () => {
      const open: MeetingEvent = {
        id: "open",
        status: "confirmed",
        start: { dateTime: now.toISOString() },
        end: {},
      };
      const { upcoming, past } = partitionUpcomingPast([open], now);
      expect(upcoming.map((e) => e.id)).toEqual(["open"]);
      expect(past).toEqual([]);
    });

    it("returns empty past honestly when nothing has ended", () => {
      const { past } = partitionUpcomingPast(
        [eventAt("a", new Date(2026, 4, 27, 15, 0, 0))],
        now,
      );
      expect(past).toEqual([]);
      expect(MEETINGS_PAST_EMPTY).toBe("No past meetings yet");
    });
  });

  describe("takeAgendaWindow", () => {
    it("keeps a near-term upcoming window and a short past tail", () => {
      const rows = [
        eventAt("past", new Date(2026, 4, 26, 9, 0, 0)),
        eventAt("soon", new Date(2026, 4, 28, 9, 0, 0)),
        eventAt("far", new Date(2026, 6, 1, 9, 0, 0)),
      ];
      const windowed = takeAgendaWindow(rows, now);
      expect(windowed.map((e) => e.id)).toEqual(["soon", "past"]);
    });
  });

  describe("groupMeetingsForAgenda", () => {
    it("reuses day grouping for the active list", () => {
      const groups = groupMeetingsForAgenda(
        [
          eventAt("t1", new Date(2026, 4, 27, 14, 0, 0)),
          eventAt("tm", new Date(2026, 4, 28, 10, 0, 0)),
        ],
        now,
      );
      expect(groups.map((g) => g.label)).toEqual(["Today", "Tomorrow"]);
      expect(groups[0].events.map((e) => e.id)).toEqual(["t1"]);
    });
  });

  describe("notetakerToggleState", () => {
    it("is off + invite when no bot", () => {
      const t = notetakerToggleState(undefined);
      expect(t).toMatchObject<Partial<NotetakerToggleModel>>({
        visual: "off",
        action: "invite",
        kind: "invite",
      });
      expect(t.ariaLabel).toMatch(/schedule notetaker/i);
    });

    it("is on + cancel when scheduled (invited)", () => {
      const t = notetakerToggleState(bot({ status: "scheduled" }));
      expect(t.visual).toBe("on");
      expect(t.action).toBe("cancel");
      expect(t.kind).toBe("invited");
    });

    it("is on + cancel for joining / in-call", () => {
      expect(notetakerToggleState(bot({ status: "joining" })).action).toBe(
        "cancel",
      );
      expect(notetakerToggleState(bot({ status: "recording" })).action).toBe(
        "cancel",
      );
    });

    it("is on + none for processing / done (source landed)", () => {
      const processing = notetakerToggleState(bot({ status: "processing" }));
      expect(processing.visual).toBe("on");
      expect(processing.action).toBe("none");

      const done = notetakerToggleState(
        bot({ status: "completed", sourceLanded: true }),
      );
      expect(done.visual).toBe("on");
      expect(done.action).toBe("none");
      expect(done.kind).toBe("done");
    });

    it("resolves via event bot maps (exact event id)", () => {
      const event = eventAt("evt-1", new Date(2026, 4, 27, 15, 0, 0));
      const scheduled = bot({
        botId: "b1",
        calendarEventId: "evt-1",
        status: "scheduled",
      });
      const t = notetakerToggleForEvent(
        event,
        new Map([["evt-1", scheduled]]),
        [scheduled],
      );
      expect(t.visual).toBe("on");
      expect(t.action).toBe("cancel");
    });
  });

  describe("footer label", () => {
    it("formats N CALENDARS CONNECTED · LAST SYNCED relative", () => {
      const synced = new Date(now.getTime() - 5 * 60_000);
      expect(
        formatMeetingsFooterLabel({
          calendarCount: 2,
          lastSyncedAt: synced,
          now,
        }),
      ).toBe("2 CALENDARS CONNECTED · LAST SYNCED 5m ago");

      expect(
        formatMeetingsFooterLabel({
          calendarCount: 1,
          lastSyncedAt: now,
          now,
        }),
      ).toBe("1 CALENDAR CONNECTED · LAST SYNCED just now");
    });

    it("uses never when last sync is unknown", () => {
      expect(
        formatMeetingsFooterLabel({
          calendarCount: 0,
          lastSyncedAt: null,
          now,
        }),
      ).toBe("0 CALENDARS CONNECTED · LAST SYNCED never");
      expect(formatLastSyncedRelative(undefined, now)).toBe("never");
    });
  });

  describe("copy constants", () => {
    it("exports design title line", () => {
      expect(MEETINGS_PAGE_DEK).toBe("agenda, notetaker, and recaps");
      expect(MEETINGS_PAGE_TITLE_LINE).toBe(
        "Meetings — agenda, notetaker, and recaps",
      );
    });
  });
});
