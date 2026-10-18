// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./BriefMeetingsHarness.test-support.svelte";
import {
  capsuleLabel,
  capsuleOf,
  initials,
  lengthText,
  meetingAxis,
  meetingLabel,
  meetingPeople,
  meetingWindowFrom,
  meetingsFooter,
  meetingsLimit,
  meetingsMinutes,
  meetingsShown,
  shiftDay,
  signalsText,
} from "./brief-meetings.js";
import { clockLabel } from "./brief-time.js";
import type { BriefDay, BriefMeeting } from "./brief-types.js";

// Sunday Oct 11 2026, 08:53 local: the real run's morning.
const NOW = new Date(2026, 9, 11, 8, 53);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function meeting(id: string, title: string, over: Partial<BriefMeeting> = {}): BriefMeeting {
  return { id, title, startTime: hoursAgo(20), companyUid: "cmp_indigo", decisions: 0, actions: 0, risks: 0, questions: 0, ...over };
}

/** Seven attended meetings inside the window, one declined, one from two days ago. */
function day(): BriefMeeting[] {
  return [
    meeting("m1", "HQ Dev Standup", { startTime: hoursAgo(23), decisions: 2, actions: 1, durationMin: 30, decided: ["Ship the trial page Friday", "Drop the old pricing"] }),
    meeting("m2", "Jacob / Corey", { with: "Jacob", startTime: hoursAgo(22), decisions: 1, decided: ["Move standup"] }),
    meeting("m3", "HQ GTM Sync", { startTime: hoursAgo(21), decisions: 3, actions: 4, risks: 1, durationMin: 75, todo: [{ text: "Write the pricing FAQ", owner: "Corey", mine: true }] }),
    meeting("m4", "Hunter Durham", { startTime: hoursAgo(19), actions: 2, durationMin: 45 }),
    meeting("m5", "HQ Training Series", { startTime: hoursAgo(18), durationMin: 60 }),
    meeting("m6", "Matt Wahl", { startTime: hoursAgo(6), decisions: 1, decided: ["Send the deck"] }),
    meeting("m7", "Lizzie advisory", { with: "Lizzie", startTime: hoursAgo(3) }),
    meeting("m8", "Declined all-hands", { startTime: hoursAgo(5), attended: false, decisions: 9 }),
    meeting("m9", "Two days ago", { startTime: hoursAgo(40), decisions: 4 }),
  ];
}

const DAYS: BriefDay[] = [
  { date: "2026-10-09", sessions: 3, meetings: 2, merged: 5, opened: 1 },
  { date: "2026-10-10", sessions: 6, meetings: 7, merged: 23, opened: 4 },
];

