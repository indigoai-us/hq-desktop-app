// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BriefCarryHost from "./fixtures/BriefCarryHost.svelte";
import { CATALOGUE, buildContext } from "./brief-catalogue.js";
import {
  CARRY_CAP,
  CARRY_CAP_SHORT,
  ageLabel,
  carryAge,
  carryDay,
  carryHeadline,
  carryMorePeek,
  carryPeek,
  carryPrompt,
  carryRows,
  carryTag,
  dayShort,
  firstSeenLabel,
  linkedItem,
  orphanRows,
  resolvePrompt,
  ringTone,
  threadX,
} from "./brief-carry.js";
import type { BriefCarry, BriefDecision, BriefInput, BriefRisk } from "./brief-types.js";

// The real 2026-10-11 run: a Sunday, 14:54Z.
const NOW = "2026-10-11T14:54:28Z";
const NOW_MS = Date.parse(NOW);
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW_MS - hours * HOUR).toISOString();
const origin = { companyUid: "indigo", repo: "indigoai-us/hq-core", product: "HQ core" };

const row = (id: string, extra: Partial<BriefCarry> = {}): BriefCarry => ({
  id,
  title: `Carry ${id}`,
  why: "Still waiting since the last brief.",
  origin,
  carriedFrom: "brief-20261010-142540",
  carriedSince: ago(18),
  briefs: 1,
  itemId: null,
  ...extra,
});

const d3: BriefDecision = {
  id: "d3",
  title: "Fix the red release checks in HQ core",
  summary: "Main has been red since Friday.",
  action: "go",
  origin,
  prompt: "Decision prompt for d3.",
};
const p2: BriefRisk = { id: "p2", title: "Unstick five fleet agents in setup", summary: "Five agents stuck.", severity: "incident", links: [], origin, prompt: "Incident prompt for p2." };
const w9: BriefRisk = { id: "w9", title: "Signup funnel drift", summary: "Watch.", severity: "watch", links: [], origin };

/** Seven rows: five orphans (c1 c2 c3 c6 c7) and two continued by a card today (c4 -> d3, c5 -> p2). */
const CARRY: BriefCarry[] = [
  row("c1", { title: "hq-core #1201: feat(docs): update the CLI reference for /grill-me", carriedSince: ago(18) }),
  row("c2", { title: "Cut the HQ core release", carriedFrom: "brief-20261009-090000", carriedSince: ago(36), briefs: 2, prompt: "Own prompt for c2." }),
  row("c3", { title: "Reply to Zach about onboarding", carriedFrom: "brief-20261008-090000", carriedSince: ago(50), briefs: 3 }),
  row("c4", { title: "Fix the red release checks", carriedSince: ago(20), itemId: "d3" }),
  row("c5", { title: "Unstick five fleet agents", carriedSince: ago(20), itemId: "p2" }),
  row("c6", { title: "Look at the signup funnel", carriedSince: ago(30), itemId: "w9" }),
  row("c7", { title: "Answer Geoff's dashboard question", carriedSince: ago(26), itemId: "d-gone" }),
];
const DECISIONS = [d3];
const RISKS = [p2, w9];
const PROMPTS: Record<string, string> = { d3: "Plan prompt for d3.", p2: "Plan prompt for p2." };

const input = (carry: BriefCarry[]): BriefInput => ({
  now: NOW,
  today: "2026-10-11",
  userName: "Corey",
  companies: ["indigo"],
  calendarToday: [],
  meetingsYesterday: [],
  decisions: DECISIONS,
  actionItems: [],
  risks: RISKS,
  shipped: [],
  waitingOn: [],
  team: [],
  sessions: [],
  lastBriefAt: ago(18),
  carry,
});

