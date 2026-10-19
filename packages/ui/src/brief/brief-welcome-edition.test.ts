import { describe, expect, it } from "vitest";
import {
  WELCOME_EDITION_SUB,
  WELCOME_EDITION_ZERO_HEADLINE,
  WELCOME_EDITION_ZERO_SUB,
  companyName,
  looksLikePath,
  welcomeEdition,
  welcomeGreeting,
} from "./brief-welcome-edition.js";
import {
  WELCOME_RISE_CALENDAR_LINE,
  WELCOME_RISE_FIELDWORK_TITLE,
  WELCOME_RISE_FINDING_CLAUDE,
  WELCOME_RISE_FINDING_CODEX,
  WELCOME_RISE_FINDING_REPOS,
  WELCOME_RISE_STUDIO_TITLE,
  WELCOME_RISE_WORK_TITLE,
  welcomeRiseBriefInput,
} from "./welcome-rise-run.js";
import type { BriefInput } from "./brief-types.js";

const at = (h: number, m = 0) => new Date(2026, 9, 17, h, m);

function withEvent(input: BriefInput, start: Date, title = "Launch review", attendees = ["Maya Chen", "Jordan Lee", "Sam Ito"]): BriefInput {
  return {
    ...input,
    sourceNotes: [],
    calendarToday: [{ id: "e1", title, start: start.toISOString(), kind: "team", attendees }],
  };
}

describe("welcomeGreeting", () => {
  it("greets by the local hour of the brief", () => {
    expect(welcomeGreeting(at(9), "Alex")).toBe("Good morning, Alex.");
    expect(welcomeGreeting(at(11, 59), "Alex")).toBe("Good morning, Alex.");
    expect(welcomeGreeting(at(12), "Alex")).toBe("Good afternoon, Alex.");
    expect(welcomeGreeting(at(17), "Alex")).toBe("Good evening, Alex.");
  });

  it("drops the name and comma when there is no name", () => {
    expect(welcomeGreeting(at(9), null)).toBe("Good morning.");
    expect(welcomeGreeting(at(9), "  ")).toBe("Good morning.");
  });
});

describe("companyName", () => {
  it("prefers the host label and otherwise capitalises the slug", () => {
    expect(companyName("northstar")).toBe("Northstar");
    expect(companyName("field-work")).toBe("Field Work");
    expect(companyName("northstar", new Map([["northstar", "Northstar Labs"]]))).toBe("Northstar Labs");
  });
});

