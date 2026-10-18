import { describe, expect, it } from "vitest";
import {
  WELCOME_EDITION_SUB,
  WELCOME_EDITION_ZERO_HEADLINE,
  WELCOME_EDITION_ZERO_SUB,
  companyName,
  welcomeEdition,
  welcomeGreeting,
} from "./brief-welcome-edition.js";
import { WELCOME_RISE_FINDING_CLAUDE, WELCOME_RISE_FINDING_CODEX, WELCOME_RISE_FINDING_REPOS, welcomeRiseBriefInput } from "./welcome-rise-run.js";
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
  it("builds the round 11b final page from the captured rise: decision, day and work cards, one company section", () => {
    const e = welcomeEdition(welcomeRiseBriefInput());
    expect(e.zero).toBe(false);
    expect(e.headline).toBe("Good morning, Alex.");
    expect(e.sub).toBe(WELCOME_EDITION_SUB);
    expect(e.cards.map((c) => c.id)).toEqual(["decision", "day", "work"]);

    const [decision, day, work] = e.cards;
    expect(decision).toMatchObject({ pill: "Your decision", kicker: "Northstar", title: WELCOME_RISE_FINDING_CLAUDE, label: "Review the decision" });
    expect(decision!.action).toEqual({ kind: "launch", itemId: "rise-claude", prompt: WELCOME_RISE_FINDING_CLAUDE });
    // The rise said the calendar could not be read, so the day card says so instead of inventing a meeting.
    expect(day).toMatchObject({
      kicker: "Today · Personal",
      title: "Your calendar can wait.",
      lines: ["Calendar could not be read. Your brief uses the other sources."],
      label: "Open Meetings",
      action: { kind: "meetings" },
    });
    expect(work).toMatchObject({ pill: null, kicker: "Pick up your work · Northstar", title: WELCOME_RISE_FINDING_REPOS, label: "Pick it up" });

    expect(e.sections).toEqual([{ name: "Northstar", lines: [WELCOME_RISE_FINDING_CODEX, "3 open items for you"] }]);
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
    input.decisions[2] = { ...input.decisions[2]!, prompt: "Finish the empty state in WelcomeReport.svelte" };
    const e = welcomeEdition(input, { "rise-claude": "Review the offline installer decision" });
    expect(e.cards[0]!.action).toEqual({ kind: "launch", itemId: "rise-claude", prompt: "Review the offline installer decision" });
    expect(e.cards[2]!.action).toEqual({ kind: "launch", itemId: "rise-repos", prompt: "Finish the empty state in WelcomeReport.svelte" });
  });

  it("names up to three companies, the others with nothing new", () => {
    const input = { ...welcomeRiseBriefInput(), companies: ["northstar", "fieldwork", "studio", "extra"] };
    const e = welcomeEdition(input, {}, new Map([["studio", "Studio Co"]]));
    expect(e.sections.map((s) => s.name)).toEqual(["Northstar", "Fieldwork", "Studio Co"]);
    expect(e.sections[1]!.lines).toEqual(["Nothing new for you today."]);
  });

  it("with one decision shows only the decision and day cards and counts one item", () => {
    const input = welcomeRiseBriefInput();
    input.decisions = input.decisions.slice(0, 1);
    const e = welcomeEdition(input);
    expect(e.cards.map((c) => c.id)).toEqual(["decision", "day"]);
    expect(e.sections[0]!.lines).toEqual(["1 open item for you"]);
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
    const strings = pages.flatMap((p) => [p.headline, p.sub, ...p.cards.flatMap((c) => [c.kicker, c.title, ...c.lines, c.label ?? ""]), ...p.sections.flatMap((s) => [s.name, ...s.lines])]);
    for (const s of strings) {
      expect(s).not.toMatch(/[!—]/);
    }
  });

  it("puts each item under the company its origin names and counts each company's own items", () => {
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
      { name: "Northstar", lines: ["2 open items for you"] },
      { name: "Fieldwork", lines: [WELCOME_RISE_FINDING_CODEX, "1 open item for you"] },
    ]);
  });
});
