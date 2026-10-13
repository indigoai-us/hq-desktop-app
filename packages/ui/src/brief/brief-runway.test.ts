// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { buildContext, CATALOGUE } from "./brief-catalogue.js";
import { empty } from "./brief-catalogue-fixtures.js";
import {
  calendarDraft,
  clockMin,
  focusGaps,
  focusRunway,
  gapClass,
  gapRange,
  minutesText,
  pct,
  priorityLaunchId,
  priorityPrompt,
  runwayTitle,
  suggestionFor,
  WORKDAY_END_MIN,
  WORKDAY_START_MIN,
} from "./brief-runway.js";
import type { BriefCalendarEvent, BriefPriority } from "./brief-types.js";
import BriefRunwayHost from "./fixtures/BriefRunwayHost.svelte";

// Wednesday 2026-10-14, in the machine's local time so the 8:00–18:00 workday reads the same everywhere.
const at = (h: number, m = 0) => new Date(2026, 9, 14, h, m).toISOString();
const NOW = at(7, 42);
const ev = (id: string, title: string, sh: number, sm: number, eh: number, em: number, extra: Partial<BriefCalendarEvent> = {}): BriefCalendarEvent => ({
  id,
  title,
  start: at(sh, sm),
  end: at(eh, em),
  kind: "team",
  ...extra,
});

/** Early call before the day, standup, office hours, an investor call, dinner after the day. */
const DAY: BriefCalendarEvent[] = [
  ev("e0", "Early sync", 7, 0, 7, 30),
  ev("e1", "Standup", 9, 0, 9, 15),
  ev("e2", "Cut30 office hours", 13, 0, 14, 0, { kind: "learn" }),
  ev("e3", "Investor call", 15, 0, 15, 45, { kind: "ext", attendees: ["Jonathan", "Geoff"] }),
  ev("e4", "Dinner", 19, 0, 20, 0),
];
/** Seven short calls on the hour: eight gaps, six of them 25 minutes. */
const BUSY_DAY: BriefCalendarEvent[] = [9, 10, 11, 12, 13, 14, 15].map((h) => ev(`h${h}`, `Call ${h}`, h, 0, h, 15));
/** Booked solid except 35 raw minutes mid-afternoon (15 once padded). */
const SOLID_DAY: BriefCalendarEvent[] = [ev("a", "Workshop", 8, 0, 14, 35), ev("b", "Board prep", 15, 10, 18, 0)];

const PRIORITIES: BriefPriority[] = [
  { n: 1, text: "Close out the SAFE allotment", because: "Investors and the round close wait on it", itemId: "d1" },
  { n: 2, text: "hq-core #1201: fix(release): cut the desktop release", because: null, itemId: "d6" },
  { n: 3, text: "Reply to Jacob about the memo folder", because: "He asked twice", itemId: null },
];
const PROMPTS: Record<string, string> = { d1: "Prompt for the SAFE allotment.", d6: "Prompt for the release cut." };

describe("focusGaps", () => {
  it("pads every call 10 minutes, ignores time outside 8:00–18:00, and ranks by length", () => {
    const gaps = focusGaps(DAY, NOW);
    expect(gaps.map((g) => [gapRange(g), g.minutes, g.rank])).toEqual([
      ["8:00–8:50", 50, 3],
      ["9:25–12:50", 205, 1],
      ["2:10–2:50", 40, 4],
      ["3:55–6:00", 125, 2],
    ]);
    // The early call pads to 7:40 and never reaches the day; dinner starts after it.
    expect(gaps[0]!.after).toBeNull();
    expect(gaps[0]!.before?.title).toBe("Standup");
    expect(gaps[1]!.after?.title).toBe("Standup");
    expect(gaps[1]!.before?.title).toBe("Cut30 office hours");
    expect(gaps[3]!.after?.title).toBe("Investor call");
    expect(gaps[3]!.before).toBeNull();
    const r = focusRunway(DAY, NOW);
    expect(r.pills.map((p) => p.event.id)).toEqual(["e1", "e2", "e3"]);
    expect(r.protect?.rank).toBe(1);
    expect(r.ranked.map((g) => g.minutes)).toEqual([205, 125, 50, 40]);
  });

  it("classes deep, solid and shallow at 95, 60 and 30 minutes", () => {
    expect([gapClass(95), gapClass(60), gapClass(30)]).toEqual(["deep", "solid", "shallow"]);
    expect([gapClass(90), gapClass(89), gapClass(50), gapClass(49)]).toEqual(["deep", "solid", "solid", "shallow"]);
    const events = [ev("a", "A", 9, 45, 10, 0), ev("b", "B", 11, 20, 11, 40), ev("c", "C", 12, 30, 18, 0)];
    expect(focusGaps(events, NOW).map((g) => [g.minutes, g.cls])).toEqual([
      [95, "deep"],
      [60, "solid"],
      [30, "shallow"],
    ]);
  });

  it("walks from now when the brief sits inside the day: a consumed gap is gone, the live one starts now", () => {
    const r = focusRunway(DAY, at(10, 30));
    expect(r.gaps.map((g) => gapRange(g))).toEqual(["10:30–12:50", "2:10–2:50", "3:55–6:00"]);
    expect(r.protect?.after).toBeNull();
    expect(r.protect?.before?.title).toBe("Cut30 office hours");
    expect(runwayTitle(r)).toBe("2h 20m clear before Cut30 office hours. Protect it.");
    expect(r.nowMin).toBe(10 * 60 + 30);
  });

  it("a call with no end runs 30 minutes; a busy hold counts as busy", () => {
    const r = focusRunway([{ id: "x", title: "", start: at(9, 0), kind: "team", busy: true }], NOW);
    expect(r.gaps.map((g) => gapRange(g))).toEqual(["8:00–8:50", "9:40–6:00"]);
    expect(r.pills[0]!.endMin).toBe(9 * 60 + 30);
  });

  it("drops unparsable starts and a bad now without throwing", () => {
    expect(focusGaps([{ id: "x", title: "X", start: "nope", kind: "team" }], NOW).map((g) => g.minutes)).toEqual([600]);
    const r = focusRunway(DAY, "not a time");
    expect(r.gaps).toEqual([]);
    expect(r.nowMin).toBeNull();
  });
});

