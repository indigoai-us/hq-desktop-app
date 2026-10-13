// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./BriefAgendaHarness.test-support.svelte";
import { agendaCalls, agendaHolds, agendaLimit, agendaRows, agendaTitle, countdownText, durationText, kindEyebrow, kindLabel, prepId, prepPrompt } from "./brief-agenda.js";
import type { BriefCalendarEvent } from "./brief-types.js";

// Thursday Oct 8 2026: the fixture day, 07:42 local.
const DAY = new Date(2026, 9, 8, 7, 42);
const at = (hh: number, mm: number) => {
  const d = new Date(DAY);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
};
const NOW = at(7, 42);

/** The fixture's Oct 9 calendar: eight calls and three busy holds, two covered by named events. */
function day(): BriefCalendarEvent[] {
  return [
    { id: "c1", title: "VYG Standup", start: at(7, 30), end: at(8, 0), kind: "team" },
    { id: "c2", title: "HQ Dev Standup", start: at(9, 0), end: at(10, 0), kind: "team" },
    { id: "b1", title: "Busy", start: at(9, 0), end: at(10, 0), kind: "team", busy: true },
    { id: "c3", title: "Jacob / Corey", start: at(9, 30), end: at(10, 0), kind: "team" },
    { id: "c4", title: "HQ Training Series", start: at(11, 0), end: at(11, 45), kind: "learn" },
    { id: "c5", title: "HQ Founder Office Hours", start: at(12, 0), end: at(13, 0), kind: "learn" },
    { id: "b2", title: "Busy", start: at(12, 0), end: at(13, 0), kind: "team", busy: true },
    { id: "c6", title: "Jordan Menard / Corey Epstein", start: at(13, 15), end: at(13, 30), kind: "ext", tentative: true },
    { id: "c7", title: "Lizzie / Corey Epstein – HQ Advisory", start: at(14, 0), end: at(14, 30), kind: "ext", attendees: ["Lizzie"] },
    { id: "c8", title: "30 Min Video/Phone Meeting w/ Rachel Bell", start: at(15, 30), end: at(16, 0), kind: "ext", joinUrl: "https://zoom.us/j/000" },
    { id: "b3", title: "Busy", start: at(16, 30), end: at(17, 0), kind: "team", busy: true },
  ];
}

