// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { dropCoveredBusy, fitAxis, layoutStrip, packLanes, rangeText, spanOf, DEFAULT_EVENT_MS } from "./brief-strip.js";
import { calendarToday } from "./brief-data.js";
import { octoberEightBrief } from "./brief-fixture.js";
import DailyBrief from "./DailyBrief.svelte";
import type { BriefCalendarEvent } from "./brief-types.js";

const DAY = new Date(2026, 9, 9, 10, 15);
const at = (h: number, m = 0) => new Date(2026, 9, 9, h, m).toISOString();
const ev = (id: string, h0: number, m0: number, h1: number, m1: number, extra: Partial<BriefCalendarEvent> = {}): BriefCalendarEvent => ({
  id,
  title: id,
  start: at(h0, m0),
  end: at(h1, m1),
  kind: "team",
  ...extra,
});

describe("lane packing", () => {
  it("stacks overlaps into the lowest free lane and reuses lanes once free", () => {
    const spans = [
      { start: 9, end: 10 },
      { start: 9.5, end: 10 },
      { start: 9.75, end: 11 },
      { start: 10, end: 10.5 },
      { start: 12, end: 13 },
    ];
    expect(packLanes(spans)).toEqual([0, 1, 2, 0, 0]);
  });

  it("touching events share a lane", () => {
    expect(packLanes([{ start: 1, end: 2 }, { start: 2, end: 3 }])).toEqual([0, 0]);
  });

  it("caps at three lanes and counts the rest", () => {
    const events = [ev("a", 9, 0, 10, 0), ev("b", 9, 0, 10, 0), ev("c", 9, 0, 10, 0), ev("d", 9, 0, 10, 0)];
    const layout = layoutStrip(events, DAY);
    expect(layout.items).toHaveLength(3);
    expect(layout.hidden.map((e) => e.id)).toEqual(["d"]);
    expect(layout.lanes).toBe(3);
  });
});

describe("busy de-dup", () => {
  it("drops busy holds that overlap a named event and keeps the rest", () => {
    const events = [
      ev("Standup", 9, 0, 10, 0),
      ev("b-dup", 9, 0, 10, 0, { busy: true }),
      ev("b-edge", 9, 45, 10, 15, { busy: true }),
      ev("b-alone", 16, 30, 17, 0, { busy: true }),
      ev("b-touch", 10, 0, 10, 30, { busy: true }),
    ];
    expect(dropCoveredBusy(events).map((e) => e.id)).toEqual(["Standup", "b-alone", "b-touch"]);
  });
});

describe("axis fit and widths", () => {
  it("fits the first and last event with 30 minutes of padding", () => {
    const spans = [spanOf(ev("a", 7, 30, 8, 0))!, spanOf(ev("b", 15, 30, 16, 0))!];
    expect(fitAxis(spans, DAY)).toEqual({ h0: 7, h1: 16.5 });
  });

  it("is at least four hours wide and defaults to 8–18 with no events", () => {
    expect(fitAxis([spanOf(ev("a", 12, 0, 12, 30))!], DAY)).toEqual({ h0: 10, h1: 14.5 });
    expect(fitAxis([], DAY)).toEqual({ h0: 8, h1: 18 });
  });

  it("width comes from the real end; a missing end means 30 minutes", () => {
    const layout = layoutStrip([ev("first", 7, 30, 8, 0), ev("short", 13, 15, 13, 30), { ...ev("open", 15, 30, 16, 0), end: null }], DAY);
    const span = layout.h1 - layout.h0;
    const short = layout.items.find((p) => p.e.id === "short")!;
    const open = layout.items.find((p) => p.e.id === "open")!;
    expect(short.w).toBeCloseTo((0.25 / span) * 100, 5);
    expect(open.w).toBeCloseTo((DEFAULT_EVENT_MS / 3_600_000 / span) * 100, 5);
    expect(short.tiny).toBe(true);
  });

  it("marks past events and places the now-line", () => {
    const layout = layoutStrip([ev("early", 8, 0, 9, 0), ev("late", 14, 0, 15, 0)], DAY);
    expect(layout.items.find((p) => p.e.id === "early")!.past).toBe(true);
    expect(layout.items.find((p) => p.e.id === "late")!.past).toBe(false);
    expect(layout.nowX).toBeCloseTo(((10.25 - layout.h0) / (layout.h1 - layout.h0)) * 100, 5);
  });

  it("formats ranges", () => {
    expect(rangeText(ev("a", 7, 30, 8, 0))).toBe("7:30–8 AM");
    expect(rangeText(ev("a", 11, 0, 12, 30))).toBe("11 AM–12:30 PM");
  });
});