describe("carry rows", () => {
  it("counts the same orphans as the catalogue's carry.measure, and hosts the same ids", () => {
    const entry = CATALOGUE.find((e) => e.id === "carry")!;
    const ev = entry.measure(buildContext(input(CARRY)))!;
    const rows = carryRows(CARRY, DECISIONS, RISKS, NOW_MS);
    const orphans = orphanRows(rows);
    expect(ev.n).toBe(orphans.length);
    expect(orphans.length).toBe(5);
    const hosted = [...new Set(orphans.flatMap((r) => (r.carry.itemId ? [r.carry.id, r.carry.itemId] : [r.carry.id])))].sort();
    expect(hosted).toEqual(ev.items);
    // Every row linked: the picker hides the card (measure null) and the card would say so.
    expect(entry.measure(buildContext(input([CARRY[3]!, CARRY[4]!])))).toBeNull();
    expect(carryHeadline(0)).toBe("Everything carried has a card today");
  });

  it("links a row to a decision or live incident present today, never to a watch or a missing id", () => {
    expect(linkedItem({ itemId: "d3" }, DECISIONS, RISKS)?.id).toBe("d3");
    expect(linkedItem({ itemId: "p2" }, DECISIONS, RISKS)?.id).toBe("p2");
    expect(linkedItem({ itemId: "w9" }, DECISIONS, RISKS)).toBeNull();
    expect(linkedItem({ itemId: "d-gone" }, DECISIONS, RISKS)).toBeNull();
    expect(linkedItem({ itemId: null }, DECISIONS, RISKS)).toBeNull();
  });

  it("orders orphans first, coldest first, then the rows a card continues", () => {
    const rows = carryRows(CARRY, DECISIONS, RISKS, NOW_MS);
    expect(rows.map((r) => r.carry.id)).toEqual(["c3", "c2", "c6", "c7", "c1", "c4", "c5"]);
    expect(rows.slice(0, 5).every((r) => !r.linked)).toBe(true);
    expect(rows.slice(5).every((r) => !!r.linked)).toBe(true);
    // A linked row launches the linked item, so clearing it clears it everywhere.
    expect(rows.find((r) => r.carry.id === "c4")!.launchId).toBe("d3");
    expect(rows.find((r) => r.carry.id === "c1")!.launchId).toBe("c1");
  });

  it("colours the ring by age: white at 12h, amber at 30h, red at 50h; grey when a card continues it", () => {
    expect(ringTone(false, 12, 1)).toBe("white");
    expect(ringTone(false, 30, 1)).toBe("warn");
    expect(ringTone(false, 50, 1)).toBe("red");
    expect(ringTone(true, 50, 3)).toBe("grey");
    // No carriedSince: the brief count stands in.
    expect(ringTone(false, null, 1)).toBe("white");
    expect(ringTone(false, null, 2)).toBe("warn");
    expect(ringTone(false, null, 3)).toBe("red");
    const rows = carryRows(CARRY, DECISIONS, RISKS, NOW_MS);
    expect(Object.fromEntries(rows.map((r) => [r.carry.id, r.tone]))).toEqual({ c1: "white", c2: "warn", c3: "red", c4: "grey", c5: "grey", c6: "warn", c7: "warn" });
  });

  it("reads age from carriedSince and the first-seen day from the run id, else the ISO date", () => {
    expect(carryAge({ carriedSince: ago(30) }, NOW_MS)).toBeCloseTo(30, 5);
    expect(carryAge({ carriedSince: null }, NOW_MS)).toBeNull();
    expect(carryAge({ carriedSince: "soon" }, NOW_MS)).toBeNull();
    expect(carryDay({ carriedFrom: "brief-20261010-142540", carriedSince: null })).toBe("2026-10-10");
    expect(carryDay({ carriedFrom: "unknown", carriedSince: "2026-10-09T20:27:08Z" })).toBe("2026-10-09");
    expect(carryDay({ carriedFrom: "", carriedSince: null })).toBeNull();
    expect(firstSeenLabel({ carriedFrom: "brief-20261010-142540", carriedSince: null })).toBe("brief of Oct 10");
    expect(firstSeenLabel({ carriedFrom: "", carriedSince: null })).toBe("an earlier brief");
    // Weekday by arithmetic: Oct 9 2026 is a Friday, Oct 11 a Sunday.
    expect(dayShort("2026-10-09")).toBe("Fri");
    expect(dayShort("2026-10-11")).toBe("Sun");
    expect(dayShort("nope")).toBe("");
  });

  it("writes plain titles: no repo, PR number or commit prefix", () => {
    const rows = carryRows(CARRY, DECISIONS, RISKS, NOW_MS);
    expect(rows.find((r) => r.carry.id === "c1")!.title).toBe("Update the CLI reference for /grill-me");
  });
});

