// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Harness from "./BriefBlockedByMeHarness.test-support.svelte";
import {
  CALL_CAP,
  LINE_CAP,
  NARROW_CALL_CAP,
  NARROW_LINE_CAP,
  ageLabel,
  blockedHeadline,
  blockedLayout,
  blockedStats,
  chainNodes,
  edgedDecisions,
  initialOf,
  isFreed,
  morePartiesPeek,
  partyPeek,
  summarizeBlocked,
  titlesOf,
} from "./brief-blocked-by-me.js";
import type { BriefBlocked, BriefDecision, BriefLine } from "./brief-types.js";

const INDIGO = "cmp_indigo";
const origin = (repo: string, product?: string) => ({ companyUid: INDIGO, repo, ...(product ? { product } : {}) });
const person = (who: string, what = `${who} moves on`): BriefBlocked => ({ who, what, kind: "person" });
const work = (who: string, what = "", repo = "indigoai-us/hq-core"): BriefBlocked => ({ who, what, kind: "work", origin: origin(repo) });
const unlock = (label: string, state = "NEXT"): BriefLine => ({ label, state, tone: "ok" });

function decision(id: string, title: string, extra: Partial<BriefDecision> = {}): BriefDecision {
  return { id, title, summary: title, action: "decide", origin: origin("indigoai-us/hq-desktop-app", "Desktop app"), ...extra };
}

/** Three calls: one late release cut freeing two people and the docs release, an ack freeing one person, a fix freeing one. */
function day(): BriefDecision[] {
  return [
    decision("d1", "Cut the hq-core release", {
      action: "cut",
      ageHours: 30,
      origin: origin("indigoai-us/hq-core", "HQ core"),
      blocks: [person("Jonathan", "ships the planning changes"), person("Geoff", "merges the pricing page"), work("Docs release", "held until the release ships", "indigoai-us/indigo-docs")],
      detail: { why: "It carries the planning merge.", unlocks: [unlock("Docs PR 64 can merge")], source: "Oct 7 staging run" },
    }),
    decision("d2", "Ack the Pluto handoff", { ageHours: 17, blocks: [person("Yousuf", "moves off Pluto")] }),
    decision("d3", "Fix the skill-metadata check", { ageHours: 60, blocks: [person("Stefan", "runs liveops on a green main")] }),
    decision("d4", "Answer the auditor", { ageHours: 3 }), // no edge: not on the card
  ];
}

const ALL_PROMPTS = { d1: "Cut the release. Stop for my go.", d2: "Ack Pluto.", d3: "Fix the check." };
const SLUG = /\b[\w.-]+\/[\w.-]+\b/;
const PR_NUMBER = /#\d+/;

