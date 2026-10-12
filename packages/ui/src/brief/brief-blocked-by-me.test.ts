// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./BriefBlockedByMeHarness.test-support.svelte";
import {
  MORE_KEY,
  PARTY_CAP,
  PILL_CAP,
  ageLabel,
  blockedHeadline,
  blockedLayout,
  chainNodes,
  edgedDecisions,
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

describe("blockedLayout and chainNodes", () => {
  const many = () => [
    decision("d1", "One", { ageHours: 30, blocks: ["A", "B", "C", "D"].map((n) => person(n)) }),
    decision("d2", "Two", { blocks: [person("E"), person("F")] }),
    decision("d3", "Three", { blocks: [person("G")] }),
    decision("d4", "Four", { blocks: [person("H")] }),
    decision("d5", "Five", { blocks: [person("I")] }),
  ];

  it("caps pills at three and parties at five; the rest fold into +N more with their edges", () => {
    const lay = blockedLayout(summarizeBlocked(many()));
    expect(PILL_CAP).toBe(3);
    expect(PARTY_CAP).toBe(5);
    expect(lay.pills.map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect(lay.morePills.map((d) => d.id)).toEqual(["d4", "d5"]);
    expect(lay.parties.map((p) => p.name)).toEqual(["A", "B", "C", "D", "E"]);
    expect(lay.moreParties.map((p) => p.name)).toEqual(["F", "G", "H", "I"]);
    // d2 frees E (shown) and F (folded): one edge to E, one to the more tile; d3's G is folded too.
    const toMore = lay.edges.filter((e) => e.partyKey === MORE_KEY);
    expect(toMore.map((e) => [e.decisionId, e.to])).toEqual([
      ["d2", 5],
      ["d3", 5],
    ]);
    expect(lay.edges.every((e) => e.from >= 0 && e.from < 3 && e.to <= 5)).toBe(true);
    // Hidden calls draw nothing.
    expect(lay.edges.some((e) => e.decisionId === "d4" || e.decisionId === "d5")).toBe(false);
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

  it("two rows: the graph with one pill per call, one party per freed person or work, amber only past a day", () => {
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 2, rows: 2 });
    const root = q('[data-testid="brief-blocked"]')!;
    expect(root.getAttribute("data-form")).toBe("graph");
    expect(root.textContent).toContain("What your calls unblock · 3 calls");
    expect(q('[data-testid="brief-blocked-headline"]')!.textContent).toBe("3 calls free 4 people and Docs release.");
    const pills = qa('[data-testid="brief-blocked-pill"]');
    expect(pills.map((p) => p.getAttribute("aria-label"))).toEqual(["Cut the hq-core release", "Fix the skill-metadata check", "Ack the Pluto handoff"]);
    const ages = qa('[data-testid="brief-blocked-age"]');
    expect(ages.map((a) => a.textContent)).toEqual(["30h", "3d", "17h"]);
    expect(ages.map((a) => a.classList.contains("amber"))).toEqual([true, true, false]);
    const parties = qa('[data-testid="brief-blocked-party"]');
    expect(parties.map((p) => p.getAttribute("aria-label"))).toEqual(["Jonathan", "Geoff", "Docs release", "Stefan", "Yousuf"]);
    expect(parties.map((p) => p.getAttribute("data-kind"))).toEqual(["person", "person", "work", "person", "person"]);
    expect(target.querySelectorAll("path.edge")).toHaveLength(5);
    expect(qa("path.edge.late")).toHaveLength(4); // d1 (30h) draws three, d3 (60h) one; d2 at 17h is not late
    expect(q('[data-testid="brief-blocked-more"]')).toBeNull();
    expect(q('[data-testid="brief-blocked-more-pills"]')).toBeNull();
    // Company logos sit on every pill and on the work tile.
    expect(qa('[data-testid="brief-blocked-pill"] [data-testid="brief-logo"]')).toHaveLength(3);
    expect(q('[data-testid="brief-blocked-party"][data-kind="work"] [data-testid="brief-logo"]')).not.toBeNull();
  });

  it("caps at three pills and five parties, then +N more tiles whose peeks list the rest", async () => {
    const many = [
      decision("d1", "One", { ageHours: 30, blocks: ["Ava", "Ben", "Cal", "Dee"].map((n) => person(n)) }),
      decision("d2", "Two", { blocks: [person("Eli"), person("Fay")] }),
      decision("d3", "Three", { blocks: [person("Gus")] }),
      decision("d4", "Four", { blocks: [person("Hal")] }),
      decision("d5", "Five", { blocks: [person("Ivy")] }),
    ];
    render({ decisions: many, cols: 2, rows: 2 });
    expect(qa('[data-testid="brief-blocked-pill"]')).toHaveLength(3);
    expect(qa('[data-testid="brief-blocked-party"]')).toHaveLength(5);
    const moreParties = q('[data-testid="brief-blocked-more"]')!;
    expect(moreParties.textContent!.trim()).toBe("+4 more");
    const morePills = q('[data-testid="brief-blocked-more-pills"]')!;
    expect(morePills.textContent!.trim()).toBe("+2 more calls");
    await hover(moreParties);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("4 more waiting on you");
    for (const n of ["Fay", "Gus", "Hal", "Ivy"]) expect(peek.textContent).toContain(n);
    moreParties.dispatchEvent(new MouseEvent("mouseleave"));
    await new Promise((r) => setTimeout(r, 200));
    flushSync();
    await hover(morePills);
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("2 more calls");
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("Four");
    expect(q('[data-testid="brief-peek"]')!.textContent).toContain("Five");
  });

  it("a pill's hover opens the decision peek with its prompt and a Start button, and lights only its edges", async () => {
    const launch = vi.fn(async () => null);
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 2, rows: 2, launch });
    const pill = qa('[data-testid="brief-blocked-pill"]')[2]!; // Ack the Pluto handoff
    await hover(pill);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Ack the Pluto handoff");
    expect(peek.textContent).toContain("Ack Pluto.");
    expect(peek.querySelector('[data-testid="brief-start"]')).not.toBeNull();
    expect(q('[data-testid="brief-blocked-graph"]')!.classList.contains("focus")).toBe(true);
    expect(qa("path.edge.on")).toHaveLength(1);
    const lifted = qa('[data-testid="brief-blocked-party"].lift');
    expect(lifted.map((p) => p.getAttribute("aria-label"))).toEqual(["Yousuf"]);
    expect(qa('[data-testid="brief-blocked-pill"].dim')).toHaveLength(2);
    (peek.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(launch).toHaveBeenCalledWith("claude", "Ack Pluto.");
    expect(pill.classList.contains("done")).toBe(true);
    expect(qa('[data-testid="brief-blocked-age"]')[2]!.textContent).toBe("DONE");
  });

  it("one row: the chain form with the top call as the you node and one node per freed party up to the cap", () => {
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 3, rows: 1 });
    const root = q('[data-testid="brief-blocked"]')!;
    expect(root.getAttribute("data-form")).toBe("chain");
    expect(q('[data-testid="brief-blocked-you"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe("Cut the hq-core release YOU · 30h");
    const nodes = qa('[data-testid="brief-blocked-node"]');
    expect(nodes.map((n) => n.getAttribute("aria-label"))).toEqual(["Jonathan", "Geoff", "Docs release"]);
    expect(nodes.map((n) => n.querySelector("small")!.textContent)).toEqual(["WAITING", "WAITING", "HELD"]);
    expect(q('[data-testid="brief-blocked-more"]')!.textContent).toContain("+2 more");
    expect(qa(".link")).toHaveLength(4);
    expect(qa(".link.stop")).toHaveLength(0);
    unmount(app!);
    app = null;
    target.remove();
    render({ decisions: day(), prompts: ALL_PROMPTS, cols: 2, rows: 1 });
    expect(qa('[data-testid="brief-blocked-node"]')).toHaveLength(2);
    expect(q('[data-testid="brief-blocked-more"]')!.textContent).toContain("+3 more");
  });

  it("empty rule: with no edged decision the card has no headline and draws nothing", () => {
    render({ decisions: [decision("d4", "Answer the auditor", { ageHours: 3 })], cols: 2, rows: 2 });
    expect(q('[data-testid="brief-blocked-headline"]')!.textContent).toBe("");
    expect(qa('[data-testid="brief-blocked-pill"]')).toHaveLength(0);
    expect(qa('[data-testid="brief-blocked-party"]')).toHaveLength(0);
    expect(target.querySelectorAll("path.edge")).toHaveLength(0);
  });

  it("unlocks only: work tiles from the unlock lines, their mono states, and no word people", () => {
    const only = [decision("d1", "Cut the hq-core release", { detail: { why: "", unlocks: [unlock("Docs PR 64 can merge"), unlock("Glossary rename reaches users", "RELEASE")], source: "" } })];
    render({ decisions: only, cols: 3, rows: 1 });
    expect(q('[data-testid="brief-blocked-headline"]')!.textContent).toBe("Your 1 call unlocks 2 things.");
    expect(q('[data-testid="brief-blocked"]')!.textContent).not.toMatch(/people/);
    expect(qa('[data-testid="brief-blocked-node"]').map((n) => n.querySelector("small")!.textContent)).toEqual(["NEXT", "RELEASE"]);
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
});