describe("runway words", () => {
  it("formats minutes, clocks, ranges and positions without toLocale", () => {
    expect([minutesText(40), minutesText(120), minutesText(205)]).toEqual(["40 min", "2h", "3h 25m"]);
    expect([clockMin(14 * 60 + 45), clockMin(9 * 60 + 25, true), clockMin(12 * 60, true), clockMin(18 * 60)]).toEqual(["2:45", "9:25 AM", "12:00 PM", "6:00"]);
    expect([pct(WORKDAY_START_MIN), pct(13 * 60), pct(WORKDAY_END_MIN), pct(7 * 60), pct(20 * 60)]).toEqual([0, 50, 100, 0, 100]);
  });

  it("titles: protect the longest gap; whole day open; overloaded names the longest short gap; after hours", () => {
    expect(runwayTitle(focusRunway(DAY, NOW))).toBe("3h 25m clear after Standup. Protect it.");
    expect(runwayTitle(focusRunway([], NOW))).toBe("Whole day open. Pick the hardest thing first.");
    const solid = focusRunway(SOLID_DAY, NOW);
    expect(solid.gaps).toEqual([]);
    expect(runwayTitle(solid)).toBe("No focus block today. Longest gap is 15 min at 2:45.");
    expect(runwayTitle(focusRunway(DAY, at(19, 0)))).toBe("No focus time left today.");
    const open = focusRunway([ev("z", "Dinner", 19, 0, 20, 0)], NOW);
    expect(runwayTitle(open)).toBe("10h clear until 6:00. Protect it.");
  });

  it("the longest gap takes priority 1, the next priority 2; prompts fall back to the priority's own words", () => {
    const r = focusRunway(DAY, NOW);
    expect(suggestionFor(PRIORITIES, r.ranked[0]!)?.n).toBe(1);
    expect(suggestionFor(PRIORITIES, r.ranked[1]!)?.n).toBe(2);
    expect(suggestionFor(PRIORITIES, r.ranked[3]!)).toBeNull();
    expect(priorityLaunchId(PRIORITIES[0]!)).toBe("d1");
    expect(priorityLaunchId(PRIORITIES[2]!)).toBe("priority:3");
    const prompt = priorityPrompt(PRIORITIES[2]!, r.ranked[2]!);
    expect(prompt).toContain("Today's priority 3: Reply to Jacob about the memo folder. He asked twice.");
    expect(prompt).toContain("50 min clear (8:00 AM–8:50 AM)");
    expect(prompt).toMatch(/Ask before anything irreversible/);
  });

  it("the calendar draft is text to paste, with the day and a 12-hour range", () => {
    const draft = calendarDraft(focusRunway(DAY, NOW).protect!, "Close out the SAFE allotment", "Wed, Oct 14");
    expect(draft.split("\n")).toEqual([
      "Focus block: Close out the SAFE allotment",
      "Wed, Oct 14 · 9:25 AM–12:50 PM",
      "Protected focus time from your Daily Brief. Not booked yet: paste this into your calendar.",
    ]);
    expect(calendarDraft(focusRunway(DAY, NOW).protect!, null, "Wed, Oct 14")).toMatch(/^Focus block\n/);
  });
});