describe("carry copy", () => {
  const rows = carryRows(CARRY, DECISIONS, RISKS, NOW_MS);
  const by = (id: string) => rows.find((r) => r.carry.id === id)!;

  it("headline: one promise, N things", () => {
    expect(carryHeadline(1)).toBe("One promise has no follow-up yet");
    expect(carryHeadline(5)).toBe("5 things carried over");
  });

  it("mono tag: briefs running, else the day it was first seen; catch-up shows the day itself", () => {
    expect(carryTag(by("c2"))).toBe("2 briefs");
    expect(carryTag(by("c3"))).toBe("3 briefs");
    expect(carryTag(by("c1"))).toBe("since Sat");
    expect(carryTag(by("c1"), true)).toBe("Oct 10");
    expect(carryTag(by("c3"), true)).toBe("Oct 8");
    const old = carryRows([row("old", { carriedFrom: "brief-20261001-090000", carriedSince: ago(10 * 24) })], [], [], NOW_MS)[0]!;
    expect(carryTag(old)).toBe("since Oct 1");
    const bare = carryRows([row("bare", { carriedFrom: "", carriedSince: null })], [], [], NOW_MS)[0]!;
    expect(carryTag(bare)).toBe("1 brief");
  });

  it("status line reads the age in the owner's words", () => {
    expect(ageLabel(by("c1"))).toBe("Open · 18h");
    expect(ageLabel(by("c2"))).toBe("Cold · 36h");
    expect(ageLabel(by("c3"))).toBe("Likely dropped · 50h");
    expect(ageLabel(by("c4"))).toBe("Has a card today");
  });

  it("the micro-timeline puts today at 154 and 72h ago at 4, clamped", () => {
    expect(threadX(0)).toBe(154);
    expect(threadX(72)).toBe(4);
    expect(threadX(100)).toBe(4);
    expect(threadX(36)).toBe(79);
    expect(threadX(null)).toBeNull();
  });

  it("prompt: a linked row uses the linked item's (plan first), an orphan its own, else a written one", () => {
    expect(resolvePrompt(by("c4"), PROMPTS)).toBe("Plan prompt for d3.");
    expect(resolvePrompt(by("c4"), {})).toBe("Decision prompt for d3.");
    expect(resolvePrompt(by("c2"), PROMPTS)).toBe("Own prompt for c2.");
    const written = resolvePrompt(by("c3"), PROMPTS);
    expect(written).toBe(carryPrompt(by("c3")));
    expect(written).toContain('Pick up "Reply to Zach about onboarding"');
    expect(written).toContain("brief of Oct 8");
    expect(written).toContain("after 3 briefs");
    expect(written).toMatch(/Stop and confirm with me before any irreversible step/);
    expect(written).not.toMatch(/#\d+|[\w-]+\/[\w-]+/);
  });

  it("peek: why, first seen, closest follow-up (or none), prompt", () => {
    const orphan = carryPeek(by("c3"), "P");
    expect(orphan.title).toBe("Reply to Zach about onboarding");
    expect(orphan.status).toBe("Likely dropped · 50h");
    expect(orphan.sections.map((s) => s.label)).toEqual(["Why", "First seen", "Closest follow-up"]);
    expect(orphan.sections[1]!.text).toBe("brief of Oct 8 · 3 briefs running");
    expect(orphan.sections[2]!.text).toBe("No session, change or edit since");
    expect(orphan.prompt).toEqual({ id: "c3", text: "P" });
    const linked = carryPeek(by("c5"), "Q");
    expect(linked.status).toBe("Has a card today");
    expect(linked.sections[2]!.lines).toEqual([{ label: p2.title, state: "LIVE", tone: "red" }]);
    expect(linked.prompt?.id).toBe("p2");
    const more = carryMorePeek(rows.slice(5));
    expect(more.title).toBe("2 more carried over");
    expect(more.sections[0]!.lines!.map((l) => l.label)).toEqual(["Fix the red release checks", "Unstick five fleet agents"]);
  });
});

describe("BriefCarry", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(props: Record<string, unknown> = {}) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefCarryHost, {
      target,
      props: { carry: CARRY, decisions: DECISIONS, risks: RISKS, prompts: PROMPTS, rows: 2, now: NOW, companies: [{ uid: "indigo", label: "Indigo", iconUrl: null }], ...props },
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
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    flushSync();
  }

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("shows the eyebrow, the headline count of orphans, five rows then +N more; the peek lists the rest", async () => {
    render();
    const card = q('[data-testid="brief-carry"]')!;
    expect(card.querySelector(".eyebrow")!.textContent!.replace(/\s+/g, " ").trim()).toBe("Still open since your last brief");
    expect(q('[data-testid="brief-carry-title"]')!.textContent).toBe("5 things carried over");
    expect(card.getAttribute("data-orphans")).toBe("5");
    const rows = qa('[data-testid="brief-carry-row"]');
    expect(rows).toHaveLength(CARRY_CAP);
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Reply to Zach about onboarding",
      "Cut the HQ core release",
      "Look at the signup funnel",
      "Answer Geoff's dashboard question",
      "Update the CLI reference for /grill-me",
    ]);
    const more = q('[data-testid="brief-carry-more"]')!;
    expect(more.textContent!.trim()).toBe("+2 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("2 more carried over");
    expect(peek.textContent).toContain("Fix the red release checks");
    expect(peek.textContent).toContain("Unstick five fleet agents");
    // Logos on every row; the footer sums both kinds.
    expect(qa('[data-testid="brief-logo"]').length).toBeGreaterThanOrEqual(CARRY_CAP);
    expect(card.querySelector(".foot")!.textContent).toContain("5 without follow-up · 2 with a card today");
  });

  it("a one-row slot shows three rows then +N more and no footer", () => {
    render({ rows: 1 });
    expect(qa('[data-testid="brief-carry-row"]')).toHaveLength(CARRY_CAP_SHORT);
    expect(q('[data-testid="brief-carry-more"]')!.textContent!.trim()).toBe("+4 more");
    expect(q(".foot")).toBeNull();
    expect(q(".thread-line")).toBeNull();
  });

  it("renders nothing with no rows", () => {
    render({ carry: [] });
    expect(q('[data-testid="brief-carry"]')).toBeNull();
  });

  it("tones carry age only: plain under a day, warm past one or two, set back when a card continues it", () => {
    render({ carry: [CARRY[0]!, CARRY[1]!, CARRY[2]!, CARRY[3]!] });
    const tone = Object.fromEntries(qa('[data-testid="brief-carry-row"]').map((r) => [r.getAttribute("aria-label"), r.getAttribute("data-tone")]));
    expect(tone).toEqual({
      "Update the CLI reference for /grill-me": "white",
      "Cut the HQ core release": "warn",
      "Reply to Zach about onboarding": "red",
      "Fix the red release checks": "grey",
    });
    const grey = qa('[data-testid="brief-carry-row"]').find((r) => r.getAttribute("data-tone") === "grey")!;
    expect(grey.getAttribute("data-linked")).toBe("true");
    expect(grey.classList.contains("linked")).toBe(true);
    // The age pill carries the tone: warm (old) past a day, plain under one and on a continued row.
    const pill = (tone: string) =>
      qa('[data-testid="brief-carry-row"]').find((r) => r.getAttribute("data-tone") === tone)!.querySelector('[data-testid="brief-carry-tag"]')!;
    expect(pill("white").classList.contains("old")).toBe(false);
    expect(pill("warn").classList.contains("old")).toBe(true);
    expect(pill("red").classList.contains("old")).toBe(true);
    expect(pill("grey").classList.contains("old")).toBe(false);
    // Every row leads with its company's logo circle.
    expect(qa('[data-testid="brief-carry-row"]').every((r) => r.querySelector('.lg [data-testid="brief-logo"]'))).toBe(true);
    // Tags: briefs running, else the day first seen.
    expect(qa('[data-testid="brief-carry-tag"]').map((t) => t.textContent)).toEqual(["3 briefs", "2 briefs", "since Sat", "since Sat"]);
  });

  it("a linked row starts the linked item's prompt; an orphan starts its own", async () => {
    const onlaunch = vi.fn(async () => null);
    render({ onlaunch });
    const rows = qa('[data-testid="brief-carry-row"]');
    const linked = rows.find((r) => r.getAttribute("aria-label") === "Fix the red release checks");
    // c4 is past the cap of five in the full fixture; render the two linked rows with one orphan.
    expect(linked).toBeUndefined();
    unmount(app!);
    app = null;
    target.remove();
    render({ onlaunch, carry: [CARRY[1]!, CARRY[3]!] });
    const [own, viaDecision] = qa('[data-testid="brief-carry-row"]');
    expect(own!.getAttribute("aria-label")).toBe("Cut the HQ core release");
    expect(viaDecision!.getAttribute("aria-label")).toBe("Fix the red release checks");
    (viaDecision!.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await settle();
    expect(onlaunch).toHaveBeenLastCalledWith("claude", "Plan prompt for d3.");
    expect(viaDecision!.classList.contains("done")).toBe(true);
    (own!.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await settle();
    expect(onlaunch).toHaveBeenLastCalledWith("claude", "Own prompt for c2.");
    expect(own!.querySelector(".donechip")?.textContent).toBe("Done");
  });

  it("a row's peek says why, when it was first seen and that nothing followed", async () => {
    render();
    await hover(qa('[data-testid="brief-carry-row"]')[0]!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Reply to Zach about onboarding");
    expect(peek.textContent).toContain("Likely dropped · 50h");
    expect(peek.textContent).toContain("brief of Oct 8 · 3 briefs running");
    expect(peek.textContent).toContain("No session, change or edit since");
    expect(q('[data-testid="brief-peek-prompt"]')!.textContent).toContain('Pick up "Reply to Zach about onboarding"');
  });

  it("on a catch-up day every row shows the day it was first seen", () => {
    render({ catchUp: true });
    expect(qa('[data-testid="brief-carry-tag"]').map((t) => t.textContent)).toEqual(["Oct 8", "Oct 9", "Oct 10", "Oct 10", "Oct 10"]);
  });
});
