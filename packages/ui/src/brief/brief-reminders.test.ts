// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import BriefRemindersHost from "./fixtures/BriefRemindersHost.svelte";
import { buildContext, entryOf } from "./brief-catalogue.js";
import { octoberEightBrief } from "./brief-fixture.js";
import {
  REMINDER_TALL_PX,
  REMINDER_WINDOW_MS,
  addDays,
  dayDiff,
  dueLabel,
  dueReminders,
  dueState,
  dueTone,
  localDay,
  reminderPrompt,
  reminderRows,
  reminderStrip,
  saidLabel,
  sourceLine,
  whenLine,
} from "./brief-reminders.js";
import type { BriefInput, BriefReminder } from "./brief-types.js";

// Sunday 2026-10-11, 08:30 local. Local constructors keep the weekday stable on every machine.
const NOW_DATE = new Date(2026, 9, 11, 8, 30);
const NOW = NOW_DATE.toISOString();
const TODAY = "2026-10-11";
const at = (d: number, h = 9, min = 0, m = 10) => new Date(2026, m - 1, d, h, min).toISOString();

const rem = (id: string, text: string, over: Partial<BriefReminder> = {}): BriefReminder => ({
  id,
  text,
  saidAt: at(8, 14), // Thursday
  where: "a DM to yourself",
  dueAt: at(11, 9),
  ...over,
});

/** Seven due reminders: one overdue, four today, one tomorrow, one early the day after (inside 48h). */
function seven(): BriefReminder[] {
  return [
    rem("r1", "call the bank before Thursday", { dueAt: at(10, 17) }),
    rem("r2", "ask Jacob about the memo folder"),
    rem("r3", "cancel the old Vercel plan", { dueAt: at(11, 12) }),
    rem("r4", "send Hassaan the SAFE numbers", { dueAt: at(11, 15), where: "HQ Dev Standup" }),
    rem("r5", "renew the domain", { dueAt: at(11, 18) }),
    rem("r6", "book the dentist", { dueAt: at(12, 10) }),
    rem("r7", "pay the contractor invoice", { dueAt: at(13, 7) }),
  ];
}

