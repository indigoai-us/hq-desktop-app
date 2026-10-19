// @vitest-environment happy-dom
// Regression coverage for the owner's Oct 10 review of a real run (items 7-19).
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { humanTitle } from "./brief-distill.js";
import { keepNativeSession } from "./brief-data.js";
import { gridStyle } from "./brief-generate.js";
import { companyDisplayName, monogram, monogramHue, productName, repoShort } from "./brief-origin.js";
import { briefPriorities, meetingPeek, redAge, todoPrompt } from "./brief-peeks.js";
import { parseBriefItems } from "./brief-run-files.js";
import { sweepToInput, type BriefSweep } from "./brief-sweep.js";
import { isTimelineSession, sessionPeek } from "./brief-timeline.js";
import type { BriefDecision, BriefInput, BriefMeeting } from "./brief-types.js";

const NOW = new Date(2026, 9, 10, 14, 30);
const COMPANIES = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo", iconUrl: null }];
let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(input: BriefInput, props: Record<string, unknown> = {}) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DailyBrief, { target, props: { input, companies: COMPANIES, ...props } });
  flushSync();
}
const q = (id: string) => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...target.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
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

const decision = (i: number, extra: Partial<BriefDecision> = {}): BriefDecision => ({
  id: `d${i}`,
  title: `Decision number ${i}`,
  summary: `Why ${i}`,
  action: "decide",
  origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-desktop-app" },
  ...extra,
});

function base(extra: Partial<BriefInput> = {}): BriefInput {
  return { ...octoberEightBrief(NOW), ...extra };
}

describe("hero wording (7) and one PR source (9)", () => {
  it("says decisions before sunrise, singular and plural", () => {
    render(base({ decisions: [decision(1), decision(2), decision(3)] }));
    expect(q("brief-sunrise")!.textContent).toContain("3 decisions before sunrise.");
    expect(q("brief-sunrise")!.textContent).not.toMatch(/calls? before sunrise/);
    unmount(app!);
    app = null;
    target.remove();
    render(base({ decisions: [decision(1)] }));
    expect(q("brief-sunrise")!.textContent).toContain("1 decision before sunrise.");
  });

  it("merged and opened come from the sweep's PR window, not the per-day rollup", () => {
    const sweep: BriefSweep = {
      company: "indigo",
      window: { from: "2026-10-09", to: "2026-10-09", today: "2026-10-10" },
      days: { "2026-10-09": { merged: 29, opened: 34 } },
      prs: [
        { repo: "hq-cloud", number: 1, title: "a", state: "merged", created: "2026-10-08T10:00:00Z", closed: "2026-10-09T10:00:00Z" },
        { repo: "hq-cloud", number: 2, title: "b", state: "merged", created: "2026-10-09T10:00:00Z", closed: "2026-10-10T10:00:00Z" },
        { repo: "hq-cloud", number: 3, title: "c", state: "open", created: "2026-10-10T09:00:00Z", closed: "0001-01-01T00:00:00Z" },
        { repo: "hq-cloud", number: 4, title: "d", state: "closed", created: "2026-10-10T09:00:00Z", closed: "2026-10-10T11:00:00Z" },
        { repo: "hq-cloud", number: 5, title: "e", state: "open", created: "2026-10-07T09:00:00Z", closed: "0001-01-01T00:00:00Z" },
      ],
    };
    const s = sweepToInput(sweep, { day: "2026-10-09", companyUid: "cmp_indigo" });
    expect([s.merged, s.opened]).toEqual([2, 2]);
  });

  it("the hero sub names the window it counts", () => {
    const input = base({ merged: 31, opened: 37, prWindow: { from: "2026-10-09", to: "2026-10-09", total: 44, merged: 31, byRepo: [] } });
    render(input);
    expect(q("brief-sunrise")!.textContent).toContain("Since yesterday you merged 31 and opened 37.");
  });
});

