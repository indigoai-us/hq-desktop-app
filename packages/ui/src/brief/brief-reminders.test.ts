// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BriefRemindersHost from "./fixtures/BriefRemindersHost.svelte";
import { buildContext, entryOf } from "./brief-catalogue.js";
import { octoberEightBrief } from "./brief-fixture.js";
import {
  REMINDER_WINDOW_MS,
  addDays,
  dayDiff,
  dueLabel,
  dueReminders,
  dueState,
  localDay,
  reminderPrompt,
  reminderRows,
  saidLabel,
  saidLine,
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
    expect(saidLine(seven()[1]!, NOW, TODAY)).toBe("said Thu in a DM to yourself · due today");
    expect(saidLine(seven()[3]!, NOW, TODAY)).toBe("said Thu in HQ Dev Standup · due today");
    expect(saidLine(rem("w", "no where", { where: "  " }), NOW, TODAY)).toBe("said Thu · due today");
    expect(whenLine(at(8, 14))).toBe("Thu, Oct 8 at 2 PM");
    expect(whenLine(at(8, 14, 5))).toBe("Thu, Oct 8 at 2:05 PM");
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
    const said = qa('[data-testid="brief-reminder-said"]').map((el) => el.textContent);
    expect(said[0]).toBe("said Thu in a DM to yourself · overdue");
    expect(said[1]).toBe("said Thu in a DM to yourself · due today");
    expect(said[3]).toBe("said Thu in HQ Dev Standup · due today");
    expect(rows[0]!.classList.contains("late")).toBe(true);
    expect(rows[1]!.classList.contains("late")).toBe(false);
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
    expect(row.querySelector('[data-testid="brief-reminder-done"]')).toBeNull();
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
