// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./BriefWeekArcHarness.test-support.svelte";
import {
  addDays,
  arcSentence,
  averageShare,
  beatPeek,
  beats,
  dayLabel,
  dayPeek,
  dayTip,
  futureDays,
  MAX_BEATS,
  mergedAverage,
  mergeTrend,
  pickBeats,
  rangeLabel,
  recordIndex,
  restPeek,
  weekColumns,
  weekdayName,
  weekdayShort,
  weekMix,
  weekTotals,
} from "./brief-week-arc.js";
import type { BriefDay } from "./brief-types.js";

const day = (date: string, sessions: number, meetings: number, merged: number, beat?: BriefDay["beat"]): BriefDay => ({
  date,
  sessions,
  meetings,
  merged,
  opened: 0,
  ...(beat ? { beat } : {}),
});

/** The mockup week, Sun Oct 4 to Thu Oct 8 2026: outage Tuesday, record Thursday. */
const WEEK: BriefDay[] = [
  day("2026-10-04", 1, 1, 2),
  day("2026-10-05", 1, 11, 3),
  day("2026-10-06", 3, 7, 21, { kind: "crisis", label: "Deploys blocked by the route cap", evidence: "Outage opened 01:51, closed 06:27." }),
  day("2026-10-07", 1, 5, 27, { kind: "resolution", label: "Outage closed, two stories live" }),
  day("2026-10-08", 2, 6, 34, { kind: "push", label: "Most merges of the week" }),
];