describe("session strip (10) and session peek (15)", () => {
  const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
  const sessions = [
    { id: "s1", title: "Daily brief design", startedAt: at(5), workstream: "Work", company: "cmp_indigo" },
    { id: "s2", title: "", startedAt: at(4), workstream: "Work", company: "cmp_indigo" },
    { id: "s3", title: "", startedAt: at(3), workstream: "Other", company: null },
    { id: "s4", title: "Lane run", startedAt: at(2), workstream: "Work", company: "cmp_indigo", kind: "lane" },
  ];

  it("keeps your own sessions with a company or a title; drops background shells", () => {
    expect(sessions.filter(isTimelineSession).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(keepNativeSession({ kind: "agent", company: "indigo", title: "x" })).toBe(false);
    expect(keepNativeSession({ kind: "you", company: "", title: "" })).toBe(false);
    expect(keepNativeSession({ kind: "you", company: "indigo", title: "" })).toBe(true);
  });

  it("eyebrow reads 'Last 24h · n sessions' with background count on hover only", () => {
    render(base({ recentSessions: [...sessions, { id: "s5", title: "auto-checkpoint", startedAt: at(1), workstream: "Work", company: "cmp_indigo" }] }));
    const head = q("brief-timeline-head")!;
    expect(head.textContent!.trim()).toBe("Last 24h · 2 sessions");
    expect(head.getAttribute("data-hidden")).toBe("1 background session hidden");
    expect(qa("brief-session-dot")).toHaveLength(2);
  });

  it("a session dot's tip and label read the plain title the Focus card shows, never the repo or PR number", () => {
    render(base({ recentSessions: [{ id: "s9", title: "hq-core #1217: feat(conduct): on by default in v16", startedAt: at(2), workstream: "Work", company: "cmp_indigo" }] }));
    const dot = qa("brief-session-dot")[0]!;
    expect(dot.getAttribute("aria-label")).toMatch(/ On by default in v16$/);
    expect(dot.textContent).toContain("On by default in v16");
    expect(dot.textContent).not.toContain("#1217");
    expect(dot.textContent).not.toContain("hq-core");
  });

  it("the session peek is the mockup card: eyebrow, company chip, title, time line, two buttons, no prompt text", async () => {
    const p = sessionPeek({ at: at(5), title: "", id: "s2", company: "cmp_indigo" }, 4, 8);
    expect(p.title).toBe("Untitled session");
    expect(p.compact).toBe(true);
    expect(p.eyebrow).toMatch(/^Session · Oct \d+$/);
    expect(p.status).toMatch(/^\d{1,2}:\d{2} (AM|PM) · session 5 of 8$/);
    expect(p.prompt!.text).not.toContain('""');
    const onlaunch = vi.fn(async () => null);
    render(base({ recentSessions: sessions }), { onlaunch });
    await hover(qa("brief-session-dot")[0]!);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("Daily brief design");
    expect(peek.textContent).not.toContain("Prompt");
    expect(q("brief-peek-prompt")).toBeNull();
    expect(peek.querySelector('[data-testid="brief-launch"]')).toBeNull();
    expect(q("brief-peek-origin")!.textContent).toContain("Indigo · sessions");
    expect(q("brief-peek-resume")!.textContent).toBe("Resume in Claude");
    expect(q("brief-peek-copy")!.textContent).toBe("Copy prompt");
    q("brief-peek-resume")!.click();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenCalledWith("claude", expect.stringContaining('my session "Daily brief design"'));
  });
});

describe("Needs you (8, 11, 16, 17)", () => {
  it("shows five rows and a '+N more' row whose peek lists the rest", async () => {
    // Calls only (no priorities, no incident), so every row is a call.
    render(base({ decisions: Array.from({ length: 7 }, (_, i) => decision(i + 1)), priorities: undefined, risks: [] }));
    expect(qa("brief-need")).toHaveLength(5);
    const more = q("brief-need-more")!;
    expect(more.textContent!.trim()).toBe("+2 more");
    await hover(more);
    expect(q("brief-peek")!.textContent).toContain("Decision number 6");
    expect(q("brief-peek")!.textContent).toContain("Decision number 7");
  });

  it("rows carry a company logo and the product name, not a repo slug", () => {
    // Three calls: the one-thing card stays off, so Needs you keeps a two-row slot and shows its origin chips.
    render(base({ decisions: [decision(1, { origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-finance" } }), decision(2), decision(3)] }));
    const chip = q("brief-need")!.querySelector('[data-testid="brief-origin"]')!;
    expect(chip.querySelector('[data-testid="brief-logo"]')).not.toBeNull();
    expect(chip.querySelector('[data-testid="brief-origin-label"]')!.textContent).toBe("Finance dashboard");
  });

  it("maps repos to products, falls back to the repo short name and a monogram", () => {
    expect(productName("indigoai-us/hq-desktop-app")).toBe("Desktop app");
    expect(productName("hq-core-staging")).toBe("HQ core");
    expect(productName("indigoai-us/hq-pro-agents")).toBe("Fleet");
    // The same names the writer's PRODUCT_NAMES table uses, so sweep rollups and writer rows merge by product.
    expect(productName("hq-cli")).toBe("HQ command line");
    expect(productName("hq-shepherd")).toBe("HQ Shepherd");
    expect(productName("hq-fleet-runtime")).toBe("Fleet");
    expect(productName("hq-native-mobile")).toBe("HQ Mobile");
    expect(productName("indigoai-us/something-new")).toBe("something-new");
    expect(productName("hq-cloud", "Sync")).toBe("Sync");
    expect(repoShort("indigoai-us/hq-finance")).toBe("hq-finance");
    expect(monogram("Indigo")).toBe("IN");
    expect(monogram("Live Recover")).toBe("LR");
    // A raw company uid (no company list from the host) reads as the company, not "CI" for "cmp_…".
    expect(monogram("cmp_indigo")).toBe("IN");
    expect(monogram("cmp_liverecover")).toBe("LI");
    expect(monogram("cmp_live_recover")).toBe("LR");
    expect(companyDisplayName("cmp_live_recover")).toBe("live recover");
    expect(monogramHue("cmp_indigo")).toBe(monogramHue("Indigo"));
    expect(monogramHue("cmp_indigo")).not.toBe(monogramHue("cmp_liverecover"));
  });

  it("titles read like a to-do: PR reference and conventional prefix stripped, sentence-cased", () => {
    expect(humanTitle("hq-packages #76: feat(pack): add hq-pack-imessage")).toEqual({ text: "Add hq-pack-imessage", ref: "hq-packages #76" });
    expect(humanTitle("fix: retry the gate")).toEqual({ text: "Retry the gate", ref: null });
    expect(humanTitle("Geoff's handoff to you stopped partway")).toEqual({ text: "Geoff's handoff to you stopped partway", ref: null });
    const items = parseBriefItems(JSON.stringify({ items: { decisions: [{ title: "hq-cli #12: chore(ci): bump node", repo: "hq-cli", product: "CLI", source: "prs" }] } }), "cmp_indigo")!;
    expect(items.decisions[0]!.title).toBe("Bump node");
    expect(items.decisions[0]!.detail!.source).toBe("hq-cli #12 · prs");
    expect(items.decisions[0]!.origin.product).toBe("CLI");
  });
});

describe("incident card (12) and grid rows (13)", () => {
  const incident = {
    title: "hq-core-staging: 'Recheck hq-core release gate' is red",
    why: "The release gate check failed on main.",
    source: "main_health",
    repo: "hq-core-staging",
    job: "verify-release",
    age_hours: 5,
    fixes: [{ repo: "hq-core-staging", number: 1239 }],
    prompt: "Look at the gate.",
  };

  it("eyebrow is '<product> main is red · live' (never the repo slug) with the company logo; the workflow is the title; the body has job, age and fixes", () => {
    const items = parseBriefItems(JSON.stringify({ items: { incidents: [incident] } }), "cmp_indigo")!;
    const risk = items.incidents[0]!;
    expect(risk.ci).toMatchObject({ repo: "hq-core-staging", workflow: "Recheck hq-core release gate", job: "verify-release", ageHours: 5 });
    expect(risk.links.map((l) => l.label)).toEqual(["hq-core-staging #1239"]);
    render(base({ risks: [risk] }));
    expect(q("brief-incident-eyebrow")!.textContent!.trim()).toBe("HQ core main is red · live");
    expect(q("brief-incident-eyebrow")!.textContent).not.toContain("hq-core-staging");
    expect(q("brief-incident-logo")!.querySelector('[data-testid="brief-logo"]')).not.toBeNull();
    expect(q("brief-incident-title")!.textContent).toBe("Recheck hq-core release gate");
    const facts = q("brief-incident-facts")!.textContent!;
    expect(facts).toContain("verify-release");
    // The red age is drawn as the "red for" track with its pill.
    expect(q("brief-incident-duration")!.getAttribute("aria-label")).toBe("Red for 5 hours");
    expect(q("brief-incident-duration-pill")!.textContent).toBe("5 HOURS");
  });

  it("the facts grid adds the changes merged on top of the red main when the writer counted them", () => {
    const items = parseBriefItems(JSON.stringify({ items: { incidents: [incident] } }), "cmp_indigo")!;
    const risk = { ...items.incidents[0]!, ci: { ...items.incidents[0]!.ci!, mergesOnTop: 3 } };
    render(base({ risks: [risk] }));
    expect(q("brief-incident-facts")!.textContent).toContain("3 changes merged on top");
  });

  it("red age reads from age_hours, a since time, or 'since Oct 9' in the note", () => {
    const ci = { repo: "r", workflow: "w", job: null, since: null, ageHours: null, note: null };
    expect(redAge({ ...ci, ageHours: 72 }, NOW.toISOString())).toBe("Red for 3 days");
    expect(redAge({ ...ci, since: new Date(NOW.getTime() - 2 * 3600_000).toISOString() }, NOW.toISOString())).toBe("Red for 2h");
    expect(redAge({ ...ci, note: "Failing since Oct 9." }, NOW.toISOString())).toBe("Red since Oct 9");
  });

  it("rows size to content from a 120px floor; one-row cards align top", () => {
    expect(gridStyle(["a a b b c d"], false)).toContain("minmax(120px, auto)");
    // Review mode sizes rows to content (the 120px floor sits on the cards, so a group label is a short row).
    expect(gridStyle([], true)).toContain("grid-auto-rows:auto");
    render(base());
    expect(target.querySelector<HTMLElement>("main.b-grid")!.getAttribute("style")).not.toContain("196px");
  });
});

describe("Yesterday card (14, 19)", () => {
  const m: BriefMeeting = {
    id: "m1",
    title: "HQ <> Sales Sync",
    startTime: NOW.toISOString(),
    companyUid: "cmp_indigo",
    decisions: 5,
    actions: 4,
    risks: 0,
    questions: 0,
    decided: ["Ship the trial page Friday", "Drop the old pricing", "Hire a closer", "Fourth decision"],
    todo: [
      { text: "Send the deck to Acme", owner: "Hassaan" },
      { text: "Write the pricing FAQ", owner: "Corey", mine: true },
    ],
  };

  it("says 'n decisions from m meetings' and each row shows its first decision", () => {
    // Two decided lines: under the Settled card's gate, so the Meetings card carries the decisions itself.
    render(base({ meetingsYesterday: [{ ...m, decided: ["Ship the trial page Friday"] }, { ...m, id: "m2", title: "Standup", decisions: 1, decided: ["Move standup"] }] }));
    expect(target.querySelector('[data-widget="decided"]')).toBeNull();
    expect(q("brief-meetings-sub")!.textContent).toBe("decisions from 2 meetings");
    expect(qa("brief-meeting-first").map((e) => e.textContent)).toEqual(["Ship the trial page Friday", "Move standup"]);
  });

  it("with the Settled card on the page the decisions live there, under their meeting, and Meetings keeps to counts", () => {
    render(base({ meetingsYesterday: [{ ...m, decided: ["Ship the trial page Friday", "Drop the old pricing"] }, { ...m, id: "m2", title: "Standup", decisions: 1, decided: ["Move standup"] }] }));
    expect(target.querySelector('[data-widget="decided"]')).not.toBeNull();
    expect(q("brief-meetings-sub")!.textContent).toBe("meetings since yesterday");
    expect(qa("brief-meeting-first")).toEqual([]);
    expect(qa("brief-meeting-decided").map((e) => e.textContent)).toEqual(["5 decided", "1 decided"]);
    const groups = qa("brief-decided-group");
    expect(groups.map((g) => g.querySelector('[data-testid="brief-decided-src-text"]')!.textContent!.split(" · ")[0])).toEqual(["HQ <> Sales Sync", "Standup"]);
    expect([...groups[0]!.querySelectorAll('[data-testid="brief-decided-line"]')].map((e) => e.textContent)).toEqual(["Ship the trial page Friday", "Drop the old pricing"]);
    expect(groups[1]!.querySelector('[data-testid="brief-decided-line"]')!.textContent).toBe("Move standup");
  });

  it("the peek shows Decided and To do (yours first, tagged, with Start and Copy) and +N more only when there is more", async () => {
    const p = meetingPeek(m);
    expect(p.sections.map((s) => s.label)).toEqual(["Decided", "To do"]);
    expect(p.sections[0]!.lines).toHaveLength(3);
    expect(p.sections[1]!.lines![0]).toMatchObject({ label: "Write the pricing FAQ", tag: "you", prompt: { text: todoPrompt("HQ <> Sales Sync", "Write the pricing FAQ") } });
    expect(p.status).toBe("+4 more in Meetings");
    expect(meetingPeek({ ...m, decisions: 1, actions: 1, decided: ["x"], todo: [{ text: "y" }] }).status).toBeUndefined();
    render(base({ meetingsYesterday: [m] }));
    await hover(q("brief-meeting-row")!);
    expect(q("brief-peek-tag")!.textContent).toBe("you");
    expect(qa("brief-peek-line-launch")).toHaveLength(1);
    expect(q("brief-peek-line-launch")!.textContent).toContain("Start in Claude");
    expect(q("brief-peek-line-launch")!.textContent).toContain("Copy prompt");
  });

  it("brief.json meeting items fill decided and to-do lines", () => {
    const items = parseBriefItems(JSON.stringify({ items: { meetings: [{ title: "HQ <> Sales Sync", decided: ["A"], todo: [{ text: "B", owner: "Corey", mine: true }, "C"] }] } }), null)!;
    expect(items.meetings[0]).toEqual({
      id: "brief-meeting-0",
      title: "HQ <> Sales Sync",
      startTime: "",
      companyUid: null,
      decisions: 1,
      actions: 2,
      risks: 0,
      questions: 0,
      decided: ["A"],
      todo: [{ text: "B", owner: "Corey", mine: true }, { text: "C" }],
    });
  });
});

describe("Today's priorities (18), folded into the main card", () => {
  it("renders the writer's priorities, at most five, each with its because, as the main card's first rows", () => {
    const text = JSON.stringify({
      priorities: Array.from({ length: 6 }, (_, i) => ({ n: i + 1, text: `Priority ${i + 1}`, because: `because ${i + 1}`, item_id: i === 0 ? "d1" : null })),
      items: {},
    });
    const items = parseBriefItems(text, "cmp_indigo")!;
    expect(items.priorities).toHaveLength(5);
    expect(items.priorities[0]).toEqual({ n: 1, text: "Priority 1", because: "because 1", itemId: "d1" });
    render(base({ priorities: items.priorities, decisions: [decision(1)] }));
    const card = q("brief-needs")!;
    // The card's own top line is hidden under the corner label; the list carries the name.
    expect(q("brief-priorities")!.getAttribute("aria-label")).toBe("Today's priorities");
    expect(card.textContent).toContain("Today's priorities");
    const rows = [...card.querySelectorAll<HTMLElement>("[data-priority]")];
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.getAttribute("data-priority"))).toEqual(["1", "2", "3", "4", "5"]);
    // Priority 1 opens d1, so it is that call's row, titled in the writer's words with its because.
    expect(rows[0]!.getAttribute("data-testid")).toBe("brief-need");
    expect(rows[0]!.textContent).toContain("Priority 1");
    expect(rows[0]!.textContent).toContain("because 1");
    // The others open no item: plain rows with their because.
    expect(rows[1]!.getAttribute("data-testid")).toBe("brief-need-priority");
    expect(rows[1]!.textContent).toContain("because 2");
    // There is no separate priorities strip any more.
    expect(target.querySelector("section.prio")).toBeNull();
  });

  it("older briefs derive priorities from the top three decisions, then the live incident by product, never by repo slug", () => {
    const red = (repo: string | null, workflow: string | null) => ({
      id: `ci:${repo ?? "unknown"}`,
      title: `${repo ?? "unknown"} main CI red`,
      summary: "red",
      severity: "incident" as const,
      links: [],
      origin: { companyUid: null, repo: null },
      ci: { repo: repo ?? "", workflow, job: null, since: null, ageHours: null, note: null },
    });
    const input = base({
      priorities: undefined,
      decisions: [decision(1), decision(2), decision(3), decision(4)],
      risks: [red("hq-core-staging", "Nightly sync")],
    });
    expect(briefPriorities(input).map((p) => [p.text, p.itemId])).toEqual([
      ["Decision number 1", "d1"],
      ["Decision number 2", "d2"],
      ["Decision number 3", "d3"],
      ["Fix HQ core's red Nightly sync check", "ci:hq-core-staging"],
    ]);
    expect(briefPriorities(base({ priorities: undefined, decisions: [], risks: [red(null, "Gate")] }))[0]!.text).toBe("Fix the red Gate check");
    expect(briefPriorities(base({ priorities: undefined, decisions: [], risks: [red("hq-cloud", null)] }))[0]!.text).toBe("Fix HQ Cloud main");
    for (const p of briefPriorities(input)) expect(p.text).not.toMatch(/hq-core-staging|[\w-]+\/[\w-]+/);
  });

  it("a scored priority's peek says the score in words; an unscored one does not", async () => {
    const d1 = decision(1, { ageHours: 44, peopleWaiting: 3, revenue: true });
    const priorities = [
      { n: 1, text: "Close out the SAFE allotment", because: "Investors wait on it", itemId: "d1", score: 7 },
      { n: 2, text: "Decision number 2", because: null, itemId: "d2" },
    ];
    render(base({ priorities, decisions: [d1, decision(2)] }));
    const rows = [...target.querySelectorAll<HTMLElement>("[data-priority]")];
    // The row carries its company logo (the call's origin chip).
    expect(rows[0]!.querySelector('[data-testid="brief-origin"] [data-testid="brief-logo"]')).not.toBeNull();
    await hover(rows[0]!);
    expect(q("brief-peek")!.textContent).toContain("unblocks 3 people and revenue · 44h old");
    await hover(rows[1]!);
    expect(q("brief-peek")!.textContent).not.toContain("unblocks");
    expect(q("brief-peek")!.textContent).not.toContain("score");
  });

  it("hovering a priority opens its item's peek, and a cleared item is struck through", async () => {
    const onlaunch = vi.fn(async () => null);
    render(base({ priorities: undefined, decisions: [decision(1)] }), { onlaunch });
    const row = target.querySelector<HTMLElement>('[data-priority="1"]')!;
    await hover(row);
    expect(q("brief-peek")!.textContent).toContain("Decision number 1");
    (q("brief-need")!.querySelector('[data-testid="brief-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(row.classList.contains("done")).toBe(true);
  });
});