describe("calendarToday normalization", () => {
  const raw = [
    { id: "1", summary: "VYG Standup", start: { dateTime: at(7, 30) }, end: { dateTime: at(8, 0) }, status: "confirmed" },
    { id: "2", summary: "HQ Dev Standup", start: { dateTime: at(9, 0) }, end: { dateTime: at(10, 0) }, status: "confirmed" },
    { id: "2b", summary: "HQ Dev Standup", start: { dateTime: at(9, 0) }, end: { dateTime: at(10, 0) }, status: "confirmed" },
    { id: "3", summary: "", start: { dateTime: at(9, 0) }, end: { dateTime: at(10, 0) }, status: "confirmed" },
    { id: "4", summary: "Declined thing", start: { dateTime: at(12, 0) }, end: { dateTime: at(13, 0) }, status: "confirmed", attendees: [{ email: "c@getindigo.ai", self: true, responseStatus: "declined" }] },
    { id: "5", summary: "Jordan Menard / Corey Epstein", start: { dateTime: at(13, 15) }, end: { dateTime: at(13, 30) }, status: "confirmed", hangoutLink: "https://meet.google.com/x", attendees: [{ email: "c@getindigo.ai", self: true, responseStatus: "tentative" }, { email: "jordan@x.com", displayName: "Jordan Menard" }] },
    { id: "6", summary: "All day", start: { date: "2026-10-09" }, end: { date: "2026-10-10" }, status: "confirmed" },
    { id: "7", summary: "Cancelled", start: { dateTime: at(15, 0) }, end: { dateTime: at(16, 0) }, status: "cancelled" },
  ];

  it("keeps real start and end, busy as busy, tentative, attendees and link; drops declined, all-day, cancelled, duplicates", () => {
    const out = calendarToday(raw, DAY, "c@getindigo.ai");
    expect(out.map((e) => [e.title, e.busy ?? false])).toEqual([
      ["VYG Standup", false],
      ["HQ Dev Standup", false],
      ["Busy", true],
      ["Jordan Menard / Corey Epstein", false],
    ]);
    const jordan = out[3]!;
    expect(jordan).toMatchObject({ end: at(13, 30), tentative: true, attendees: ["Jordan Menard"], joinUrl: "https://meet.google.com/x", kind: "ext" });
    const layout = layoutStrip(out, DAY);
    expect(layout.h0).toBe(7);
    expect(layout.items.filter((p) => p.e.busy)).toEqual([]);
  });
});

describe("Today strip render", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("the page shows the Oct 9 calls as top-centre steps: busy left out, the next call active, the rest behind +N more, peek with Open in Meetings", async () => {
    const onopenmeetings = vi.fn();
    target = document.createElement("div");
    document.body.appendChild(target);
    // 3 PM: Rachel's 3:30 call is next.
    app = mount(DailyBrief, { target, props: { input: octoberEightBrief(new Date(2026, 9, 9, 15, 0)), onopenmeetings } });
    flushSync();
    const day = target.querySelector<HTMLElement>('[data-testid="brief-today"]')!;
    expect(day.closest(".b-top")).not.toBeNull();
    const steps = [...day.querySelectorAll<HTMLElement>('[data-testid="brief-day-step"]')];
    expect(steps.length).toBeLessThanOrEqual(5);
    const labels = steps.map((b) => b.getAttribute("aria-label") ?? "");
    expect(labels.some((l) => l.startsWith("Busy"))).toBe(false);
    // Five rows plus "+N more" account for all eight named calls.
    const more = day.querySelector('[data-testid="brief-strip-more"]');
    expect(steps.length + Number(more?.textContent?.match(/\d+/)?.[0] ?? 0)).toBe(8);
    const active = steps.filter((b) => ["now", "next"].includes(b.getAttribute("data-state")!));
    expect(active).toHaveLength(1);
    expect(active[0]!.getAttribute("aria-label")).toContain("Rachel");
    expect(active[0]!.getAttribute("aria-label")).toContain("3:30–4 PM, Next");
    // Earlier calls read Done.
    expect(steps.slice(0, steps.indexOf(active[0]!)).every((b) => b.getAttribute("data-state") === "done")).toBe(true);
    active[0]!.dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 260));
    await tick();
    flushSync();
    const peek = target.querySelector('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("3:30–4 PM");
    expect(peek.textContent).toContain("https://zoom.us/j/000");
    peek.querySelector<HTMLButtonElement>('[data-testid="brief-strip-open-meetings"]')!.click();
    expect(onopenmeetings).toHaveBeenCalled();
  });
});