describe("welcomeEdition", () => {
  it("builds the round 11b final page from the captured rise: decision, agenda and work cards, one section per project", () => {
    const e = welcomeEdition(welcomeRiseBriefInput());
    expect(e.zero).toBe(false);
    expect(e.headline).toBe("Good morning, Alex.");
    expect(e.sub).toBe(WELCOME_EDITION_SUB);
    expect(e.cards.map((c) => c.id)).toEqual(["decision", "day", "work"]);

    const [decision, day, work] = e.cards;
    expect(decision).toMatchObject({ pill: "Your decision", kicker: "Northstar", title: WELCOME_RISE_FINDING_CLAUDE, label: "Review the decision" });
    expect(decision!.action).toEqual({ kind: "launch", itemId: "rise-claude", prompt: WELCOME_RISE_FINDING_CLAUDE });
    // The agenda card keeps the mockup's middle slot. The unread calendar is not its headline.
    expect(day).toMatchObject({
      kicker: "Today · Personal",
      title: "5 things for you today.",
      lines: ["Across Northstar, Fieldwork, and Studio."],
      label: "Open the agenda",
      action: { kind: "meetings" },
    });
    expect(work).toMatchObject({
      pill: null,
      kicker: "Pick up your work · Northstar",
      title: WELCOME_RISE_WORK_TITLE,
      lines: ["The zero-company view is the last open item."],
      label: "Pick it up",
    });

    // The project row names every project in the run, so the lower right is never empty.
    expect(e.sections).toEqual([
      { name: "Northstar", lines: [WELCOME_RISE_FINDING_CODEX, "Review ready · 1 decision"] },
      { name: "Fieldwork", lines: [WELCOME_RISE_FIELDWORK_TITLE, "Maya added 3 interview notes."] },
      { name: "Studio", lines: [WELCOME_RISE_STUDIO_TITLE, "Jordan's wording is ready to read."] },
    ]);
  });

  it("says the unread calendar once, in the quiet run line, next to the count the reveal ended on", () => {
    const e = welcomeEdition(welcomeRiseBriefInput());
    expect(e.note).toBe("412 sessions read · 6 repos · Calendar could not be read.");
    const strings = [...e.cards.flatMap((c) => [c.kicker, c.title, ...c.lines, c.label ?? ""]), ...e.sections.flatMap((s) => [s.name, ...s.lines])];
    expect(strings.some((s) => /calendar/i.test(s))).toBe(false);
    expect(strings).not.toContain("Your calendar can wait.");
    expect([...strings, e.note].filter((s) => s?.includes(WELCOME_RISE_CALENDAR_LINE.replace(/\.$/, "")))).toHaveLength(1);
  });

  it("counts sessions for the run line when the host has no reveal stats, and leaves it out when there is nothing", () => {
    const input = { ...welcomeRiseBriefInput(), runStats: null, sourceNotes: [] };
    expect(welcomeEdition(input).note).toBe("412 sessions read.");
    expect(welcomeEdition({ ...input, sessions: [] }).note).toBeNull();
  });

  it("never puts a filename or repo path in a card or section headline", () => {
    const input = welcomeRiseBriefInput();
    const last = input.decisions.length - 1;
    input.decisions[last] = { ...input.decisions[last]!, title: WELCOME_RISE_FINDING_REPOS, summary: "apps/desktop/src/brief" };
    input.decisions[1] = { ...input.decisions[1]!, summary: "northstar/desktop" };
    const e = welcomeEdition(input);
    const work = e.cards.find((c) => c.id === "work")!;
    // The product name stands in for a title that is a file; a path line is left out.
    expect(work.title).toBe("Desktop app");
    expect(work.lines).toEqual([]);
    expect(e.sections[0]!.lines).toEqual([WELCOME_RISE_FINDING_CODEX]);
    const titles = [...e.cards.flatMap((c) => [c.title, ...c.lines]), ...e.sections.flatMap((s) => s.lines)];
    for (const t of titles) expect(looksLikePath(t, "northstar/desktop")).toBe(false);
  });

  it("does not repeat a title as the line under it", () => {
    const input = welcomeRiseBriefInput();
    input.decisions[2] = { ...input.decisions[2]!, summary: WELCOME_RISE_FIELDWORK_TITLE };
    expect(welcomeEdition(input).sections[1]!.lines).toEqual([WELCOME_RISE_FIELDWORK_TITLE]);
  });

  it("falls back to the project name when the product is a path too", () => {
    const input = welcomeRiseBriefInput();
    const last = input.decisions.length - 1;
    input.decisions[last] = { ...input.decisions[last]!, title: "apps/desktop/src/brief/WelcomeReport.svelte", origin: { companyUid: null, repo: "northstar/desktop", product: null } };
    expect(welcomeEdition(input).cards.find((c) => c.id === "work")!.title).toBe("Northstar");
  });

  it("tells a filename or path from plain words", () => {
    expect(looksLikePath("WelcomeReport.svelte still needs the new empty state.")).toBe(true);
    expect(looksLikePath("apps/desktop/src/brief")).toBe(true);
    expect(looksLikePath("northstar/desktop")).toBe(true);
    expect(looksLikePath("Ship northstar/desktop today", "northstar/desktop")).toBe(true);
    expect(looksLikePath("PR #248 · Restore offline install is ready for review.")).toBe(false);
    expect(looksLikePath("Finish the welcome state.")).toBe(false);
    expect(looksLikePath("Homepage copy · revision 4")).toBe(false);
    expect(looksLikePath("Use either and/or here")).toBe(false);
  });

  it("puts the next event still ahead on the day card with up to two attendees", () => {
    const base = welcomeRiseBriefInput(at(9));
    const day = welcomeEdition(withEvent(base, at(10, 30))).cards.find((c) => c.id === "day")!;
    expect(day.title).toBe("10:30 AM · Launch review");
    expect(day.lines).toEqual(["Maya Chen and Jordan Lee"]);
    expect(day).toMatchObject({ label: "Open the agenda", action: { kind: "meetings" } });
  });

  it("says the calendar is clear, with no link, when nothing is booked and nothing failed", () => {
    const input = { ...welcomeRiseBriefInput(), sourceNotes: [] };
    const day = welcomeEdition(input).cards.find((c) => c.id === "day")!;
    expect(day).toMatchObject({ title: "Your calendar is clear.", lines: ["Nothing is booked today. The time is yours."], label: null, action: null });
  });

  it("launches the plan's prompt for a card when there is one, else the decision's own prompt, else its title", () => {
    const input = welcomeRiseBriefInput();
    const last = input.decisions.length - 1;
    input.decisions[last] = { ...input.decisions[last]!, prompt: "Finish the empty state in WelcomeReport.svelte" };
    const e = welcomeEdition(input, { "rise-claude": "Review the offline installer decision" });
    expect(e.cards[0]!.action).toEqual({ kind: "launch", itemId: "rise-claude", prompt: "Review the offline installer decision" });
    expect(e.cards[2]!.action).toEqual({ kind: "launch", itemId: "rise-repos", prompt: "Finish the empty state in WelcomeReport.svelte" });
  });

  it("names up to three companies, the others with nothing new", () => {
    const input = { ...welcomeRiseBriefInput(), companies: ["northstar", "quiet", "studio", "extra"] };
    const e = welcomeEdition(input, {}, new Map([["studio", "Studio Co"]]));
    expect(e.sections.map((s) => s.name)).toEqual(["Northstar", "Quiet", "Studio Co"]);
    expect(e.sections[1]!.lines).toEqual(["Nothing new for you today."]);
  });

  it("with one decision shows only the decision and agenda cards, and counts only what is shown", () => {
    const input = welcomeRiseBriefInput();
    input.decisions = input.decisions.slice(0, 1);
    const e = welcomeEdition(input);
    expect(e.cards.map((c) => c.id)).toEqual(["decision", "day"]);
    expect(e.cards[1]).toMatchObject({ title: "1 thing for you today.", lines: ["Across Northstar."] });
    expect(e.sections).toEqual([
      { name: "Northstar", lines: ["On the cards above."] },
      { name: "Fieldwork", lines: ["Nothing new for you today."] },
      { name: "Studio", lines: ["Nothing new for you today."] },
    ]);
  });

  it("never shows a count that differs from the items on the page", () => {
    const e = welcomeEdition(welcomeRiseBriefInput());
    const onPage = e.cards.filter((c) => c.action?.kind === "launch").length + e.sections.filter((s) => !/^(On the cards above|Nothing new)/.test(s.lines[0] ?? "")).length;
    expect(e.cards.find((c) => c.id === "day")!.title).toBe(`${onPage} things for you today.`);
    const all = [...e.cards.flatMap((c) => [c.title, ...c.lines]), ...e.sections.flatMap((s) => s.lines)];
    expect(all.some((s) => /open items? for you/.test(s))).toBe(false);
  });

  it("with no company is the getting-started edition with no links", () => {
    const e = welcomeEdition({ ...welcomeRiseBriefInput(), companies: [] });
    expect(e).toMatchObject({ zero: true, headline: WELCOME_EDITION_ZERO_HEADLINE, sub: WELCOME_EDITION_ZERO_SUB });
    expect(e.cards.map((c) => c.title)).toEqual(["Give your agent one small task.", "Start with the work you have."]);
    expect(e.cards.every((c) => c.action === null && c.label === null)).toBe(true);
    expect(e.sections.map((s) => s.name)).toEqual(["A space for your team", "Your brief belongs to you."]);
  });

  it("keeps every string in sentence case with no exclamation marks or em dashes", () => {
    const pages = [welcomeEdition(welcomeRiseBriefInput()), welcomeEdition({ ...welcomeRiseBriefInput(), companies: [] })];
    const strings = pages.flatMap((p) => [p.headline, p.sub, p.note ?? "", ...p.cards.flatMap((c) => [c.kicker, c.title, ...c.lines, c.label ?? ""]), ...p.sections.flatMap((s) => [s.name, ...s.lines])]);
    for (const s of strings) {
      expect(s).not.toMatch(/[!—]/);
    }
  });

  it("puts each item under the company its origin names", () => {
    const input = { ...welcomeRiseBriefInput(), companies: ["co-north", "northstar", "co-field", "fieldwork"] };
    input.decisions = input.decisions.map((d, i) => ({ ...d, origin: { ...d.origin, companyUid: i === 1 ? "co-field" : "co-north" } }));
    const labels = new Map([
      ["co-north", "Northstar"],
      ["northstar", "Northstar"],
      ["co-field", "Fieldwork"],
      ["fieldwork", "Fieldwork"],
    ]);
    const e = welcomeEdition(input, {}, labels);
    expect(e.cards[0]!.kicker).toBe("Northstar");
    expect(e.cards[2]!.kicker).toBe("Pick up your work · Northstar");
    expect(e.sections).toEqual([
      { name: "Northstar", lines: [WELCOME_RISE_FIELDWORK_TITLE, "Maya added 3 interview notes."] },
      { name: "Fieldwork", lines: [WELCOME_RISE_FINDING_CODEX, "Review ready · 1 decision"] },
    ]);
  });
});