describe("picker agreement", () => {
  const entry = CATALOGUE.find((e) => e.id === "runway")!;
  const input = (today: string) => ({ ...empty(NOW, today), calendarToday: DAY, priorities: PRIORITIES });

  it("is hidden on Saturday even with calls, and measured on a weekday with calls and priorities", () => {
    expect(entry.measure(buildContext(input("2026-10-17")))).toBeNull();
    const ev = entry.measure(buildContext(input("2026-10-14")));
    expect(ev).not.toBeNull();
    expect(ev!.value).toBe(3);
    expect(ev!.fact).toMatch(/clear after Standup$/);
    expect(entry.fits).toEqual(["W3", "W", "M"]);
  });

  it("is hidden with no priorities or no timed call", () => {
    expect(entry.measure(buildContext({ ...input("2026-10-14"), priorities: [] }))).toBeNull();
    expect(entry.measure(buildContext({ ...input("2026-10-14"), calendarToday: [] }))).toBeNull();
  });
});

describe("BriefRunway", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  const base = { events: DAY, priorities: PRIORITIES, prompts: PROMPTS, now: NOW, sample: false, cols: 3, rows: 1 };

  function render(props: Partial<typeof base> = {}) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefRunwayHost, { target, props: { ...base, ...props } });
    flushSync();
  }
  const q = (sel: string) => target.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
  const text = (sel: string) => q(sel)?.textContent?.trim();
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

  it("draws the runway: calls as pills, gaps classed, the longest glowing, the needle from now", () => {
    render();
    expect(text('[data-testid="brief-runway-title"]')).toBe("3h 25m clear after Standup. Protect it.");
    expect(qa('[data-testid="brief-runway-pill"]').map((p) => p.textContent?.trim())).toEqual(["Standup", "Cut30 office hours", "Investor call"]);
    const gaps = qa('[data-testid="brief-runway-gap"]');
    expect(gaps.map((g) => g.dataset.cls)).toEqual(["solid", "deep", "shallow", "deep"]);
    const pro = gaps.filter((g) => g.classList.contains("pro"));
    expect(pro).toHaveLength(1);
    expect(pro[0]!.dataset.rank).toBe("1");
    expect(q('[data-testid="brief-runway"]')!.dataset.protect).toBe(`${9 * 60 + 25}-${12 * 60 + 50}`);
    expect(q('[data-testid="brief-runway-now"]')).toBeNull(); // 7:42 is before the runway starts
    expect(q(".rul")!.textContent).toBe("8:0010:0012:002:004:006:00");
  });

  it("the needle sits at now inside the day", () => {
    render({ now: at(13, 0) });
    expect(q('[data-testid="brief-runway-now"]')!.style.left).toBe("50%");
  });

  it("rows take the ranked gaps in order, priority 1 on the longest, in plain words; +N more lists the rest", async () => {
    render();
    const rows = qa('[data-testid="brief-runway-row"]');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.dataset.rank)).toEqual(["1", "2", "3"]);
    expect(qa('[data-testid="brief-runway-task"]').map((t) => t.textContent)).toEqual([
      "Close out the SAFE allotment",
      "Cut the desktop release",
      "Reply to Jacob about the memo folder",
    ]);
    expect(rows[0]!.textContent).toContain("3h 25m · 9:25–12:50");
    expect(rows[0]!.textContent).toContain("protect");
    expect(rows.map((r) => r.dataset.launch)).toEqual(["d1", "d6", "priority:3"]);
    const more = q('[data-testid="brief-runway-more"]')!;
    expect(more.textContent?.trim()).toBe("+1 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("1 more gap");
    const lines = qa('[data-testid="brief-peek-line"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toContain("40 min · 2:10–2:50");
  });

  it("caps at five rows in a tall slot and three or two in a short one, with the rest behind +N more", async () => {
    render({ events: BUSY_DAY, rows: 2, cols: 2 });
    expect(q('[data-testid="brief-runway"]')!.dataset.gaps).toBe("8");
    expect(qa('[data-testid="brief-runway-row"]')).toHaveLength(5);
    expect(text('[data-testid="brief-runway-more"]')).toBe("+3 more");
    await hover(q('[data-testid="brief-runway-more"]')!);
    expect(qa('[data-testid="brief-peek-line"]')).toHaveLength(3);
    unmount(app!);
    app = null;

    render({ events: BUSY_DAY, rows: 1, cols: 3 });
    expect(qa('[data-testid="brief-runway-row"]')).toHaveLength(3);
    expect(text('[data-testid="brief-runway-more"]')).toBe("+5 more");
    unmount(app!);
    app = null;

    render({ events: BUSY_DAY, rows: 1, cols: 2 });
    expect(qa('[data-testid="brief-runway-row"]')).toHaveLength(2);
    expect(text('[data-testid="brief-runway-more"]')).toBe("+6 more");
  });

  it("a gap's peek shows its neighbours, the suggested priority with its fit, that priority's prompt, and Block on calendar copies an event draft", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render();
    await hover(q('[data-testid="brief-runway-row"][data-rank="1"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("3h 25m · 9:25–12:50");
    expect(peek.textContent).toContain("Protect this one");
    expect(qa('[data-testid="brief-peek-line"]').map((l) => l.textContent)).toEqual([expect.stringContaining("Standup"), expect.stringContaining("Cut30 office hours")]);
    expect(peek.textContent).toContain("Priority 1: Close out the SAFE allotment");
    expect(peek.textContent).toContain("Investors and the round close wait on it");
    expect(text('[data-testid="brief-peek-prompt"]')).toBe(PROMPTS.d1);
    expect(q('[data-testid="brief-start"]')).not.toBeNull();
    q('[data-testid="brief-runway-block"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(writeText).toHaveBeenCalledTimes(1);
    const draft = writeText.mock.calls[0]![0];
    expect(draft).toContain("Focus block: Close out the SAFE allotment");
    expect(draft).toContain("9:25 AM–12:50 PM");
    expect(q('[data-testid="brief-runway-row"][data-rank="1"]')!.textContent).toContain("Event draft copied");
  });

  it("a priority with no written prompt gets one built from its own words", async () => {
    render();
    await hover(q('[data-testid="brief-runway-row"][data-rank="3"]')!);
    expect(text('[data-testid="brief-peek-prompt"]')).toMatch(/^Today's priority 3: Reply to Jacob about the memo folder\. He asked twice\./);
  });

  it("says provisional when the calendar is a sample or every call is projected, and not otherwise", () => {
    render();
    expect(q('[data-testid="brief-runway-provisional"]')).toBeNull();
    unmount(app!);
    app = null;
    render({ sample: true });
    expect(q('[data-testid="brief-runway-provisional"]')).not.toBeNull();
    expect(text(".tag")).toBe("sample calendar");
    unmount(app!);
    app = null;
    render({ events: DAY.map((e) => ({ ...e, projected: true })) });
    expect(q('[data-testid="brief-runway-provisional"]')).not.toBeNull();
    expect(text(".tag")).toBe("calendar not loaded");
    expect(qa('[data-testid="brief-runway-pill"]').every((p) => p.classList.contains("proj"))).toBe(true);
  });

  it("empty rule: no calls is a whole open day with one block for priority 1; booked solid shows no rows", () => {
    render({ events: [] });
    expect(text('[data-testid="brief-runway-title"]')).toBe("Whole day open. Pick the hardest thing first.");
    expect(qa('[data-testid="brief-runway-pill"]')).toHaveLength(0);
    const rows = qa('[data-testid="brief-runway-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("10h · 8:00–6:00");
    expect(rows[0]!.textContent).toContain("Close out the SAFE allotment");
    expect(q('[data-testid="brief-runway-more"]')).toBeNull();
    unmount(app!);
    app = null;

    render({ events: SOLID_DAY });
    expect(text('[data-testid="brief-runway-title"]')).toBe("No focus block today. Longest gap is 15 min at 2:45.");
    expect(qa('[data-testid="brief-runway-row"]')).toHaveLength(0);
    expect(qa('[data-testid="brief-runway-gap"]')).toHaveLength(0);
    expect(q(".gaps")).toBeNull();
  });

  it("a gap with no priority left reads Unassigned", () => {
    render({ priorities: PRIORITIES.slice(0, 1), rows: 2 });
    expect(qa('[data-testid="brief-runway-task"]').map((t) => t.textContent)).toEqual(["Close out the SAFE allotment", "Unassigned", "Unassigned", "Unassigned"]);
  });

  it("the component's CSS has no inner shadow and no backdrop-filter (glass, outer glow only)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/brief/BriefRunway.svelte"), "utf8");
    const style = (src.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(style.length).toBeGreaterThan(100);
    expect(style).not.toMatch(/inset/);
    expect(style).not.toMatch(/backdrop-filter/);
    expect(style).toMatch(/box-shadow:\s*0 0 0 1px rgba\(52, 199, 89/);
  });
});