describe("brief-reminders helpers", () => {
  it("counts exactly what the picker counts: dated, due within 48 hours; undated, far and junk dates drop", () => {
    const list = [
      ...seven(),
      rem("far", "far away", { dueAt: at(13, 9) }), // 48h30m ahead: out
      rem("undated", "pin this somewhere", { dueAt: null }),
      rem("junk", "bad date", { dueAt: "not a date" }),
    ];
    const due = dueReminders(list, NOW);
    expect(due.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    expect(REMINDER_WINDOW_MS).toBe(2 * 86_400_000);
    expect(dueReminders(undefined, NOW)).toEqual([]);
    expect(dueReminders(list, "garbage")).toEqual([]);
  });

  it("agrees with the catalogue entry's measure() on the same input", () => {
    const base: BriefInput = { ...octoberEightBrief(NOW_DATE), now: NOW, today: TODAY };
    const reminders = [...seven(), rem("far", "far away", { dueAt: at(13, 9) }), rem("undated", "no date", { dueAt: null })];
    const ev = entryOf("reminders").measure(buildContext({ ...base, reminders }));
    expect(ev?.n).toBe(dueReminders(reminders, NOW).length);
    expect(ev?.value).toBe(2);
    // Nothing due by tomorrow: the picker hides it and so does the card.
    const quiet = [rem("far", "far away", { dueAt: at(13, 9) }), rem("undated", "no date", { dueAt: null })];
    expect(entryOf("reminders").measure(buildContext({ ...base, reminders: quiet }))).toBeNull();
    expect(dueReminders(quiet, NOW)).toEqual([]);
  });

  it("orders by due time, then said time, then id", () => {
    const list = [
      rem("b", "second", { dueAt: at(11, 10), saidAt: at(9, 9) }),
      rem("a", "third", { dueAt: at(11, 10), saidAt: at(9, 9) }),
      rem("c", "first", { dueAt: at(10, 23) }),
      rem("d", "fourth", { dueAt: at(11, 10), saidAt: at(10, 9) }),
    ];
    expect(dueReminders(list, NOW).map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("day arithmetic is machine-timezone independent", () => {
    expect(addDays("2026-10-11", 1)).toBe("2026-10-12");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayDiff("2026-10-08", "2026-10-11")).toBe(3);
    expect(dayDiff("2026-10-11", "2026-10-08")).toBe(-3);
    expect(dayDiff("junk", "2026-10-08")).toBe(0);
    expect(localDay(at(11, 9))).toBe("2026-10-11");
    expect(localDay("nope")).toBe("");
    expect(localDay(null)).toBe("");
  });

  it("labels overdue, today, tomorrow and the odd later day inside the window", () => {
    const [r1, r2, , , , r6, r7] = seven() as [BriefReminder, BriefReminder, BriefReminder, BriefReminder, BriefReminder, BriefReminder, BriefReminder];
    expect(dueState(r1, TODAY)).toBe("overdue");
    expect(dueLabel(r1, TODAY)).toBe("overdue");
    expect(dueLabel(r2, TODAY)).toBe("due today");
    expect(dueLabel(r6, TODAY)).toBe("due tomorrow");
    expect(dueState(r7, TODAY)).toBe("later");
    expect(dueLabel(r7, TODAY)).toBe("due Tue");
    expect(dueLabel(rem("x", "no date", { dueAt: null }), TODAY)).toBe("due later");
  });

  it("'said {weekday}' uses the saidAt date: today, a weekday inside the week, else the date", () => {
    expect(saidLabel(at(11, 7), NOW)).toBe("said today");
    expect(saidLabel(at(8, 14), NOW)).toBe("said Thu");
    expect(saidLabel(at(5, 14), NOW)).toBe("said Mon");
    expect(saidLabel(at(4, 14), NOW)).toBe("said Oct 4");
    expect(saidLabel(at(1, 14), NOW)).toBe("said Oct 1");
    expect(saidLabel("junk", NOW)).toBe("said");
    // The source line says when and where; the due state is the pill's, never repeated here.
    expect(sourceLine(seven()[1]!, NOW)).toBe("said Thu in a DM to yourself");
    expect(sourceLine(seven()[3]!, NOW)).toBe("said Thu in HQ Dev Standup");
    expect(sourceLine(rem("w", "no where", { where: "  " }), NOW)).toBe("said Thu");
    expect(whenLine(at(8, 14))).toBe("Thu, Oct 8 at 2 PM");
    expect(whenLine(at(8, 14, 5))).toBe("Thu, Oct 8 at 2:05 PM");
  });

  it("the due pill's tone is the due state, or done once marked in this brief", () => {
    const [r1, r2, , , , r6, r7] = seven() as [BriefReminder, BriefReminder, BriefReminder, BriefReminder, BriefReminder, BriefReminder, BriefReminder];
    expect(dueTone(r1, TODAY)).toBe("overdue");
    expect(dueTone(r2, TODAY)).toBe("today");
    expect(dueTone(r6, TODAY)).toBe("tomorrow");
    expect(dueTone(r7, TODAY)).toBe("later");
    expect(dueTone(r1, TODAY, true)).toBe("done");
    expect(dueTone(r2, TODAY, true)).toBe("done");
  });

  it("the day strip runs from the day it was said to the day it is due, a week wide, centred on the track", () => {
    // Said Thu Oct 8, due today (Sun Oct 11): four days of track, a day before, two after.
    const strip = reminderStrip(rem("a", "x"), TODAY);
    expect(strip.map((d) => d.label)).toEqual(["WED", "THU", "FRI", "SAT", "SUN", "MON", "TUE"]);
    expect(strip.map((d) => d.day)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
    expect(strip.filter((d) => d.said).map((d) => d.day)).toEqual(["2026-10-08"]);
    expect(strip.filter((d) => d.due).map((d) => d.day)).toEqual(["2026-10-11"]);
    expect(strip.filter((d) => d.today).map((d) => d.day)).toEqual(["2026-10-11"]);
    expect(strip.map((d) => d.out)).toEqual([null, "past", "past", "past", null, null, null]);
    expect(strip.map((d) => d.into)).toEqual([null, null, "past", "past", "past", null, null]);

    // Said yesterday, due today: two days of track, two days before, three after.
    expect(reminderStrip(rem("y", "x", { saidAt: at(10, 9) }), TODAY).map((d) => d.day)).toEqual([
      "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14",
    ]);

    // Due tomorrow: gone until today, dotted from today to the due day.
    const ahead = reminderStrip(rem("b", "x", { dueAt: at(12, 10) }), TODAY);
    expect(ahead[0]!.day).toBe("2026-10-07");
    expect(ahead.find((d) => d.day === "2026-10-10")!.out).toBe("past");
    expect(ahead.find((d) => d.day === "2026-10-11")!.out).toBe("ahead");
    expect(ahead.find((d) => d.due)!.day).toBe("2026-10-12");
    expect(ahead.find((d) => d.due)!.out).toBeNull();

    // Overdue since yesterday: solid to the due day, then late up to today.
    const late = reminderStrip(rem("c", "x", { dueAt: at(10, 17) }), TODAY);
    expect(late.find((d) => d.day === "2026-10-09")!.out).toBe("past");
    expect(late.find((d) => d.day === "2026-10-10")!.out).toBe("late");
    expect(late.find((d) => d.today)!.into).toBe("late");
    expect(late.find((d) => d.today)!.out).toBeNull();

    // Said before the window: the track runs in from the left edge, and the strip still ends a day after.
    const old = reminderStrip(rem("d", "x", { saidAt: at(1, 9) }), TODAY);
    expect(old.some((d) => d.said)).toBe(false);
    expect(old[0]!.into).toBe("past");
    expect(old.at(-1)!.day).toBe("2026-10-12");
    expect(old).toHaveLength(7);

    // Said and due the same day: one mark, the due one.
    const same = reminderStrip(rem("e", "x", { saidAt: at(11, 7) }), TODAY);
    expect(same.filter((d) => d.said)).toEqual([]);
    expect(same.filter((d) => d.due)).toHaveLength(1);
    expect(same.every((d) => d.out === null)).toBe(true);

    expect(reminderStrip(rem("f", "x", { dueAt: null }), TODAY)).toEqual([]);
    expect(reminderStrip(rem("g", "x"), "junk")).toEqual([]);
    expect(REMINDER_TALL_PX).toBeGreaterThan(136);
  });

  it("the built-in prompt quotes the owner's words verbatim, names where, and keeps the guard", () => {
    const p = reminderPrompt(rem("r", "Call the bank before Thursday.", { where: "HQ Dev Standup" }));
    expect(p).toContain('You asked to be reminded: "Call the bank before Thursday".');
    expect(p).toContain("I said it in HQ Dev Standup.");
    expect(p).toMatch(/Stop and confirm with me before any irreversible step/);
    expect(reminderPrompt(rem("r", "renew the domain", { where: "" }))).not.toContain("I said it in");
  });

  it("caps rows at five and hands the rest to the peek", () => {
    const { shown, rest } = reminderRows(seven());
    expect(shown.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(rest.map((r) => r.id)).toEqual(["r6", "r7"]);
    expect(reminderRows(seven().slice(0, 5)).rest).toEqual([]);
    expect(reminderRows(seven(), 3).shown).toHaveLength(3);
  });
});

describe("BriefReminders", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(props: Record<string, unknown>) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefRemindersHost, {
      target,
      props: { reminders: seven(), prompts: {}, now: NOW, today: TODAY, rows: 1, cols: 2, ...props },
    });
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

  it("is hidden when nothing is due by the end of tomorrow", () => {
    render({ reminders: [rem("far", "far away", { dueAt: at(13, 9) }), rem("undated", "pin this", { dueAt: null })] });
    expect(q('[data-testid="brief-reminders"]')).toBeNull();
    expect(target.textContent?.trim()).toBe("");
  });

  it("shows the eyebrow, five rows then +N more, each quote verbatim with its said line; never a count", () => {
    render({});
    const card = q('[data-testid="brief-reminders"]')!;
    expect(card.querySelector(".eyebrow")!.textContent!.trim()).toBe("You asked to be reminded");
    expect(card.querySelector(".big")).toBeNull();
    const rows = qa('[data-testid="brief-reminder"]');
    expect(rows).toHaveLength(5);
    expect(qa('[data-testid="brief-reminder-text"]').map((el) => el.textContent)).toEqual([
      "call the bank before Thursday",
      "ask Jacob about the memo folder",
      "cancel the old Vercel plan",
      "send Hassaan the SAFE numbers",
      "renew the domain",
    ]);
    // Each row says when it is due (the pill) and where and when it was said (the source line).
    const said = qa('[data-testid="brief-reminder-said"]').map((el) => el.textContent);
    expect(said[0]).toBe("said Thu in a DM to yourself");
    expect(said[1]).toBe("said Thu in a DM to yourself");
    expect(said[3]).toBe("said Thu in HQ Dev Standup");
    const pills = qa('[data-testid="brief-reminder-due"]');
    expect(pills.map((el) => el.textContent)).toEqual(["overdue", "due today", "due today", "due today", "due today"]);
    expect(rows[0]!.classList.contains("late")).toBe(true);
    expect(rows[1]!.classList.contains("late")).toBe(false);
    // Several reminders are open rows, never the lone hero.
    expect(qa('[data-testid="brief-reminder"].hero')).toHaveLength(0);
    const more = q('[data-testid="brief-reminder-more"]')!;
    expect(more.textContent!.trim()).toBe("+2 more");
  });

  it("the +N more peek lists the rest in the owner's words with their due state", async () => {
    render({});
    await hover(q('[data-testid="brief-reminder-more"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("2 more reminders");
    const lines = peek.querySelectorAll('[data-testid="brief-peek-line"]');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain("book the dentist");
    expect(lines[0]!.textContent).toContain("DUE TOMORROW");
    expect(lines[1]!.textContent).toContain("pay the contractor invoice");
  });

  it("the due pill is toned by due state: overdue red, today warm, tomorrow and later quiet", () => {
    render({ reminders: [seven()[0]!, seven()[1]!, seven()[5]!, seven()[6]!] });
    const pills = qa('[data-testid="brief-reminder-due"]');
    expect(pills.map((el) => el.getAttribute("data-tone"))).toEqual(["overdue", "today", "tomorrow", "later"]);
    expect(pills.map((el) => el.textContent)).toEqual(["overdue", "due today", "due tomorrow", "due Tue"]);
  });

  it("a lone reminder leads as the hero, with no footer; the day strip joins it on a tall card", () => {
    render({ reminders: [seven()[3]!] });
    const row = q('[data-testid="brief-reminder"]')!;
    expect(row.classList.contains("hero")).toBe(true);
    expect(q('[data-testid="brief-reminder-text"]')!.textContent).toBe("send Hassaan the SAFE numbers");
    expect(q('[data-testid="brief-reminder-due"]')!.getAttribute("data-tone")).toBe("today");
    expect(q('[data-testid="brief-reminder-said"]')!.textContent).toBe("said Thu in HQ Dev Standup");
    // A one-row card is short: the strip waits for the room.
    expect(q('[data-testid="brief-reminder-strip"]')).toBeNull();
    if (app) unmount(app);
    target.remove();
    render({ reminders: [seven()[3]!], rows: 2 });
    expect(q(".foot")).toBeNull();
    const strip = q('[data-testid="brief-reminder-strip"]')!;
    const days = [...strip.querySelectorAll<HTMLElement>(".d")];
    expect(days.map((d) => d.querySelector(".dl")!.textContent)).toEqual(["WED", "THU", "FRI", "SAT", "SUN", "MON", "TUE"]);
    expect(strip.querySelector(".d.said")!.getAttribute("data-day")).toBe("2026-10-08");
    const dueDay = strip.querySelector<HTMLElement>(".d.due")!;
    expect(dueDay.getAttribute("data-day")).toBe("2026-10-11");
    expect(dueDay.getAttribute("data-tone")).toBe("today");
    expect(dueDay.classList.contains("today")).toBe(true);
    expect(strip.querySelectorAll(".seg.past").length).toBeGreaterThan(0);
  });

  it("several reminders on a tall card keep the footer and never draw the strip", () => {
    render({ rows: 2 });
    expect(q('[data-testid="brief-reminder-strip"]')).toBeNull();
    expect(q(".foot")!.textContent).toContain("0 of 7 done");
  });

  it("the quote starts on the content edge with its open quote mark in the text flow, never hanging into the margin", () => {
    render({});
    // The open mark is the quote's first inline child, before the words, in every row.
    for (const q of qa(".q")) {
      const first = q.firstElementChild!;
      expect(first.classList.contains("qm")).toBe(true);
      expect(first.textContent).toBe("“");
      expect(first.nextElementSibling!.getAttribute("data-testid")).toBe("brief-reminder-text");
    }
    // No rule for the quote or its marks pulls it left: no absolute mark, no negative offset, margin or indent.
    const css = readFileSync(resolve(process.cwd(), "src/brief/BriefReminders.svelte"), "utf8").split("<style>")[1]!;
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => /\.qm?\b/.test(sel!.replace(/\/\*[\s\S]*?\*\//g, "")));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, sel, body] of rules) {
      expect(body, sel).not.toMatch(/position:\s*absolute/);
      expect(body, sel).not.toMatch(/(^|[\s;])(left|margin-left|text-indent|translate):\s*(calc\()?-/);
      expect(body, sel).not.toMatch(/hanging-punctuation/);
    }
  });

  it("a one-column slot shows three rows then +N more", () => {
    render({ cols: 1 });
    expect(qa('[data-testid="brief-reminder"]')).toHaveLength(3);
    expect(q('[data-testid="brief-reminder-more"]')!.textContent!.trim()).toBe("+4 more");
  });

  it("exactly five due reminders show five rows and no more row", () => {
    render({ reminders: seven().slice(0, 5) });
    expect(qa('[data-testid="brief-reminder"]')).toHaveLength(5);
    expect(q('[data-testid="brief-reminder-more"]')).toBeNull();
  });

  it("a row's peek carries the full text, where and when, and the prompt", async () => {
    render({ prompts: { r4: "Custom prompt for the SAFE numbers." } });
    await hover(qa('[data-testid="brief-reminder"]')[3]!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.querySelector('[data-testid="brief-peek-eyebrow"]')!.textContent).toBe("Reminder · said Thu");
    expect(peek.querySelector(".ttl")!.textContent).toBe("send Hassaan the SAFE numbers");
    expect(peek.querySelector(".st")!.textContent).toBe("Due today");
    expect(peek.textContent).toContain("You said it in HQ Dev Standup, Thu, Oct 8 at 2 PM.");
    expect(peek.textContent).toContain("Due Sun, Oct 11 at 3 PM.");
    expect(peek.querySelector('[data-testid="brief-peek-prompt"]')!.textContent).toBe("Custom prompt for the SAFE numbers.");
  });

  it("Done strikes the row locally through brief.cleared and shows the Done chip", () => {
    render({});
    const row = qa('[data-testid="brief-reminder"]')[0]!;
    expect(row.classList.contains("done")).toBe(false);
    (row.querySelector('[data-testid="brief-reminder-done"]') as HTMLButtonElement).click();
    flushSync();
    expect(row.classList.contains("done")).toBe(true);
    expect(row.classList.contains("late")).toBe(false);
    expect(row.textContent).toContain("Done");
    // The pill turns to Done, so the overdue tone no longer shouts.
    const pill = row.querySelector('[data-testid="brief-reminder-due"]')!;
    expect(pill.textContent).toBe("Done");
    expect(pill.getAttribute("data-tone")).toBe("done");
    expect(row.querySelector('[data-testid="brief-reminder-done"]')).toBeNull();
    expect(row.querySelector('[data-testid="brief-start"]')).toBeNull();
    // Only that row changed.
    expect(qa('[data-testid="brief-reminder"].done')).toHaveLength(1);
  });

  it("Start hands the reminder's prompt to the engine, preferring the plan's prompt, then the writer's, then the built-in", async () => {
    const onlaunch = vi.fn(async () => null);
    const list = seven();
    list[1] = { ...list[1]!, prompt: "Writer prompt for Jacob." };
    render({ onlaunch, reminders: list, prompts: { r1: "Plan prompt for the bank." } });
    const rows = qa('[data-testid="brief-reminder"]');
    (rows[0]!.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(onlaunch).toHaveBeenCalledWith("claude", "Plan prompt for the bank.");
    expect(rows[0]!.classList.contains("done")).toBe(true);
    (rows[1]!.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenLastCalledWith("claude", "Writer prompt for Jacob.");
    (rows[2]!.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenLastCalledWith("claude", reminderPrompt(list[2]!));
  });
});