describe("week arc: day labels from the date string", () => {
  it("names weekdays by arithmetic, never the machine clock", () => {
    expect(weekdayName("2026-10-11")).toBe("Sunday");
    expect(weekdayName("2026-10-12")).toBe("Monday");
    expect(weekdayName("2026-10-17")).toBe("Saturday");
    expect(dayLabel("2026-10-08")).toBe("Thu 8");
    expect(dayLabel("2026-11-01")).toBe("Sun 1");
    expect(weekdayShort("2026-10-08")).toBe("Thu");
  });

  it("adds days across month and year ends by arithmetic on the string", () => {
    expect(addDays("2026-10-08", 1)).toBe("2026-10-09");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("writes the tip and the range in plain words", () => {
    expect(dayTip(WEEK[4]!)).toBe("Thu 8: 2 sessions, 6 meetings, 34 merged");
    expect(dayTip(day("2026-10-05", 1, 1, 0))).toBe("Mon 5: 1 session, 1 meeting, 0 merged");
    expect(rangeLabel(WEEK)).toBe("Oct 4–8");
    expect(rangeLabel([day("2026-09-28", 0, 0, 0), day("2026-10-04", 0, 0, 0)])).toBe("Sep 28 – Oct 4");
    expect(rangeLabel([])).toBe("");
  });
});

describe("week arc: beats and the sentence", () => {
  it("counts a beat on every day that has one, oldest first, like the picker's measure()", () => {
    expect(beats(WEEK).map((b) => [b.date, b.kind])).toEqual([
      ["2026-10-06", "crisis"],
      ["2026-10-07", "resolution"],
      ["2026-10-08", "push"],
    ]);
    expect(beats(WEEK)[0]!.evidence).toBe("Outage opened 01:51, closed 06:27.");
    expect(beats(WEEK)[1]!.evidence).toBeNull();
  });

  it("crisis and resolution make the two-beat sentence in day order", () => {
    expect(arcSentence(WEEK)).toBe("Outage Tuesday, recovery Wednesday.");
    const crisisThenPush = [WEEK[0]!, WEEK[1]!, WEEK[2]!, day("2026-10-07", 1, 5, 27), WEEK[4]!];
    expect(arcSentence(crisisThenPush)).toBe("Outage Tuesday, record Thursday.");
  });

  it("a beat on today says today", () => {
    expect(arcSentence(WEEK, "2026-10-08")).toBe("Outage Tuesday, recovery Wednesday.");
    const pushToday = [WEEK[0]!, WEEK[1]!, day("2026-10-06", 3, 7, 21), day("2026-10-07", 1, 5, 27), WEEK[4]!];
    expect(arcSentence(pushToday, "2026-10-08")).toBe("Record today, and merges climbed from 2 to 27.");
  });

  it("one beat adds the merge trend; no beats is the trend alone or a steady week", () => {
    const pushOnly = [day("2026-10-04", 1, 1, 2), day("2026-10-05", 1, 11, 3), day("2026-10-06", 3, 7, 21), day("2026-10-08", 2, 6, 34, { kind: "push", label: "Most merges" })];
    expect(arcSentence(pushOnly)).toBe("Record Thursday, and merges climbed from 2 to 34.");
    expect(arcSentence([day("2026-10-04", 1, 1, 4), day("2026-10-05", 1, 1, 4), day("2026-10-06", 1, 1, 5, { kind: "turn", label: "Pricing turn" })])).toBe("Turn Tuesday, otherwise steady.");
    expect(arcSentence([day("2026-10-04", 1, 1, 2), day("2026-10-05", 1, 1, 9), day("2026-10-06", 1, 1, 34)])).toBe("Merges climbed from 2 to 34.");
    expect(arcSentence([day("2026-10-04", 1, 1, 34), day("2026-10-05", 1, 1, 9), day("2026-10-06", 1, 1, 2)])).toBe("Merges fell from 34 to 2.");
    expect(arcSentence([day("2026-10-04", 1, 1, 4), day("2026-10-05", 2, 1, 5), day("2026-10-06", 1, 1, 6)])).toBe("Steady week.");
  });

  it("the trend leaves today's partial column out when there are two other days", () => {
    const days = [day("2026-10-04", 1, 1, 2), day("2026-10-05", 1, 1, 20), day("2026-10-06", 0, 0, 0)];
    expect(mergeTrend(days, "2026-10-06")).toEqual({ from: 2, to: 20, dir: "up" });
    expect(mergeTrend(days)).toBeNull();
    expect(mergeTrend([day("2026-10-05", 1, 1, 20)], "2026-10-06")).toBeNull();
  });

  it("the sentence never carries repo names, PR numbers or labels", () => {
    const noisy = WEEK.map((d) => (d.beat ? { ...d, beat: { ...d.beat, label: "indigoai-us/hq-core #1234 feat(x): y" } } : d));
    const s = arcSentence(noisy);
    expect(s).not.toMatch(/[\w-]+\/[\w-]+|#\d+|feat\(/);
    expect(s.split(" ").length).toBeLessThanOrEqual(8);
  });

  it("keeps the four biggest beats as discs and lists the rest in day order", () => {
    const seven: BriefDay[] = [
      day("2026-10-05", 1, 1, 1, { kind: "turn", label: "Turn one" }),
      day("2026-10-06", 1, 1, 1, { kind: "crisis", label: "Crisis" }),
      day("2026-10-07", 1, 1, 1, { kind: "turn", label: "Turn two" }),
      day("2026-10-08", 1, 1, 1, { kind: "resolution", label: "Recovered" }),
      day("2026-10-09", 1, 1, 1, { kind: "push", label: "Push" }),
      day("2026-10-10", 1, 1, 1, { kind: "turn", label: "Turn three" }),
      day("2026-10-11", 1, 1, 1, { kind: "turn", label: "Turn four" }),
    ];
    const { shown, rest } = pickBeats(seven);
    expect(shown).toHaveLength(MAX_BEATS);
    expect(shown.map((b) => b.label)).toEqual(["Crisis", "Recovered", "Push", "Turn four"]);
    expect(rest.map((b) => b.label)).toEqual(["Turn one", "Turn two", "Turn three"]);
    expect(pickBeats(WEEK)).toEqual({ shown: beats(WEEK), rest: [] });
    expect(restPeek(rest).sections[0]!.lines!.map((l) => `${l.label} ${l.state}`)).toEqual(["Turn one MON 5", "Turn two WED 7", "Turn three SAT 10"]);
  });
});

describe("week arc: geometry and peeks", () => {
  it("sums the week: merges for the hero number, sessions and meetings for the quiet line", () => {
    expect(weekTotals(WEEK)).toEqual({ merged: 87, sessions: 8, meetings: 30 });
    expect(weekMix(WEEK)).toBe("8 sessions · 30 meetings");
    expect(weekMix([day("2026-10-04", 1, 1, 0), day("2026-10-05", 0, 0, 0)])).toBe("1 session · 1 meeting");
  });

  it("one capsule per day, its height the day's merges against the busiest day", () => {
    const c = weekColumns(WEEK, "2026-10-08");
    expect(c.map((x) => x.merged)).toEqual([2, 3, 21, 27, 34]);
    expect(c[4]!.share).toBe(1);
    expect(c[0]!.share).toBeCloseTo(2 / 34, 2);
    expect(c.map((x) => x.today)).toEqual([false, false, false, false, true]);
    expect(c.filter((x) => x.record).map((x) => x.date)).toEqual(["2026-10-08"]);
    // An all-zero week stays flat instead of dividing by zero, and has no record.
    const flat = weekColumns([day("2026-10-04", 1, 0, 0), day("2026-10-05", 0, 2, 0), day("2026-10-06", 0, 0, 0)]);
    expect(flat.map((x) => x.share)).toEqual([0, 0, 0]);
    expect(flat.some((x) => x.record)).toBe(false);
  });

  it("the record is the push beat when there is one, else the full day with the most merges", () => {
    // The push beat wins even when another day merged more.
    const pushLow = [day("2026-10-04", 1, 1, 30), day("2026-10-05", 1, 1, 9, { kind: "push", label: "Push" }), day("2026-10-06", 1, 1, 4)];
    expect(recordIndex(pushLow)).toBe(1);
    // No push: most merges, the later day on a tie; today's partial column does not count while a full day merged.
    expect(recordIndex([day("2026-10-04", 1, 1, 9), day("2026-10-05", 1, 1, 9), day("2026-10-06", 1, 1, 4)])).toBe(1);
    expect(recordIndex([day("2026-10-04", 1, 1, 5), day("2026-10-05", 1, 1, 9), day("2026-10-06", 1, 1, 40)], "2026-10-06")).toBe(1);
    expect(recordIndex([day("2026-10-04", 1, 1, 0), day("2026-10-05", 1, 1, 0), day("2026-10-06", 1, 1, 3)], "2026-10-06")).toBe(2);
    expect(recordIndex([day("2026-10-04", 1, 1, 0), day("2026-10-05", 1, 1, 0), day("2026-10-06", 1, 1, 0)])).toBe(-1);
  });

  it("the dotted average is the mean full day, today's partial column left out", () => {
    expect(mergedAverage(WEEK, "2026-10-08")).toBe(13.3);
    expect(mergedAverage(WEEK)).toBe(17.4);
    expect(averageShare(WEEK, "2026-10-08")).toBeCloseTo(13.3 / 34, 2);
    expect(mergedAverage([day("2026-10-04", 1, 1, 4)])).toBeNull();
    expect(averageShare([day("2026-10-04", 1, 1, 0), day("2026-10-05", 1, 1, 0), day("2026-10-06", 1, 1, 0)])).toBeNull();
  });

  it("the rest of the week shows as ghost days only when the data reaches today", () => {
    expect(futureDays(WEEK, "2026-10-08")).toEqual(["2026-10-09", "2026-10-10"]);
    // A morning brief before today has any work: today is the first ghost.
    expect(futureDays(WEEK, "2026-10-09")).toEqual(["2026-10-09", "2026-10-10"]);
    expect(futureDays(WEEK, "2026-10-20")).toEqual([]);
    const seven = Array.from({ length: 7 }, (_, i) => day(addDays("2026-10-02", i), 1, 1, 1));
    expect(futureDays(seven, "2026-10-08")).toEqual([]);
  });

  it("peeks say what happened in the writer's words, with evidence when there is some", () => {
    const [crisis, resolution] = beats(WEEK);
    expect(beatPeek(crisis!)).toEqual({
      title: "Deploys blocked by the route cap",
      status: "Crisis · Tue 6",
      sections: [{ label: "Evidence", text: "Outage opened 01:51, closed 06:27." }],
    });
    expect(beatPeek(resolution!).sections).toEqual([]);
    expect(dayPeek(WEEK[4]!, "2026-10-08")).toMatchObject({ title: "Thu 8 · today so far", status: "2 sessions · 6 meetings · 34 merged" });
    expect(dayPeek(WEEK[1]!).title).toBe("Mon 5");
    expect(dayPeek(WEEK[2]!).sections[0]).toMatchObject({ label: "Crisis", tone: "red" });
  });
});

describe("BriefWeekArc", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  const q = (sel: string) => target.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];

  function render(props: { days: BriefDay[]; today: string; cols?: number; rows?: number }) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Harness, { target, props: { cols: 2, rows: 2, ...props } });
    flushSync();
  }
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

  it("renders the eyebrow, the hero number, the sentence, the totals and one capsule per day", () => {
    render({ days: WEEK, today: "2026-10-08" });
    const card = q('[data-testid="brief-week-arc"]')!;
    expect(card.classList.contains("w")).toBe(true);
    expect(card.querySelector(".eyebrow")!.textContent!.trim()).toBe("Your week");
    expect(q('[data-testid="brief-week-range"]')!.textContent).toBe("Oct 4–8");
    expect(q('[data-testid="brief-week-arc-title"]')!.textContent).toBe("Outage Tuesday, recovery Wednesday.");
    expect(qa('[data-testid="brief-week-day"]')).toHaveLength(5);
    expect(qa('[data-testid="brief-week-day"]').map((d) => d.getAttribute("aria-label"))[4]).toBe("Thu 8: 2 sessions, 6 meetings, 34 merged");
    expect(q('[data-testid="brief-week-total"]')!.textContent).toBe("87merged");
    expect(q('[data-testid="brief-week-total"]')!.getAttribute("aria-label")).toBe("87 merged this week");
    expect(q('[data-testid="brief-week-mix"]')!.textContent).toBe("8 sessions · 30 meetings");
    // Every day merged something, so every column has a capsule sized to its share of the busiest day.
    const bars = qa('[data-testid="brief-week-day"] .bar');
    expect(bars).toHaveLength(5);
    expect(bars.map((b) => b.style.getPropertyValue("--share"))).toEqual(["0.06", "0.09", "0.62", "0.79", "1"]);
    // The dotted average sits at the mean full day's share.
    expect(q('[data-testid="brief-week-avg"]')!.style.getPropertyValue("--avg")).toBe("0.39");
  });

  it("the record day alone carries the accent and its count in a pill", () => {
    render({ days: WEEK, today: "2026-10-08" });
    const record = qa('[data-testid="brief-week-day"]').filter((d) => d.classList.contains("record"));
    expect(record.map((d) => d.getAttribute("data-date"))).toEqual(["2026-10-08"]);
    expect(qa('[data-testid="brief-week-record"]')).toHaveLength(1);
    expect(record[0]!.querySelector('[data-testid="brief-week-record"]')!.textContent).toBe("34 merged");
    // The disc under the record day is the push beat's.
    expect(record[0]!.querySelector('[data-testid="brief-week-beat"]')!.getAttribute("data-kind")).toBe("push");
    // Without a push beat the busiest full day takes it, never today's partial column.
    unmount(app!);
    app = null;
    target.remove();
    render({ days: [day("2026-10-04", 1, 1, 5), day("2026-10-05", 1, 1, 12), day("2026-10-06", 1, 1, 30)], today: "2026-10-06" });
    expect(qa(".day.record").map((d) => d.getAttribute("data-date"))).toEqual(["2026-10-05"]);
    expect(q('[data-testid="brief-week-record"]')!.textContent).toBe("12 merged");
  });

  it("today's column is still running (a hatched capsule) and comes from the today prop, not the machine clock", () => {
    render({ days: WEEK, today: "2026-10-08" });
    const today = qa('[data-testid="brief-week-day"]').filter((d) => d.classList.contains("today"));
    expect(today).toHaveLength(1);
    expect(today[0]!.getAttribute("data-date")).toBe("2026-10-08");
    expect(q('[data-testid="brief-week-arc"]')!.getAttribute("data-today")).toBe("2026-10-08");
    // The in-progress capsule is today's, and only today's.
    const live = qa('[data-testid="brief-week-projection"]');
    expect(live).toHaveLength(1);
    expect(live[0]!.closest('[data-testid="brief-week-day"]')!.getAttribute("data-date")).toBe("2026-10-08");
    expect(live[0]!.classList.contains("live")).toBe(true);
    expect(qa(".bar.live")).toHaveLength(1);
    const labels = qa('[data-testid="brief-week-day"] .lbl');
    expect(labels.map((l) => l.textContent)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu"]);
    expect(labels[4]!.closest(".day")!.classList.contains("today")).toBe(true);
    // The rest of the week is ghost days: no data, no peek, hidden from assistive tech.
    const ghosts = qa('[data-testid="brief-week-ghost"]');
    expect(ghosts.map((g) => g.getAttribute("data-date"))).toEqual(["2026-10-09", "2026-10-10"]);
    expect(ghosts.map((g) => g.querySelector(".lbl")!.textContent)).toEqual(["Fri", "Sat"]);
    expect(ghosts.every((g) => g.getAttribute("aria-hidden") === "true" && !g.querySelector(".bar"))).toBe(true);
    // A brief for a day not in the data marks nothing as today and draws no projection.
    unmount(app!);
    app = null;
    target.remove();
    render({ days: WEEK, today: "2026-10-20" });
    expect(qa(".today")).toHaveLength(0);
    expect(q('[data-testid="brief-week-projection"]')).toBeNull();
    expect(q('[data-testid="brief-week-ghost"]')).toBeNull();
  });

  it("today with nothing merged yet keeps its in-progress mark on the stub", () => {
    render({ days: [day("2026-10-04", 1, 1, 5), day("2026-10-05", 1, 1, 12), day("2026-10-06", 2, 1, 0)], today: "2026-10-06" });
    const live = q('[data-testid="brief-week-projection"]')!;
    expect(live.classList.contains("stub")).toBe(true);
    expect(live.closest(".day")!.classList.contains("today")).toBe(true);
  });

  it("hides itself under three days of data", () => {
    render({ days: WEEK.slice(0, 2), today: "2026-10-05" });
    expect(q('[data-testid="brief-week-arc"]')).toBeNull();
    unmount(app!);
    app = null;
    target.remove();
    render({ days: WEEK.slice(0, 3), today: "2026-10-06" });
    expect(q('[data-testid="brief-week-arc"]')).not.toBeNull();
  });

  it("shows at most four beat discs plus a +N more chip whose peek lists the rest", async () => {
    const seven: BriefDay[] = Array.from({ length: 7 }, (_, i) =>
      day(`2026-10-${String(5 + i).padStart(2, "0")}`, 1, 1, 1, { kind: i === 1 ? "crisis" : i === 3 ? "resolution" : i === 4 ? "push" : "turn", label: `Beat ${i + 1}` }),
    );
    render({ days: seven, today: "2026-10-11" });
    expect(qa('[data-testid="brief-week-beat"]')).toHaveLength(4);
    expect(qa('[data-testid="brief-week-beat"]').map((b) => b.getAttribute("data-kind"))).toEqual(["crisis", "resolution", "push", "turn"]);
    expect(qa('[data-testid="brief-week-beat-row"]')).toHaveLength(4);
    expect(qa('[data-testid="brief-week-more"]')).toHaveLength(1);
    // Two lines of beats: the tracks give up height so the card keeps its size.
    expect(q('[data-testid="brief-week-arc"]')!.classList.contains("dense")).toBe(true);
    const more = q('[data-testid="brief-week-more"]')!;
    expect(more.textContent!.trim()).toBe("+3 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("3 more turning points");
    const lines = [...peek.querySelectorAll('[data-testid="brief-peek-line"]')].map((l) => `${l.querySelector("div")!.textContent!.trim()} · ${l.querySelector("span")!.textContent!.trim()}`);
    expect(lines).toEqual(["Beat 1 · MON 5", "Beat 3 · WED 7", "Beat 6 · SAT 10"]);
  });

  it("a one-row card keeps the discs, lists no beat rows and puts +N more beside the totals", () => {
    const six: BriefDay[] = Array.from({ length: 6 }, (_, i) => day(`2026-10-${String(5 + i).padStart(2, "0")}`, 1, 0, 2, { kind: "turn", label: `Turn ${i + 1}` }));
    render({ days: six, today: "2026-10-10", cols: 3, rows: 1 });
    expect(qa('[data-testid="brief-week-beat"]')).toHaveLength(4);
    expect(qa('[data-testid="brief-week-beat-row"]')).toHaveLength(0);
    expect(q('.meta [data-testid="brief-week-more"]')!.textContent).toBe("+2 more");
    // Three columns wide, the number and sentence sit beside the chart; two wide, over it.
    expect(q('[data-testid="brief-week-arc"]')!.classList.contains("side")).toBe(true);
    unmount(app!);
    app = null;
    target.remove();
    render({ days: six, today: "2026-10-10", cols: 2, rows: 1 });
    const card = q('[data-testid="brief-week-arc"]')!;
    expect(card.classList.contains("flat")).toBe(true);
    expect(card.classList.contains("side")).toBe(false);
  });

  it("hovering a disc opens its card: the beat in the writer's words, the day, the evidence", async () => {
    render({ days: WEEK, today: "2026-10-08" });
    const disc = qa('[data-testid="brief-week-beat"]')[0]!;
    expect(disc.getAttribute("aria-label")).toBe("Crisis · Tue 6 · Deploys blocked by the route cap");
    await hover(disc);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Deploys blocked by the route cap");
    expect(peek.textContent).toContain("Crisis · Tue 6");
    expect(peek.textContent).toContain("Outage opened 01:51, closed 06:27.");
  });

  it("hovering a day opens its counts", async () => {
    render({ days: WEEK, today: "2026-10-08" });
    await hover(qa('[data-testid="brief-week-day"]')[4]!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Thu 8 · today so far");
    expect(peek.textContent).toContain("2 sessions · 6 meetings · 34 merged");
  });

  it("never mentions other companies: no elsewhere stripe, no other-company count", () => {
    render({ days: WEEK, today: "2026-10-08" });
    const text = target.textContent!.toLowerCase();
    expect(text).not.toMatch(/elsewhere|other compan|private|another company/);
    expect(q('[data-testid*="other"]')).toBeNull();
    expect(q('[data-testid*="elsewhere"]')).toBeNull();
  });

  it("a day with nothing in it gets a stub, not an empty column", () => {
    render({ days: [day("2026-10-04", 0, 0, 0), day("2026-10-05", 2, 1, 3), day("2026-10-06", 1, 0, 1)], today: "2026-10-06" });
    const cols = qa('[data-testid="brief-week-day"]');
    expect(cols[0]!.querySelector(".stub")).not.toBeNull();
    expect(cols[0]!.querySelector(".bar")).toBeNull();
    expect(cols[1]!.querySelector(".bar")).not.toBeNull();
  });
});