describe("meetings rows", () => {
  it("shows 5 rows in a two-row or three-column slot and 3 in a W or S", () => {
    expect(meetingsLimit(2, 2)).toBe(5);
    expect(meetingsLimit(1, 3)).toBe(5);
    expect(meetingsLimit(1, 2)).toBe(3);
    expect(meetingsLimit(1, 1)).toBe(3);
  });

  it("computes the window the way the catalogue does: 24h back, or the last brief on a catch-up day", () => {
    const now = NOW.toISOString();
    expect(meetingWindowFrom(null, null)).toBeNull();
    expect(meetingWindowFrom("not a time", null)).toBeNull();
    expect(meetingWindowFrom(now, null)).toBe(NOW.getTime() - 86_400_000);
    expect(meetingWindowFrom(now, hoursAgo(4 * 24))).toBe(NOW.getTime() - 4 * 24 * 3_600_000);
    // A window start after now is nonsense: fall back to 24h.
    expect(meetingWindowFrom(now, new Date(NOW.getTime() + 3_600_000).toISOString())).toBe(NOW.getTime() - 86_400_000);
  });

  it("drops declined meetings and anything outside the window, oldest first", () => {
    const shown = meetingsShown(day(), NOW.toISOString());
    expect(shown.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    // Without a now, the catalogue gate is the only window; attendance still applies.
    expect(meetingsShown(day(), null).map((m) => m.id)).toEqual(["m9", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    // A catch-up window reaches the older meeting.
    expect(meetingsShown(day(), NOW.toISOString(), hoursAgo(4 * 24)).map((m) => m.id)).toContain("m9");
  });

  it("writes the signals line with real plurals and only the counts above zero", () => {
    expect(signalsText({ decisions: 3, actions: 4, risks: 1 })).toBe("3 decisions · 4 action items · 1 risk");
    expect(signalsText({ decisions: 1, actions: 0, risks: 0 })).toBe("1 decision");
    expect(signalsText({ decisions: 0, actions: 2, risks: 0 })).toBe("2 action items");
    expect(signalsText({ decisions: 0, actions: 0, risks: 0 })).toBeNull();
  });

  it("formats the length and skips it when unknown", () => {
    expect(lengthText(45)).toBe("45m");
    expect(lengthText(60)).toBe("1h");
    expect(lengthText(75)).toBe("1h 15m");
    expect(lengthText(0)).toBeNull();
    expect(lengthText(null)).toBeNull();
    expect(lengthText(undefined)).toBeNull();
    expect(lengthText(Number.NaN)).toBeNull();
  });

  it("labels a row with who it was with", () => {
    expect(meetingLabel({ title: "Jacob / Corey", with: "Jacob" })).toBe("Jacob / Corey · Jacob");
    expect(meetingLabel({ title: "HQ GTM Sync" })).toBe("HQ GTM Sync");
  });

  it("shifts a local day by arithmetic, across month ends", () => {
    expect(shiftDay("2026-10-11", -1)).toBe("2026-10-10");
    expect(shiftDay("2026-10-01", -2)).toBe("2026-09-29");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("nope", -1)).toBeNull();
  });

  it("writes the day-over-day line in plain words, only when both yesterday and the day before are known", () => {
    const pair = (y: number, b: number): BriefDay[] => [
      { date: "2026-10-10", sessions: 1, meetings: y, merged: 0, opened: 0 },
      { date: "2026-10-09", sessions: 1, meetings: b, merged: 0, opened: 0 },
    ];
    expect(meetingsFooter(DAYS, "2026-10-11")).toBe("Up from 2 the day before");
    expect(meetingsFooter(pair(2, 3), "2026-10-11")).toBe("Down from 3 the day before");
    expect(meetingsFooter(pair(4, 4), "2026-10-11")).toBe("Same as the day before");
    expect(meetingsFooter(pair(1, 0), "2026-10-11")).toBe("Up from none the day before");
    // A catch-up card counts more than yesterday, so the line names both days.
    expect(meetingsFooter(DAYS, "2026-10-11", true)).toBe("7 yesterday, 2 the day before");
    expect(meetingsFooter(pair(3, 0), "2026-10-11", true)).toBe("3 yesterday, none the day before");
    expect(meetingsFooter([{ date: "2026-10-10", sessions: 1, meetings: 1, merged: 0, opened: 0 }], "2026-10-11")).toBeNull();
    expect(meetingsFooter(DAYS, "2026-10-12")).toBeNull();
    expect(meetingsFooter(DAYS, null)).toBeNull();
    expect(meetingsFooter([], "2026-10-11")).toBeNull();
  });

  it("reads who a meeting was with from `with`, named to-do owners, and a title made only of names", () => {
    expect(meetingPeople({ title: "Jacob / Corey" })).toEqual(["Jacob", "Corey"]);
    expect(meetingPeople({ title: "Don Ranns and Jacob Posel" })).toEqual(["Don Ranns", "Jacob Posel"]);
    expect(meetingPeople({ title: "Matt Wahl" })).toEqual([]);
    expect(meetingPeople({ title: "Matt Wahl", with: "Matt Wahl" })).toEqual(["Matt Wahl"]);
    // A meeting word or an acronym in the title means it names a meeting, not people.
    expect(meetingPeople({ title: "HQ <> Sales Sync" })).toEqual([]);
    expect(meetingPeople({ title: "HQ Dev Standup" })).toEqual([]);
    expect(meetingPeople({ title: "TG and Amir Torabi + Jacob Posel" })).toEqual([]);
    // To-do owners are people who were there; your own to-do is not someone else; first names do not repeat.
    expect(
      meetingPeople({ title: "Jacob / Corey", with: "Jacob", todo: [{ text: "a", owner: "Hassaan" }, { text: "b", owner: "Corey", mine: true }, { text: "c", owner: "corey" }] }),
    ).toEqual(["Jacob", "Corey", "Hassaan"]);
    expect(initials("Jacob Posel")).toBe("JP");
    expect(initials("Corey")).toBe("C");
    expect(initials("ana maria de la cruz")).toBe("AC");
    expect(initials("  ")).toBe("");
  });

  it("lays the meetings on a whole-hour axis at least four hours wide, with round-step hour ticks", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m).toISOString();
    const axis = meetingAxis([
      { startTime: at(10), durationMin: 30 },
      { startTime: at(12, 15), durationMin: 45 },
    ])!;
    // 10 AM to 1 PM is three hours: the axis grows to four, the spare hour after the last meeting.
    expect(new Date(axis.from).getHours()).toBe(10);
    expect(new Date(axis.to).getHours()).toBe(14);
    expect(axis.days).toBe(false);
    expect(axis.ticks.map((t) => t.label)).toEqual(["10 AM", "11 AM", "12 PM", "1 PM", "2 PM"]);
    expect(axis.ticks[0]!.at).toBe(0);
    expect(axis.ticks[4]!.at).toBe(1);
    // A long day steps its ticks so there are never more than asked for.
    const long = meetingAxis([{ startTime: at(8), durationMin: 60 }, { startTime: at(18), durationMin: 60 }], 5)!;
    expect(long.ticks.length).toBeLessThanOrEqual(5);
    expect(long.ticks[0]!.label).toBe("8 AM");
    // A capsule starts at its time and is as long as the meeting; an unknown length is a dot.
    const c = capsuleOf({ startTime: at(10), durationMin: 30 }, axis);
    expect(c.left).toBe(0);
    expect(c.width).toBeCloseTo(0.125);
    expect(capsuleOf({ startTime: at(12), durationMin: null }, axis)).toEqual({ left: 0.5, width: null });
    // Clamped to the axis: a meeting running past the end stops at it.
    expect(capsuleOf({ startTime: at(13), durationMin: 180 }, axis).width).toBeCloseTo(0.25);
    expect(meetingAxis([])).toBeNull();
    expect(meetingAxis([{ startTime: "nope" }])).toBeNull();
  });

  it("an axis over more than a day (a catch-up) runs midnight to midnight with weekday ticks", () => {
    const axis = meetingAxis([
      { startTime: new Date(2026, 9, 12, 15).toISOString() },
      { startTime: new Date(2026, 9, 14, 9).toISOString() },
    ])!;
    expect(axis.days).toBe(true);
    expect(new Date(axis.from).getHours()).toBe(0);
    expect(axis.ticks.map((t) => t.label)).toEqual(["MON", "TUE", "WED"]);
    expect(capsuleLabel({ startTime: new Date(2026, 9, 14, 9).toISOString() }, true)).toBe("WED 9 AM");
  });

  it("labels a capsule with its time and length, and totals time only when every length is known", () => {
    const iso = new Date(2026, 9, 10, 10, 30).toISOString();
    expect(capsuleLabel({ startTime: iso, durationMin: 45 })).toBe("10:30 AM · 45m");
    expect(capsuleLabel({ startTime: iso })).toBe(clockLabel(iso));
    expect(capsuleLabel({ startTime: "nope" })).toBe("");
    expect(meetingsMinutes([{ durationMin: 30 }, { durationMin: 75 }])).toBe(105);
    expect(meetingsMinutes([{ durationMin: 30 }, { durationMin: null }])).toBeNull();
    expect(meetingsMinutes([])).toBeNull();
  });
});