describe("agenda rows", () => {
  it("shows 5 rows in a two-row or three-column slot and 3 in a W or S", () => {
    expect(agendaLimit(2, 2)).toBe(5);
    expect(agendaLimit(1, 3)).toBe(5);
    expect(agendaLimit(1, 2)).toBe(3);
    expect(agendaLimit(1, 1)).toBe(3);
  });

  it("lists named calls in time order and drops busy holds and unreadable starts", () => {
    const calls = agendaCalls([...day(), { id: "bad", title: "No time", start: "nope", kind: "team" }]);
    expect(calls.map((e) => e.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
    expect(agendaHolds(day()).map((e) => e.id)).toEqual(["b3"]);
  });

  it("folds the uncovered busy holds into one row that reads the running or next hold's end", () => {
    const rows = agendaRows(day(), NOW);
    expect(rows).toHaveLength(9);
    const busy = rows.find((r) => r.kind === "busy")!;
    expect(busy.kind).toBe("busy");
    expect(new Date(busy.end).getHours()).toBe(17);
    expect(rows[rows.length - 1]!.id).toBe("busy");
    // Two standalone holds: the row sits at the one that is still ahead of now.
    const two = agendaRows([...day(), { id: "b0", title: "Busy", start: at(6, 0), end: at(6, 30), kind: "team", busy: true }], NOW);
    const row = two.find((r) => r.kind === "busy")! as Extract<(typeof two)[number], { kind: "busy" }>;
    expect(row.holds.map((h) => h.id)).toEqual(["b0", "b3"]);
    expect(new Date(row.start).getHours()).toBe(16);
    // Without a now, the first hold leads.
    const first = agendaRows([...day(), { id: "b0", title: "Busy", start: at(6, 0), end: at(6, 30), kind: "team", busy: true }], null).find((r) => r.kind === "busy")!;
    expect(new Date(first.start).getHours()).toBe(6);
    expect(agendaRows([], NOW)).toEqual([]);
  });

  it("formats durations", () => {
    expect(durationText(30)).toBe("30m");
    expect(durationText(60)).toBe("1h");
    expect(durationText(90)).toBe("1h 30m");
    expect(durationText(0.2)).toBe("1m");
  });

  it("headline: first call before the day starts, nothing-until in a gap, next-at while a call runs, done after the last", () => {
    expect(agendaTitle(day(), at(7, 0))).toBe("8 calls · first at 7:30 AM");
    expect(agendaTitle(day(), null)).toBe("8 calls · first at 7:30 AM");
    // 7:42: the 7:30 standup is running.
    expect(agendaTitle(day(), NOW)).toBe("8 calls · next at 9 AM");
    expect(agendaTitle(day(), at(10, 15))).toBe("Nothing until 11 AM");
    expect(agendaTitle(day(), at(9, 40))).toBe("8 calls · next at 11 AM");
    expect(agendaTitle(day(), at(15, 45))).toBe("8 calls · last one running");
    expect(agendaTitle(day(), at(18, 0))).toBe("All 8 calls done");
    expect(agendaTitle([day()[0]!], at(6, 0))).toBe("1 call · first at 7:30 AM");
    expect(agendaTitle([], NOW)).toBe("No calls today");
    expect(agendaTitle([day()[2]!], NOW)).toBe("No calls today");
  });

  it("counts down from the brief's now and says when a call started or ended", () => {
    const e = day()[1]!; // 9:00-10:00
    expect(countdownText(e, NOW)).toBe("in 1h 18m");
    expect(countdownText(e, at(8, 30))).toBe("in 30m");
    expect(countdownText(e, at(9, 0))).toBe("started just now");
    expect(countdownText(e, at(9, 10))).toBe("started 10m ago");
    expect(countdownText(e, at(10, 0))).toBe("ended");
    expect(countdownText(e, null)).toBeNull();
    expect(countdownText({ start: "nope" }, NOW)).toBeNull();
  });

  it("names the kind for people and for the eyebrow", () => {
    expect(kindLabel("team")).toBe("team call");
    expect(kindLabel("ext")).toBe("with outside people");
    expect(kindLabel("learn")).toBe("learning session");
    expect(kindEyebrow("ext")).toBe("External");
    expect(kindEyebrow("learn")).toBe("Learning");
    expect(kindEyebrow("team")).toBe("Team");
  });

  it("the prep prompt names the call, its time, length and kind, and asks for a 5-line card", () => {
    const p = prepPrompt(day().find((e) => e.id === "c7")!);
    expect(p).toContain('I have "Lizzie / Corey Epstein – HQ Advisory" today at 2 PM (30m, with outside people).');
    expect(p).toMatch(/5-line prep card/);
    expect(p).not.toContain("projected");
    expect(prepPrompt({ ...day()[1]!, projected: true })).toContain("projected from a recurring series");
    expect(prepPrompt({ id: "x", title: "Open end", start: at(9, 0), kind: "team" })).toContain("(30m, team call)");
    expect(prepId({ id: "c7" })).toBe("prep:c7");
  });
});

describe("Today card", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(props: Record<string, unknown>) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Harness, { target, props: { events: day(), now: NOW, ...props } });
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

  it("at M shows 5 glass rows then +N more whose peek lists the rest, busy row included", async () => {
    render({ rows: 2, cols: 2 });
    expect(q('[data-testid="brief-agenda-title"]')!.textContent).toBe("8 calls · next at 9 AM");
    const rows = qa('[data-testid="brief-agenda-row"]');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.querySelector("b")!.textContent)).toEqual(["VYG Standup", "HQ Dev Standup", "Jacob / Corey", "HQ Training Series", "HQ Founder Office Hours"]);
    expect(rows[0]!.textContent).toContain("7:30 AM");
    expect(rows.every((r) => r.classList.contains("run"))).toBe(true);
    const more = q('[data-testid="brief-agenda-more"]')!;
    expect(more.textContent?.trim()).toBe("+4 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    const lines = [...peek.querySelectorAll('[data-testid="brief-peek-line"]')].map((l) => l.textContent);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Jordan Menard / Corey Epstein");
    expect(lines[3]).toContain("Busy until 5 PM");
  });

  it("at W3 shows 5 rows; at W and S it shows 3; nothing folds when everything fits", () => {
    render({ rows: 1, cols: 3 });
    expect(qa('[data-testid="brief-agenda-row"]')).toHaveLength(5);
    unmount(app!);
    app = null;
    target.remove();
    render({ rows: 1, cols: 2 });
    expect(qa('[data-testid="brief-agenda-row"]')).toHaveLength(3);
    expect(q('[data-testid="brief-agenda-more"]')!.textContent?.trim()).toBe("+6 more");
    unmount(app!);
    app = null;
    target.remove();
    render({ rows: 1, cols: 1, events: day().slice(0, 2) });
    expect(qa('[data-testid="brief-agenda-row"]')).toHaveLength(2);
    expect(q('[data-testid="brief-agenda-more"]')).toBeNull();
  });

  it("busy holds collapse into one 'Busy until' row with a peek of the holds", async () => {
    // With the named events gone, all three holds stand alone: one row, at the first hold still ahead of 7:42.
    render({ rows: 2, cols: 2, events: day().filter((e) => e.busy || e.id === "c1") });
    const rows = qa('[data-testid="brief-agenda-row"]');
    expect(rows.map((r) => r.dataset.kind)).toEqual(["call", "busy"]);
    expect(rows[1]!.querySelector("b")!.textContent).toBe("Busy until 10 AM");
    await hover(rows[1]!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Busy");
    expect(peek.textContent).toContain("Until 10 AM · 3 holds");
    expect(peek.querySelectorAll('[data-testid="brief-peek-line"]')).toHaveLength(3);
    expect(q('[data-testid="brief-peek-prompt"]')).toBeNull();
    unmount(app!);
    app = null;
    target.remove();
    // The full day: only the 4:30 hold is uncovered.
    render({ rows: 2, cols: 2 });
    expect(qa('[data-testid="brief-agenda-row"][data-kind="busy"]')).toHaveLength(0);
    await hover(q('[data-testid="brief-agenda-more"]')!);
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("Busy until 5 PM");
  });

  it("the row peek has the countdown, attendees, join link and a Prep in Claude pill", async () => {
    const launch = vi.fn(async () => null);
    render({ rows: 2, cols: 2, launch });
    await hover(qa('[data-testid="brief-agenda-row"]')[1]!); // HQ Dev Standup 9:00
    let peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("HQ Dev Standup");
    expect(peek.textContent).toContain("9–10 AM · in 1h 18m");
    expect(q('[data-testid="brief-peek-eyebrow"]')!.textContent).toBe("Today · Team");
    const go = q('[data-testid="brief-peek-resume"]')!;
    expect(go.textContent).toBe("Prep in Claude");
    go.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(launch).toHaveBeenCalledWith("claude", expect.stringContaining('I have "HQ Dev Standup" today at 9 AM (1h, team call).'));
    unmount(app!);
    app = null;
    target.remove();
    // Later rows: attendees and the join link.
    render({ rows: 2, cols: 3, events: day().filter((e) => e.id === "c7" || e.id === "c8") });
    await hover(qa('[data-testid="brief-agenda-row"]')[0]!); // Lizzie
    peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("With");
    expect(peek.textContent).toContain("Lizzie");
    await hover(qa('[data-testid="brief-agenda-row"]')[1]!); // Rachel Bell
    peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Join");
    expect(peek.textContent).toContain("https://zoom.us/j/000");
  });

  it("offers Open in Meetings only when the host has it, and marks sample calendars", async () => {
    const open = vi.fn();
    render({ onopenmeetings: open, sample: true });
    await hover(qa('[data-testid="brief-agenda-row"]')[0]!);
    expect(q('[data-testid="brief-sample"]')).not.toBeNull();
    q('[data-testid="brief-agenda-open-meetings"]')!.click();
    expect(open).toHaveBeenCalledTimes(1);
    unmount(app!);
    app = null;
    target.remove();
    render({});
    await hover(qa('[data-testid="brief-agenda-row"]')[0]!);
    expect(q('[data-testid="brief-agenda-open-meetings"]')).toBeNull();
    expect(q('[data-testid="brief-sample"]')).toBeNull();
  });

  it("marks past calls, the running call, projected and tentative ones; the headline follows the clock", () => {
    render({ rows: 2, cols: 2, now: at(9, 40), events: [...day().slice(0, 4), { id: "p1", title: "Projected sync", start: at(10, 30), end: at(10, 45), kind: "team", projected: true }] });
    // c1, c2, c3 and the projected sync (b1 is covered by c2): four calls.
    expect(q('[data-testid="brief-agenda-title"]')!.textContent).toBe("4 calls · next at 10:30 AM");
    const rows = qa('[data-testid="brief-agenda-row"]');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.classList.contains("past")).toBe(true); // VYG Standup ended 8:00
    expect(rows[1]!.classList.contains("live")).toBe(true); // HQ Dev Standup 9-10
    expect(rows[1]!.querySelector('[data-testid="brief-agenda-now"]')!.textContent).toBe("NOW");
    expect(rows[2]!.classList.contains("live")).toBe(true); // Jacob / Corey 9:30-10
    expect(rows[3]!.textContent).toContain("PROJECTED");
    expect(rows[3]!.classList.contains("past")).toBe(false);
    unmount(app!);
    app = null;
    target.remove();
    // 10:15 in a gap: the standup is over, the training series is next, Jordan is tentative.
    render({ rows: 2, cols: 2, now: at(10, 15), events: day().filter((e) => ["c1", "c4", "c6"].includes(e.id)) });
    expect(q('[data-testid="brief-agenda-title"]')!.textContent).toBe("Nothing until 11 AM");
    const tent = qa('[data-testid="brief-agenda-row"]').find((r) => r.textContent?.includes("Jordan Menard"))!;
    expect(tent.textContent).toContain("MAYBE");
    expect(tent.classList.contains("tent")).toBe(true);
    expect(qa('[data-testid="brief-agenda-row"]')[0]!.classList.contains("past")).toBe(true);
  });
});