describe("summarizeBlocked", () => {
  it("keeps only decisions with blocks or unlocks, most freeing first, then oldest", () => {
    const s = summarizeBlocked(day());
    expect(edgedDecisions(day()).map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect(s.decisions.map((d) => d.id)).toEqual(["d1", "d3", "d2"]);
    expect(s.parties.map((p) => p.name)).toEqual(["Jonathan", "Geoff", "Docs release", "Stefan", "Yousuf"]);
    expect(s.people).toBe(4);
    expect(s.work).toBe(1);
    expect(s.unlocksOnly).toBe(false);
    expect(s.edges).toHaveLength(5);
  });

  it("counts people only from blocks of kind person and falls back to unlock lines when no block is named", () => {
    const only = summarizeBlocked([decision("d1", "Cut it", { detail: { why: "", unlocks: [unlock("Docs match the release"), unlock("Glossary rename reaches users", "RELEASE")], source: "" } })]);
    expect(only.unlocksOnly).toBe(true);
    expect(only.people).toBe(0);
    expect(only.work).toBe(2);
    expect(only.parties.map((p) => p.state)).toEqual(["NEXT", "RELEASE"]);
    expect(blockedHeadline(only)).toBe("Your 1 call unlocks 2 things.");
    expect(blockedHeadline(only)).not.toMatch(/people/);
  });

  it("dedupes a party freed by two calls and remembers both", () => {
    const s = summarizeBlocked([decision("a", "A", { blocks: [person("Geoff")] }), decision("b", "B", { blocks: [person("geoff ")] })]);
    expect(s.parties).toHaveLength(1);
    expect(s.parties[0]!.by).toEqual(["a", "b"]);
    expect(s.edges).toHaveLength(2);
  });

  it("strips PR numbers and commit prefixes from work names", () => {
    const s = summarizeBlocked([decision("a", "A", { blocks: [work("indigo-docs #64: docs(planning): document the merge")] })]);
    expect(s.parties[0]!.name).toBe("Document the merge");
    expect(s.parties[0]!.name).not.toMatch(PR_NUMBER);
  });
});

describe("blockedHeadline", () => {
  it("counts people and work separately and names a lone person or piece of work", () => {
    expect(blockedHeadline(summarizeBlocked(day()))).toBe("3 calls free 4 people and Docs release.");
    expect(blockedHeadline(summarizeBlocked([decision("a", "A", { blocks: [person("Jonathan")] })]))).toBe("1 call frees Jonathan.");
    expect(blockedHeadline(summarizeBlocked([decision("a", "A", { blocks: [work("Docs release"), work("Pricing page")] })]))).toBe("1 call frees 2 things.");
    expect(blockedHeadline(summarizeBlocked([]))).toBe("");
  });

  it("never says people without a block of kind person", () => {
    const noPeople = [decision("a", "A", { blocks: [work("Docs release"), work("Pricing page"), work("Beta build")] }), decision("b", "B", { detail: { why: "", unlocks: [unlock("x")], source: "" } })];
    expect(blockedHeadline(summarizeBlocked(noPeople))).not.toMatch(/people|person/);
  });
});

describe("ageLabel", () => {
  it("formats hours and days, amber being the card's job", () => {
    expect(ageLabel(0.4)).toBe("<1h");
    expect(ageLabel(17)).toBe("17h");
    expect(ageLabel(44.4)).toBe("44h");
    expect(ageLabel(60)).toBe("3d");
    expect(ageLabel(null)).toBe("");
    expect(ageLabel(undefined)).toBe("");
    expect(ageLabel(-2)).toBe("");
  });
});

describe("blockedStats, isFreed and initialOf", () => {
  it("counts calls and who waits, and gives the oldest call's age, late past a day", () => {
    expect(blockedStats(summarizeBlocked(day()))).toEqual([
      { key: "calls", value: "3", label: "Calls" },
      { key: "freed", value: "5", label: "Waiting on them" },
      { key: "oldest", value: "3d", label: "Oldest call", late: true },
    ]);
    const one = blockedStats(summarizeBlocked([decision("a", "A", { ageHours: 5, blocks: [person("Jonathan")] })]));
    expect(one.map((x) => [x.value, x.label])).toEqual([["1", "Call"], ["1", "Person waiting"], ["5h", "Oldest call"]]);
    expect(one[2]!.late).toBe(false);
    // No age known: no oldest stat. Work only never says people.
    const workOnly = blockedStats(summarizeBlocked([decision("a", "A", { blocks: [work("Docs release"), work("Pricing page")] })]));
    expect(workOnly.map((x) => x.label)).toEqual(["Call", "Things held"]);
    const unlocks = blockedStats(summarizeBlocked([decision("a", "A", { detail: { why: "", unlocks: [unlock("x")], source: "" } })]));
    expect(unlocks.map((x) => x.label)).toEqual(["Call", "Thing unlocked"]);
    expect(blockedStats(summarizeBlocked([]))).toEqual([]);
  });

  it("a party is freed only once every call that holds it is made; initials are one letter", () => {
    const s = summarizeBlocked([decision("a", "A", { blocks: [person("Blake")] }), decision("b", "B", { blocks: [person("Blake")] })]);
    const blake = s.parties[0]!;
    expect(isFreed(blake, {})).toBe(false);
    expect(isFreed(blake, { a: true })).toBe(false);
    expect(isFreed(blake, { a: true, b: true })).toBe(true);
    expect(initialOf("Jonathan")).toBe("J");
    expect(initialOf(" élodie")).toBe("É");
    expect(initialOf("")).toBe("?");
  });
});

describe("blockedLayout and chainNodes", () => {
  const many = () => [
    decision("d1", "One", { ageHours: 30, blocks: ["A", "B", "C", "D"].map((n) => person(n)) }),
    decision("d2", "Two", { blocks: [person("E"), person("F")] }),
    decision("d3", "Three", { blocks: [person("G")] }),
    decision("d4", "Four", { blocks: [person("H")] }),
    decision("d5", "Five", { blocks: [person("I")] }),
  ];

  it("caps the list at three calls and five party lines; every call keeps one line before any gets a second, the rest folds into that call's +N more", () => {
    const lay = blockedLayout(summarizeBlocked(many()));
    expect(CALL_CAP).toBe(3);
    expect(LINE_CAP).toBe(5);
    expect(lay.calls.map((c) => c.decision.id)).toEqual(["d1", "d2", "d3"]);
    expect(lay.moreCalls.map((d) => d.id)).toEqual(["d4", "d5"]);
    // First pass gives d1, d2, d3 one line each (A, E, G); the two left go to d1 (B, C).
    expect(lay.calls.map((c) => c.parties.map((p) => p.name))).toEqual([["A", "B", "C"], ["E"], ["G"]]);
    expect(lay.calls.map((c) => c.folded.map((p) => p.name))).toEqual([["D"], ["F"], []]);
    expect(lay.calls.reduce((n, c) => n + c.parties.length, 0)).toBe(LINE_CAP);
    // Hidden calls draw nothing.
    expect(lay.calls.flatMap((c) => c.parties).some((p) => ["H", "I"].includes(p.name))).toBe(false);
    // A one-column card: two calls, three lines.
    const narrow = blockedLayout(summarizeBlocked(many()), NARROW_CALL_CAP, NARROW_LINE_CAP);
    expect(narrow.calls.map((c) => c.parties.map((p) => p.name))).toEqual([["A", "B"], ["E"]]);
    expect(narrow.moreCalls).toHaveLength(3);
  });

  it("a party freed by two shown calls is listed under both", () => {
    const s = summarizeBlocked([decision("a", "Sign the contract", { ageHours: 26, blocks: [person("Blake")] }), decision("b", "Approve the budget", { blocks: [person("Blake"), work("Q4 plan")] })]);
    const lay = blockedLayout(s);
    expect(lay.calls.map((c) => c.parties.map((p) => p.name))).toEqual([["Blake", "Q4 plan"], ["Blake"]]);
  });

  it("the chain shows the top call's parties up to the cap and folds everything else", () => {
    const s = summarizeBlocked(many());
    const two = chainNodes(s, 2);
    expect(two.lead!.id).toBe("d1");
    expect(two.nodes.map((p) => p.name)).toEqual(["A", "B"]);
    expect(two.more.map((p) => p.name)).toEqual(["C", "D", "E", "F", "G", "H", "I"]);
    expect(chainNodes(s, 3).nodes).toHaveLength(3);
    expect(chainNodes(summarizeBlocked([]), 3)).toEqual({ lead: null, nodes: [], more: [] });
  });

  it("peeks name what they do next and which call frees them, and the more peek lists every folded party", () => {
    const s = summarizeBlocked(day());
    const titles = titlesOf(s);
    const geoff = partyPeek(s.parties.find((p) => p.name === "Geoff")!, titles);
    expect(geoff.status).toBe("Waiting on you");
    expect(geoff.sections[0]).toEqual({ label: "What they do next", text: "merges the pricing page" });
    expect(geoff.sections[1]!.lines![0]!.label).toBe("Cut the hq-core release");
    const docs = partyPeek(s.parties.find((p) => p.name === "Docs release")!, titles);
    expect(docs.status).toBe("Held until you act");
    expect(docs.origin).toEqual({ companyUid: INDIGO, label: "indigo-docs" });
    const more = morePartiesPeek(s.parties.slice(3), titles);
    expect(more.title).toBe("2 more waiting on you");
    expect(more.sections[0]!.lines!.map((l) => l.label)).toEqual(["Stefan · runs liveops on a green main · Fix the skill-metadata check", "Yousuf · moves off Pluto · Ack the Pluto handoff"]);
  });
});

describe("BriefBlockedByMe", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(props: { decisions: BriefDecision[]; prompts?: Record<string, string>; cols?: number; rows?: number; launch?: () => Promise<string | null> }) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Harness, { target, props });
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

  const SRC = () => readFileSync(resolve(process.cwd(), "src/brief/BriefBlockedByMe.svelte"), "utf8");
  /** The declarations of one CSS rule in the component's style block, by its exact selector. */
  const rule = (src: string, selector: string) => src.match(new RegExp(`\\n  ${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

  it("two rows: the list form, each call over who it frees, the age warm only past a day", () => {
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 2, rows: 2 });
    const root = q('[data-testid="brief-blocked"]')!;
    expect(root.getAttribute("data-form")).toBe("graph");
    expect(root.textContent).toContain("What your calls unblock · 3 calls");
    expect(q('[data-testid="brief-blocked-headline"]')!.textContent).toBe("3 calls free 4 people and Docs release.");
    const pills = qa('[data-testid="brief-blocked-pill"]');
    expect(pills.map((p) => p.getAttribute("aria-label"))).toEqual(["Cut the hq-core release", "Fix the skill-metadata check", "Ack the Pluto handoff"]);
    expect(pills.map((p) => p.querySelector('[data-testid="brief-blocked-title"]')!.textContent)).toEqual(["Cut the hq-core release", "Fix the skill-metadata check", "Ack the Pluto handoff"]);
    expect(pills.map((p) => p.querySelector('[data-testid="brief-blocked-product"]')!.textContent)).toEqual(["HQ core", "Desktop app", "Desktop app"]);
    const ages = qa('[data-testid="brief-blocked-age"]');
    expect(ages.map((a) => a.textContent)).toEqual(["30h", "3d", "17h"]);
    expect(ages.map((a) => a.classList.contains("late"))).toEqual([true, true, false]);
    const parties = qa('[data-testid="brief-blocked-party"]');
    expect(parties.map((p) => p.getAttribute("aria-label"))).toEqual(["Jonathan", "Geoff", "Docs release", "Stefan", "Yousuf"]);
    expect(parties.map((p) => p.getAttribute("data-kind"))).toEqual(["person", "person", "work", "person", "person"]);
    // Each party sits under the call that frees it, after a Phosphor arrow, with what they do next.
    const under = (i: number) => [...pills[i]!.closest(".pair")!.querySelectorAll('[data-testid="brief-blocked-party"]')].map((p) => p.getAttribute("aria-label"));
    expect([under(0), under(1), under(2)]).toEqual([["Jonathan", "Geoff", "Docs release"], ["Stefan"], ["Yousuf"]]);
    expect(qa('[data-testid="brief-blocked-arrow"]')).toHaveLength(5);
    expect(parties[0]!.textContent!.replace(/\s+/g, " ").trim()).toBe("J Jonathan ships the planning changes");
    // Monochrome avatars: a person's initial in a glass circle, a cube for work; no company square, no hue.
    expect(parties.map((p) => p.querySelector(".ini")!.textContent!.trim())).toEqual(["J", "G", "", "S", "Y"]);
    expect(parties[2]!.querySelector('[data-testid="brief-blocked-work"]')).not.toBeNull();
    expect(qa(".ini[style]")).toHaveLength(0);
    expect(q('[data-testid="brief-blocked-more"]')).toBeNull();
    expect(q('[data-testid="brief-blocked-more-pills"]')).toBeNull();
    // Company logos sit on every call's meta line.
    expect(qa('[data-testid="brief-blocked-pill"] [data-testid="brief-logo"]')).toHaveLength(3);
    // The numbers band: calls, who waits, the oldest call (late).
    const stats = qa('[data-testid="brief-blocked-stat"]');
    expect(stats.map((x) => x.textContent!.replace(/\s+/g, " ").trim())).toEqual(["3 Calls", "5 Waiting on them", "3d Oldest call"]);
    expect(stats.map((x) => x.classList.contains("late"))).toEqual([false, false, true]);
  });

  it("caps at three calls and five party lines, then each call's +N more and +N more calls, whose peeks list the rest", async () => {
    const many = [
      decision("d1", "One", { ageHours: 30, blocks: ["Ava", "Ben", "Cal", "Dee"].map((n) => person(n)) }),
      decision("d2", "Two", { blocks: [person("Eli"), person("Fay")] }),
      decision("d3", "Three", { blocks: [person("Gus")] }),
      decision("d4", "Four", { blocks: [person("Hal")] }),
      decision("d5", "Five", { blocks: [person("Ivy")] }),
    ];
    render({ decisions: many, cols: 2, rows: 2 });
    expect(qa('[data-testid="brief-blocked-pill"]')).toHaveLength(3);
    expect(qa('[data-testid="brief-blocked-party"]').map((p) => p.getAttribute("aria-label"))).toEqual(["Ava", "Ben", "Cal", "Eli", "Gus"]);
    const more = qa('[data-testid="brief-blocked-more"]');
    expect(more.map((m) => m.textContent!.trim())).toEqual(["+1 more", "+1 more"]);
    // The "+N more" rides on its call's last line.
    expect(more[0]!.closest(".fr")!.querySelector('[data-testid="brief-blocked-party"]')!.getAttribute("aria-label")).toBe("Cal");
    const morePills = q('[data-testid="brief-blocked-more-pills"]')!;
    expect(morePills.textContent!.trim()).toBe("+2 more calls");
    await hover(more[0]!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("1 more waiting on you");
    expect(peek.textContent).toContain("Dee");
    more[0]!.dispatchEvent(new MouseEvent("mouseleave"));
    await new Promise((r) => setTimeout(r, 200));
    flushSync();
    await hover(more[1]!);
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("Fay");
    more[1]!.dispatchEvent(new MouseEvent("mouseleave"));
    await new Promise((r) => setTimeout(r, 200));
    flushSync();
    await hover(morePills);
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("2 more calls");
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("Four");
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("Five");
  });

  it("a call's hover opens the decision peek with its prompt and a Start button, dims the other calls, and starting it frees its parties", async () => {
    const launch = vi.fn(async () => null);
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 2, rows: 2, launch });
    const pill = qa('[data-testid="brief-blocked-pill"]')[2]!; // Ack the Pluto handoff
    await hover(pill);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Ack the Pluto handoff");
    expect(peek.textContent).toContain("Ack Pluto.");
    expect(peek.querySelector('[data-testid="brief-start"]')).not.toBeNull();
    expect(q('[data-testid="brief-blocked-graph"]')!.classList.contains("focus")).toBe(true);
    const lifted = qa('.fr.lift [data-testid="brief-blocked-party"]');
    expect(lifted.map((p) => p.getAttribute("aria-label"))).toEqual(["Yousuf"]);
    expect(qa('[data-testid="brief-blocked-pill"].dim')).toHaveLength(2);
    expect(pill.classList.contains("dim")).toBe(false);
    (peek.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(launch).toHaveBeenCalledWith("claude", "Ack Pluto.");
    expect(pill.classList.contains("done")).toBe(true);
    expect(qa('[data-testid="brief-blocked-age"]')[2]!.textContent).toBe("Done");
    const yousuf = qa('[data-testid="brief-blocked-party"]').find((p) => p.getAttribute("aria-label") === "Yousuf")!;
    expect(yousuf.getAttribute("data-freed")).toBe("true");
    expect(yousuf.closest(".fr")!.querySelector('[data-testid="brief-blocked-state"]')!.textContent).toBe("Freed");
    const jonathan = qa('[data-testid="brief-blocked-party"]')[0]!;
    expect(jonathan.getAttribute("data-freed")).toBe("false");
  });

  it("each call carries its own Start button (revealed on hover in place of the age) that launches its prompt", async () => {
    const launch = vi.fn(async () => null);
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 2, rows: 2, launch });
    const pills = qa('[data-testid="brief-blocked-pill"]');
    expect(pills.map((p) => !!p.querySelector('[data-testid="brief-blocked-acts"] [data-testid="brief-start"]'))).toEqual([true, true, true]);
    (pills[0]!.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(launch).toHaveBeenCalledWith("claude", "Cut the release. Stop for my go.");
    expect(pills[0]!.classList.contains("done")).toBe(true);
    // Done: the age becomes Done and the button goes away.
    expect(pills[0]!.querySelector('[data-testid="brief-blocked-acts"]')).toBeNull();
    // No prompt, no button.
    unmount(app!);
    app = null;
    target.remove();
    render({ decisions: day(), prompts: {}, cols: 2, rows: 2 });
    expect(qa('[data-testid="brief-blocked-acts"]')).toHaveLength(0);
  });

  it("one row: the chain form, the lead call then one arrow into a node per freed party up to the cap", () => {
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 3, rows: 1 });
    const root = q('[data-testid="brief-blocked"]')!;
    expect(root.getAttribute("data-form")).toBe("chain");
    const you = q('[data-testid="brief-blocked-you"]')!;
    expect(you.getAttribute("aria-label")).toBe("Cut the hq-core release");
    expect(you.querySelector('[data-testid="brief-blocked-title"]')!.textContent).toBe("Cut the hq-core release");
    expect(you.querySelector('[data-testid="brief-blocked-age"]')!.textContent).toBe("30h");
    expect(you.querySelector('[data-testid="brief-blocked-age"]')!.classList.contains("late")).toBe(true);
    const nodes = qa('[data-testid="brief-blocked-node"]');
    expect(nodes.map((n) => n.getAttribute("aria-label"))).toEqual(["Jonathan", "Geoff", "Docs release"]);
    expect(nodes.map((n) => n.getAttribute("data-state"))).toEqual(["WAITING", "WAITING", "HELD"]);
    expect(nodes.map((n) => n.querySelector(".ini")!.textContent!.trim())).toEqual(["J", "G", ""]);
    expect(q('[data-testid="brief-blocked-more"]')!.textContent).toContain("+2 more");
    expect(qa('[data-testid="brief-blocked-chain"] [data-testid="brief-blocked-arrow"]')).toHaveLength(1);
    // No numbers band on a one-row card.
    expect(q('[data-testid="brief-blocked-sum"]')).toBeNull();
    unmount(app!);
    app = null;
    target.remove();
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 2, rows: 1 });
    expect(qa('[data-testid="brief-blocked-node"]')).toHaveLength(2);
    expect(q('[data-testid="brief-blocked-more"]')!.textContent).toContain("+3 more");
    unmount(app!);
    app = null;
    target.remove();
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 1, rows: 1 });
    expect(qa('[data-testid="brief-blocked-node"]')).toHaveLength(1);
    expect(q('[data-testid="brief-blocked-more"]')!.textContent).toContain("+4 more");
  });

  it("one row: once the lead call is made its parties read freed", async () => {
    const launch = vi.fn(async () => null);
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 3, rows: 1, launch });
    (q('[data-testid="brief-blocked-you"] [data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(q('[data-testid="brief-blocked-chain"]')!.classList.contains("done")).toBe(true);
    expect(qa('[data-testid="brief-blocked-node"]').map((n) => n.getAttribute("data-state"))).toEqual(["FREED", "FREED", "FREED"]);
  });

  it("one column, two rows: two calls and three lines at most", () => {
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 1, rows: 2 });
    expect(qa('[data-testid="brief-blocked-pill"]')).toHaveLength(2);
    expect(qa('[data-testid="brief-blocked-party"]')).toHaveLength(3);
    expect(q('[data-testid="brief-blocked-more-pills"]')!.textContent!.trim()).toBe("+1 more call");
  });

  it("empty rule: with no edged decision the card has no headline and draws nothing", () => {
    render({ decisions: [decision("d4", "Answer the auditor", { ageHours: 3 })], cols: 2, rows: 2 });
    expect(q('[data-testid="brief-blocked-headline"]')!.textContent).toBe("");
    expect(qa('[data-testid="brief-blocked-pill"]')).toHaveLength(0);
    expect(qa('[data-testid="brief-blocked-party"]')).toHaveLength(0);
    expect(qa('[data-testid="brief-blocked-arrow"]')).toHaveLength(0);
    expect(q('[data-testid="brief-blocked-sum"]')).toBeNull();
  });

  it("unlocks only: work lines from the unlock lines, their mono states, and no word people", () => {
    const only = [decision("d1", "Cut the hq-core release", { detail: { why: "", unlocks: [unlock("Docs PR 64 can merge"), unlock("Glossary rename reaches users", "RELEASE")], source: "" } })];
    render({ decisions: only, cols: 2, rows: 2 });
    expect(q('[data-testid="brief-blocked-headline"]')!.textContent).toBe("Your 1 call unlocks 2 things.");
    expect(q('[data-testid="brief-blocked"]')!.textContent).not.toMatch(/people/);
    expect(qa('[data-testid="brief-blocked-state"]').map((n) => n.textContent)).toEqual(["NEXT", "RELEASE"]);
    unmount(app!);
    app = null;
    target.remove();
    render({ decisions: only, cols: 3, rows: 1 });
    expect(q('[data-testid="brief-blocked"]')!.textContent).not.toMatch(/people/);
    expect(qa('[data-testid="brief-blocked-node"]').map((n) => n.getAttribute("data-state"))).toEqual(["NEXT", "RELEASE"]);
  });

  it("no repo slug or PR number reaches the page in either form", () => {
    const dirty = [
      decision("d1", "indigoai-us/hq-core #1201: feat(release): cut the release", { ageHours: 30, blocks: [person("Jonathan"), work("indigo-docs #64: docs: document the merge")] }),
      decision("d2", "Ack the Pluto handoff", { blocks: [person("Yousuf")] }),
    ];
    for (const rows of [1, 2]) {
      render({ decisions: dirty, cols: 3, rows });
      const text = q('[data-testid="brief-blocked"]')!.textContent!;
      expect(text).not.toMatch(PR_NUMBER);
      expect(text).not.toMatch(SLUG);
      expect(text).toContain("Document the merge");
      unmount(app!);
      app = null;
      target.remove();
    }
  });

  it("design rules: titles, names and what waits wrap and are never cut; the age warms past a day; mono labels are caps; no hue, glow or rim (regression: titles clipped at the card edge, names cut to 'the ro…', a solid violet avatar)", () => {
    const src = SRC();
    const style = src.slice(src.indexOf("<style>"));
    for (const sel of [".ct", ".ptx", ".node .t", ".w h3"]) {
      const body = rule(style, sel);
      expect(body, sel).not.toBe("");
      expect(body, sel).not.toMatch(/text-overflow|line-clamp|nowrap|overflow:\s*hidden/);
    }
    expect(style).not.toMatch(/text-overflow:\s*ellipsis|line-clamp/);
    expect(rule(style, ".age.late")).toMatch(/color:\s*#ffe08a/);
    // The hero numbers stay white; a late oldest call is a small warm dot, never a large yellow number.
    expect(rule(style, ".stat b")).toMatch(/color:\s*#fff;/);
    expect(style).not.toMatch(/\.stat[^{]*\bb\s*\{[^}]*#ffe08a/);
    expect(rule(style, ".stat.late span::before")).toMatch(/width:\s*6px/);
    expect(rule(style, ".stat.late span::before")).toMatch(/background:\s*#ffe08a/);
    expect(rule(style, ".age.late")).toMatch(/background:\s*rgba\(255, 205, 110, 0\.32\)/);
    expect(rule(style, ".ini")).toMatch(/border-radius:\s*50%/);
    expect(rule(style, ".ini")).toMatch(/background:\s*rgba\(255, 255, 255, 0\.2\)/);
    expect(style).not.toMatch(/hsl\(|backdrop-filter|box-shadow:(?!\s*none)|border:\s*1px|text-shadow|filter:\s*drop/);
    for (const sel of [".prod", ".st", ".verb", ".stat span"]) {
      const body = rule(style, sel);
      expect(body, sel).toMatch(/font-family:\s*var\(--b-code\)/);
      expect(body, sel).toMatch(/text-transform:\s*uppercase/);
      expect(body, sel).toMatch(/letter-spacing:\s*0\.08em/);
      expect(body, sel).toMatch(/font-size:\s*1[01]px/);
    }
    // The Start button hides until the call is hovered, in the age's place, so nothing moves.
    expect(rule(style, ".acts")).toMatch(/position:\s*absolute/);
    expect(rule(style, ".acts")).toMatch(/opacity:\s*0/);
    // Phosphor arrow-right (regular).
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 2, rows: 2 });
    const arrow = q('[data-testid="brief-blocked-arrow"]')!;
    expect(arrow.getAttribute("viewBox")).toBe("0 0 256 256");
    expect(arrow.querySelector("path")!.getAttribute("d")).toMatch(/^M221\.66,133\.66l-72,72/);
  });
});