describe("Yesterday card", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  const COMPANIES = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo", iconUrl: null }];

  function render(props: Record<string, unknown>) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Harness, { target, props: { meetings: day(), now: NOW.toISOString(), today: "2026-10-11", days: DAYS, companies: COMPANIES, ...props } });
    flushSync();
  }
  const q = (sel: string) => target.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
  async function hover(el: Element): Promise<void> {
    el.dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 260));
    flushSync();
  }

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("at M shows 5 rows then +N more, counting only attended meetings inside the window", async () => {
    render({ rows: 2, cols: 2 });
    const rows = qa('[data-testid="brief-meeting-row"]');
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["HQ Dev Standup", "Jacob / Corey", "HQ GTM Sync", "Hunter Durham", "HQ Training Series"]);
    expect(q('[data-testid="brief-meetings-sub"]')!.textContent).toBe("decisions from 7 meetings");
    expect(q('[data-testid="brief-meetings"]')!.textContent).not.toContain("Declined all-hands");
    expect(q('[data-testid="brief-meetings"]')!.textContent).not.toContain("Two days ago");
    const more = q('[data-testid="brief-meetings-more"]')!;
    expect(more.textContent?.trim()).toBe("+2 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("2 more");
    const lines = [...peek.querySelectorAll('[data-testid="brief-peek-line"]')].map((l) => l.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Matt Wahl");
    expect(lines[0]).toContain("1 decided");
    expect(lines[1]).toContain("Lizzie advisory · Lizzie");
  });

  it("at W3 shows 5 rows; at W and S it shows 3", () => {
    render({ rows: 1, cols: 3 });
    expect(qa('[data-testid="brief-meeting-row"]')).toHaveLength(5);
    expect(q('[data-testid="brief-meetings-more"]')!.textContent?.trim()).toBe("+2 more");
    unmount(app!);
    app = null;
    target.remove();
    render({ rows: 1, cols: 2 });
    expect(qa('[data-testid="brief-meeting-row"]')).toHaveLength(3);
    expect(q('[data-testid="brief-meetings-more"]')!.textContent?.trim()).toBe("+4 more");
    unmount(app!);
    app = null;
    target.remove();
    render({ rows: 1, cols: 1 });
    expect(qa('[data-testid="brief-meeting-row"]')).toHaveLength(3);
  });

  it("no +N more row when everything fits", () => {
    render({ meetings: day().slice(0, 3) });
    expect(qa('[data-testid="brief-meeting-row"]')).toHaveLength(3);
    expect(q('[data-testid="brief-meetings-more"]')).toBeNull();
  });

  it("the row peek keeps Decided and To do and adds Signals, Length and the company chip", async () => {
    render({});
    const row = qa('[data-testid="brief-meeting-row"]')[2]!; // HQ GTM Sync
    await hover(row);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("HQ GTM Sync");
    expect(peek.textContent).toContain("Signals");
    expect(peek.textContent).toContain("3 decisions · 4 action items · 1 risk");
    expect(peek.textContent).toContain("Length");
    expect(peek.textContent).toContain("1h 15m");
    expect(peek.textContent).toContain("Write the pricing FAQ");
    expect(q('[data-testid="brief-peek-tag"]')!.textContent).toBe("you");
    expect(q('[data-testid="brief-peek-eyebrow"]')!.textContent).toMatch(/^Meeting · \d{1,2}(:\d{2})? [AP]M$/);
    expect(q('[data-testid="brief-peek-origin"]')!.textContent).toContain("Indigo · meetings");
  });

  it("a meeting with no signals and no length gets neither section", async () => {
    render({});
    await hover(qa('[data-testid="brief-meeting-row"]')[4]!); // HQ Training Series: 60m, no signals
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).not.toContain("Signals");
    expect(peek.textContent).toContain("Length");
    expect(peek.textContent).toContain("1h");
    unmount(app!);
    app = null;
    target.remove();
    render({ meetings: [meeting("x", "Quick chat")] });
    await hover(q('[data-testid="brief-meeting-row"]')!);
    expect(q('[data-testid="brief-peek"]')!.textContent).not.toContain("Length");
  });

  it("the caption compares yesterday with the day before, only in a two-row slot", () => {
    render({ rows: 2 });
    expect(q('[data-testid="brief-meetings-foot"]')!.textContent).toBe("Up from 2 the day before");
    unmount(app!);
    app = null;
    target.remove();
    render({ rows: 1, cols: 3 });
    expect(q('[data-testid="brief-meetings-foot"]')).toBeNull();
    unmount(app!);
    app = null;
    target.remove();
    render({ rows: 2, days: [] });
    expect(q('[data-testid="brief-meetings-foot"]')).toBeNull();
  });

  it("without a now the catalogue gate is the only window, and declined meetings still never show", () => {
    render({ now: null });
    expect(q('[data-testid="brief-meetings-sub"]')!.textContent).toBe("decisions from 8 meetings");
    expect(q('[data-testid="brief-meetings"]')!.textContent).toContain("Two days ago");
    expect(q('[data-testid="brief-meetings"]')!.textContent).not.toContain("Declined all-hands");
  });

  it("a catch-up window reaches further back, and its comparison names both days", () => {
    render({ windowFrom: hoursAgo(4 * 24) });
    expect(q('[data-testid="brief-meetings-sub"]')!.textContent).toBe("decisions from 8 meetings");
    expect(q('[data-testid="brief-meetings-foot"]')!.textContent).toBe("7 yesterday, 2 the day before");
  });

  it("each row shows when it started and how long it ran, on a capsule along the card's shared time axis", () => {
    render({});
    const rows = qa('[data-testid="brief-meeting-row"]');
    const at = rows.map((r) => r.querySelector('[data-testid="brief-meeting-at"]')!.textContent);
    expect(at[0]).toBe(`${clockLabel(hoursAgo(23))} · 30m`);
    expect(at[1]).toBe(clockLabel(hoursAgo(22)));
    expect(at[2]).toBe(`${clockLabel(hoursAgo(21))} · 1h 15m`);
    // Capsules sit in time order along the same axis.
    const lefts = rows.map((r) => Number(r.querySelector<HTMLElement>(".mark")!.style.getPropertyValue("--l")));
    expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
    expect(lefts[0]).toBeGreaterThanOrEqual(0);
    expect(lefts[4]).toBeLessThanOrEqual(1);
  });

  it("shows who a meeting was with as initials, and the meeting that left you a to-do in the accent with a 'for you' pill", () => {
    render({});
    const rows = qa('[data-testid="brief-meeting-row"]');
    const ppl = rows[1]!.querySelector('[role="img"]')!;
    expect(ppl.getAttribute("aria-label")).toBe("With Jacob, Corey");
    expect([...ppl.querySelectorAll("i")].map((i) => i.textContent)).toEqual(["J", "C"]);
    expect(rows[0]!.querySelector('[role="img"]')).toBeNull(); // HQ Dev Standup names nobody
    expect(rows.filter((r) => r.classList.contains("yours")).map((r) => r.getAttribute("aria-label"))).toEqual(["HQ GTM Sync"]);
    expect(rows[2]!.querySelector('[data-testid="brief-meeting-yours"]')!.textContent).toBe("1 for you");
    // One column: no room for initials or the pill; the accent capsule still marks it.
    unmount(app!);
    app = null;
    target.remove();
    render({ rows: 1, cols: 1 });
    expect(q('[data-testid="brief-meetings"] [role="img"]')).toBeNull();
    expect(q('[data-testid="brief-meeting-yours"]')).toBeNull();
    expect(qa('[data-testid="brief-meeting-row"]')[2]!.classList.contains("yours")).toBe(true);
  });

  it("alone, it carries the decisions: the number counts them and each row shows its first", () => {
    render({});
    expect(q('[data-testid="brief-meetings-sub"]')!.textContent).toBe("decisions from 7 meetings");
    expect(qa('[data-testid="brief-meeting-first"]').map((e) => e.textContent)).toEqual(["Ship the trial page Friday", "Move standup"]);
    // The count pill only where the first decision does not already say it.
    const decided = qa('[data-testid="brief-meeting-row"]').map((r) => r.querySelector('[data-testid="brief-meeting-decided"]')?.textContent ?? null);
    expect(decided).toEqual(["2 decided", null, "3 decided", null, null]);
  });

  it("with the Settled card on the page it keeps to the meetings: the number counts meetings and no decision text repeats", () => {
    render({ settled: true });
    expect(q('[data-testid="brief-meetings-sub"]')!.textContent).toBe("meetings since yesterday");
    expect(qa('[data-testid="brief-meeting-first"]')).toEqual([]);
    expect(q('[data-testid="brief-meetings"]')!.textContent).not.toContain("Ship the trial page Friday");
    const decided = qa('[data-testid="brief-meeting-row"]').map((r) => r.querySelector('[data-testid="brief-meeting-decided"]')?.textContent ?? null);
    expect(decided).toEqual(["2 decided", "1 decided", "3 decided", null, null]);
    unmount(app!);
    app = null;
    target.remove();
    render({ settled: true, windowFrom: hoursAgo(4 * 24) });
    expect(q('[data-testid="brief-meetings-sub"]')!.textContent).toBe("meetings while you were away");
  });

  it("the number counts decisions when the card carries them, meetings when Settled does", () => {
    // Reduced motion: the number shows its value at once instead of counting up.
    const mm = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query })) as unknown as typeof window.matchMedia;
    try {
      render({ meetings: day().slice(0, 3) }); // 3 meetings, 6 decisions
      expect(q('[data-testid="brief-meetings"] .num')!.textContent).toBe("6");
      unmount(app!);
      app = null;
      target.remove();
      render({ meetings: day().slice(0, 3), settled: true });
      expect(q('[data-testid="brief-meetings"] .num')!.textContent).toBe("3");
    } finally {
      window.matchMedia = mm;
    }
  });

  it("totals the time in meetings when every length is known", () => {
    render({ meetings: [meeting("a", "One", { durationMin: 30 }), meeting("b", "Two", { startTime: hoursAgo(10), durationMin: 75 })] });
    expect(q('[data-testid="brief-meetings"] .vs')!.textContent).toContain("1h 45m in meetings");
    unmount(app!);
    app = null;
    target.remove();
    render({ meetings: [meeting("a", "One", { durationMin: 30 }), meeting("b", "Two", { startTime: hoursAgo(10) })], days: [] });
    expect(q('[data-testid="brief-meetings"] .vs')).toBeNull();
  });
});
