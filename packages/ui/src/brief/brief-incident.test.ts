// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./BriefHealthHarness.test-support.svelte";
import {
  affectedOf,
  durationLabel,
  durationTrack,
  incidentEyebrow,
  incidentHoursOf,
  incidentShortState,
  mergesOnTopText,
  moreIncidentsPeek,
  redHoursOf,
  riskPeek,
  shortHours,
  watchTitle,
  workflowsRed,
} from "./brief-peeks.js";
import type { BriefOrigin, BriefRisk } from "./brief-types.js";

const NOW = "2026-10-11T14:54:00.000Z";
const INDIGO = "cmp_indigo";
const COMPANIES = [{ uid: INDIGO, slug: "indigo", label: "Indigo", iconUrl: null }];
const origin = (repo: string, product?: string): BriefOrigin => ({ companyUid: INDIGO, repo, ...(product ? { product } : {}) });
const SLUG = /\b[\w.-]+\/[\w.-]+\b/;

/** The real Oct 11 incidents: HQ Cloud's nightly sync red for two days, five fleet agents stuck in setup. */
const SYNC: BriefRisk = {
  id: "p1",
  title: "HQ Cloud nightly sync is red",
  summary: "The nightly sync workflow has failed for two days.",
  severity: "incident",
  links: [{ label: "hq-cloud #88", origin: origin("indigoai-us/hq-cloud") }],
  origin: origin("indigoai-us/hq-cloud"),
  ci: { repo: "hq-cloud", workflow: "nightly sync", job: "vault-step", since: null, ageHours: 48, note: null, mergesOnTop: 3 },
};
const FLEET: BriefRisk = {
  id: "p2",
  title: "Unstick five fleet agents in setup",
  summary: "Five agents have sat in setup for three days.",
  severity: "incident",
  measure: { healthy: 90, total: 95, unit: "agents", cause: "setup phase" },
  links: [],
  origin: origin("indigoai-us/hq-pro-agents", "Fleet"),
};
const GATE: BriefRisk = {
  id: "ci:hq-core-staging",
  title: "hq-core-staging: 'Recheck hq-core release gate' is red",
  summary: "The release gate check failed on main.",
  severity: "incident",
  links: [{ label: "hq-core-staging #1239", origin: origin("indigoai-us/hq-core-staging") }],
  origin: origin("hq-core-staging"),
  ci: { repo: "hq-core-staging", workflow: "Recheck hq-core release gate", job: "verify-release", since: null, ageHours: 5, note: null },
};

describe("incident wording", () => {
  it("the eyebrow names the product, never the repo slug", () => {
    expect(incidentEyebrow(SYNC)).toBe("HQ Cloud main is red");
    expect(incidentEyebrow(GATE)).toBe("HQ core main is red");
    expect(incidentEyebrow(FLEET)).toBe("Fleet incident");
    expect(incidentEyebrow({ ...FLEET, measure: undefined, title: "indigoai-us/hq-cloud #12: fix(sync): vault step times out" })).toBe("Vault step times out");
    expect(incidentEyebrow({ ...SYNC, origin: { companyUid: null, repo: null }, ci: { ...SYNC.ci!, repo: "" } })).toBe("Main is red");
    for (const r of [SYNC, GATE, FLEET]) expect(incidentEyebrow(r)).not.toMatch(SLUG);
  });

  it("secondary rows read as a plain title with a short state", () => {
    expect(watchTitle(SYNC)).toBe("HQ Cloud main is red");
    expect(watchTitle(FLEET)).toBe("Unstick five fleet agents in setup");
    expect(incidentShortState(SYNC, NOW)).toBe("2d red");
    expect(incidentShortState(GATE, NOW)).toBe("5h red");
    expect(incidentShortState(FLEET, NOW)).toBe("5 agents stuck");
    expect(incidentShortState({ ...FLEET, measure: undefined }, NOW)).toBe("");
  });

  it("red hours come from age_hours, else a since time; the short age rounds like the rest of the brief", () => {
    expect(redHoursOf(SYNC, NOW)).toBe(48);
    expect(redHoursOf({ ...SYNC, ci: { ...SYNC.ci!, ageHours: null, since: "2026-10-11T12:54:00.000Z" } }, NOW)).toBe(2);
    expect(redHoursOf({ ...SYNC, ci: { ...SYNC.ci!, ageHours: null, since: null } }, NOW)).toBeNull();
    expect(redHoursOf(FLEET, NOW)).toBeNull();
    expect(shortHours(0.5)).toBe("<1h");
    expect(shortHours(47)).toBe("47h");
    expect(shortHours(48)).toBe("2d");
    expect(shortHours(null)).toBeNull();
  });

  it("counts the affected set and the changes merged on top", () => {
    expect(affectedOf(FLEET)).toBe(5);
    expect(affectedOf(SYNC)).toBeNull();
    expect(mergesOnTopText(SYNC)).toBe("3 changes merged on top");
    expect(mergesOnTopText({ ...SYNC, ci: { ...SYNC.ci!, mergesOnTop: 1 } })).toBe("1 change merged on top");
    expect(mergesOnTopText({ ...SYNC, ci: { ...SYNC.ci!, mergesOnTop: 0 } })).toBeNull();
    expect(mergesOnTopText(GATE)).toBeNull();
  });

  it("the peek carries the company chip, a plain title, the counted facts, fixes and the prompt", () => {
    const p = riskPeek(SYNC, "Look at the sync.", NOW);
    expect(p.eyebrow).toBe("Incident · live");
    expect(p.origin).toEqual({ companyUid: INDIGO, label: "HQ Cloud" });
    // A red main is titled by its workflow; the chip names the product.
    expect(p.title).toBe("nightly sync");
    expect(riskPeek({ ...SYNC, ci: { ...SYNC.ci!, workflow: null } }, undefined, NOW).title).toBe("HQ Cloud main is red");
    expect(p.status).toBe(SYNC.summary);
    const live = p.sections.find((s) => s.label === "Live")!;
    expect(live.lines!.map((l) => [l.label, l.state])).toEqual([
      ["Red for 2 days", "SINCE"],
      ["vault-step", "JOB"],
      ["3 changes merged on top", "ON TOP"],
    ]);
    // A bare reference becomes the product's fix; a PR-ish title loses its slug, number and prefix.
    expect(p.sections.find((s) => s.label === "Fixes in review")!.lines![0]).toMatchObject({ label: "HQ Cloud fix", state: "HQ CLOUD" });
    const titled = riskPeek({ ...SYNC, links: [{ label: "hq-cloud #913: fix(sync): retry the nightly vault step", origin: origin("indigoai-us/hq-cloud") }] }, undefined, NOW);
    expect(titled.sections.find((s) => s.label === "Fixes in review")!.lines![0]!.label).toBe("Retry the nightly vault step");
    for (const l of titled.sections.flatMap((s) => s.lines ?? [])) expect(l.label).not.toMatch(SLUG);
    expect(p.prompt).toEqual({ id: "p1", text: "Look at the sync." });
    const f = riskPeek(FLEET, undefined, NOW);
    expect(f.origin).toEqual({ companyUid: INDIGO, label: "Fleet" });
    expect(f.sections[0]!.lines![0]).toMatchObject({ label: "5 of 95 agents setup phase", state: "MEASURED", tone: "red" });
    expect(f.prompt).toBeUndefined();
    expect(riskPeek({ ...FLEET, severity: "watch" }, undefined).eyebrow).toBe("Watch");
  });

  it("an incident's duration: a red main's age, else the span the writer gave a measured one; never invented", () => {
    expect(incidentHoursOf(SYNC, NOW)).toBe(48);
    expect(incidentHoursOf(GATE, NOW)).toBe(5);
    expect(incidentHoursOf(FLEET, NOW)).toBe(72);
    expect(incidentHoursOf({ ...FLEET, summary: "Twelve agents have been stuck for the past 2 weeks." }, NOW)).toBe(336);
    expect(incidentHoursOf({ ...FLEET, summary: "One agent has looped for an hour." }, NOW)).toBe(1);
    // No span in the summary: the title is read next, then nothing.
    expect(incidentHoursOf({ ...FLEET, summary: "Five agents keep failing setup.", title: "Agents stuck for 4 days" }, NOW)).toBe(96);
    expect(incidentHoursOf({ ...FLEET, summary: "Five agents keep failing setup." }, NOW)).toBeNull();
    expect(incidentHoursOf({ ...SYNC, ci: { ...SYNC.ci!, ageHours: null, since: null } }, NOW)).toBeNull();
    expect(durationLabel(0.4)).toBe("UNDER 1 HOUR");
    expect(durationLabel(1)).toBe("1 HOUR");
    expect(durationLabel(5)).toBe("5 HOURS");
    expect(durationLabel(30)).toBe("30 HOURS");
    expect(durationLabel(72)).toBe("3 DAYS");
  });

  it("the duration track: past a day, this week's seven days with today last; under a day, the last 24 hours", () => {
    const week = durationTrack(72, NOW)!;
    expect(week.scale).toBe("days");
    expect(week.label).toBe("3 DAYS");
    expect(week.ticks).toHaveLength(7);
    // Initials of the seven local calendar days ending today, today marked.
    const letters = Array.from({ length: 7 }, (_, i) => "SMTWTFS"[new Date(Date.parse(NOW) - (6 - i) * 86_400_000).getDay()]);
    expect(week.ticks.map((t) => t.label)).toEqual(letters);
    expect(week.ticks.map((t) => t.now)).toEqual([false, false, false, false, false, false, true]);
    // The stretch ends at now inside today's cell and spans three of the seven days.
    expect(week.to).toBeGreaterThan(6 / 7);
    expect(week.to).toBeLessThanOrEqual(1);
    expect((week.to - week.from) * 7).toBeCloseTo(3, 1);
    expect(week.clipped).toBe(false);
    const old = durationTrack(14 * 24, NOW)!;
    expect(old.from).toBe(0);
    expect(old.clipped).toBe(true);
    expect(old.label).toBe("14 DAYS");
    const day = durationTrack(6, NOW)!;
    expect(day.scale).toBe("hours");
    expect(day.from).toBeCloseTo(0.75);
    expect(day.to).toBe(1);
    expect(day.ticks.map((t) => t.label)).toEqual(["24H AGO", "12H", "NOW"]);
    expect(durationTrack(null, NOW)).toBeNull();
    expect(durationTrack(5, "not a time")).toBeNull();
  });

  it("the +N more peek lists the remaining incidents with their state", () => {
    const p = moreIncidentsPeek([SYNC, FLEET], NOW);
    expect(p.title).toBe("2 more live");
    expect(p.sections[0]!.lines!.map((l) => `${l.label} ${l.state}`)).toEqual(["HQ Cloud main is red 2D RED", "Unstick five fleet agents in setup 5 AGENTS STUCK"]);
  });
});

describe("Incident card", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(risks: BriefRisk[], props: Record<string, unknown> = {}) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Harness, { target, props: { card: "incident", risks, now: NOW, companies: COMPANIES, ...props } });
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

  it("a red main: product eyebrow with the company logo, the workflow as title, job, red age and merges on top as facts", () => {
    render([SYNC], { rows: 1 });
    expect(q("brief-incident-eyebrow")!.textContent!.trim()).toBe("HQ Cloud main is red · live");
    expect(q("brief-incident-logo")!.querySelector('[data-testid="brief-logo"]')).not.toBeNull();
    expect(q("brief-incident-title")!.textContent).toBe("nightly sync");
    const facts = q("brief-incident-facts")!.textContent!;
    expect(facts).toContain("vault-step");
    expect(facts).toContain("3 changes merged on top");
    expect(facts).toContain("1 in review");
    // The red age is drawn as the "red for" track with its pill, not repeated as a fact.
    const dur = q("brief-incident-duration")!;
    expect(dur.getAttribute("aria-label")).toBe("Red for 2 days");
    expect(q("brief-incident-duration-pill")!.textContent).toBe("2 DAYS");
    expect(facts).not.toContain("Since");
    // One-row: the whole face is free of repo slugs.
    expect(q("brief-incident")!.textContent).not.toMatch(SLUG);
    expect(q("brief-incident-also")).toBeNull();
    expect(q("brief-incident-dots")).toBeNull();
  });

  it("tall: fix chips are plain titles with the product, never a slug or PR number, capped at five with a +N more peek", async () => {
    const links = [
      { label: "hq-cloud #913: fix(sync): retry the nightly vault step", origin: origin("indigoai-us/hq-cloud") },
      { label: "hq-cloud #914", origin: origin("indigoai-us/hq-cloud") },
      { label: "feat(sync): skip empty vaults", origin: origin("indigoai-us/hq-cloud") },
      { label: "Rotate the sync token", origin: origin("indigoai-us/hq-cloud") },
      { label: "hq-core-staging #1240: chore(ci): bump the gate timeout", origin: origin("indigoai-us/hq-core-staging") },
      { label: "hq-cloud #915: fix(sync): log the failing step", origin: origin("indigoai-us/hq-cloud") },
      { label: "#916", origin: { companyUid: INDIGO, repo: null } },
    ];
    render([{ ...SYNC, links }], { rows: 2 });
    const chips = qa("brief-incident-fix");
    expect(chips.map((c) => c.querySelector(".fix-t")!.textContent)).toEqual([
      "Retry the nightly vault step",
      "HQ Cloud fix",
      "Skip empty vaults",
      "Rotate the sync token",
      "Bump the gate timeout",
    ]);
    expect(chips.every((c) => c.querySelector('[data-testid="brief-logo"]'))).toBe(true);
    expect(q("brief-incident-fixes")!.textContent).not.toMatch(SLUG);
    expect(q("brief-incident-fixes")!.textContent).not.toMatch(/#\d+/);
    expect(q("brief-incident-fixes")!.textContent).not.toMatch(/\b(feat|fix|chore)\(/);
    const more = q("brief-incident-fixes-more")!;
    expect(more.textContent!.trim()).toBe("+2 more");
    await hover(more);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("2 more fixes in review");
    expect(peek.querySelectorAll('[data-testid="brief-peek-line"]')).toHaveLength(2);
    expect(peek.textContent).toContain("Log the failing step");
    expect(peek.textContent).toContain("A fix");
    expect(peek.textContent).not.toMatch(SLUG);
  });

  it("a measured incident leads with the affected count and how long it has been stuck, never the whole fleet", () => {
    render([FLEET], { rows: 2 });
    expect(q("brief-incident-eyebrow")!.textContent!.trim()).toBe("Fleet incident · live");
    expect(q("brief-incident-count")!.getAttribute("aria-label")).toBe("5 agents stuck");
    const cap = q("brief-incident-sub")!.textContent!;
    expect(cap).toContain("agents stuck");
    expect(cap).toContain("setup phase");
    // The three days the summary mentions get their own track and pill.
    expect(q("brief-incident-duration")!.getAttribute("aria-label")).toBe("Stuck for 3 days");
    expect(q("brief-incident-duration-pill")!.textContent).toBe("3 DAYS");
    expect(q("brief-incident-duration-pill")!.classList.contains("red")).toBe(true);
    const fill = q("brief-incident-duration-fill")!;
    expect(parseFloat(fill.style.width)).toBeCloseTo((3 / 7) * 100, 0);
    // Tall: the summary stays on the face.
    expect(q("brief-incident-summary")!.textContent).toBe(FLEET.summary);
    expect(q("brief-incident")!.textContent).not.toContain("95");
    // No per-unit markers or hover probe: they only repeated the count.
    expect(q("brief-incident-dots")).toBeNull();
    expect(q("brief-incident")!.textContent).not.toContain("HOVER ONE TO INSPECT");
  });

  it("one row: the track carries the duration and the summary moves to the card's peek; without a duration the summary stays", async () => {
    render([FLEET], { rows: 1 });
    expect(q("brief-incident-duration")).not.toBeNull();
    expect(q("brief-incident-summary")).toBeNull();
    await hover(q("brief-incident")!);
    expect(q("brief-peek")!.textContent).toContain(FLEET.summary);
    unmount(app!);
    target.remove();
    render([{ ...FLEET, summary: "Five agents keep failing setup." }], { rows: 1 });
    expect(q("brief-incident-duration")).toBeNull();
    expect(q("brief-incident-summary")!.textContent).toBe("Five agents keep failing setup.");
  });

  it("a red main whose age is only a date in the note keeps it as a 'Since' fact, with no track", () => {
    render([{ ...SYNC, ci: { ...SYNC.ci!, ageHours: null, since: null, note: "Failing since Oct 9." } }], { rows: 1 });
    expect(q("brief-incident-duration")).toBeNull();
    expect(q("brief-incident-facts")!.textContent).toContain("Red since Oct 9");
  });

  it("each other incident shows its state as an age pill, tinted by how long it has been red", () => {
    render([FLEET, SYNC, GATE], { rows: 1 });
    const rows = qa("brief-incident-other");
    const pill = (row: HTMLElement) => row.querySelector<HTMLElement>(".pill-age")!;
    expect(pill(rows[0]!).textContent).toBe("2d red");
    expect(pill(rows[0]!).classList.contains("warn")).toBe(true);
    expect(pill(rows[1]!).textContent).toBe("5h red");
    expect(pill(rows[1]!).classList.contains("warn") || pill(rows[1]!).classList.contains("red")).toBe(false);
  });

  it("other live incidents list under 'Also live' with their own peeks; the lead stays first", async () => {
    render([SYNC, FLEET], { rows: 1, prompts: { p2: "Unstick the agents." } });
    expect(q("brief-incident-eyebrow")!.textContent!.trim()).toBe("HQ Cloud main is red · live");
    const rows = qa("brief-incident-other");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Unstick five fleet agents in setup");
    expect(rows[0]!.textContent).toContain("5 agents stuck");
    expect(rows[0]!.querySelector('[data-testid="brief-logo"]')).not.toBeNull();
    await hover(rows[0]!);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("Unstick five fleet agents in setup");
    expect(peek.textContent).toContain("5 of 95 agents setup phase");
    expect(q("brief-peek-prompt")!.textContent).toBe("Unstick the agents.");
    expect(q("brief-peek-origin")!.textContent).toContain("Fleet");
  });

  it("caps the other incidents at four and folds the rest into a +N more row whose peek lists them", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...FLEET, id: `f${i}`, title: `Fleet incident ${i + 1}` }));
    render([SYNC, ...many], { rows: 2 });
    expect(qa("brief-incident-other")).toHaveLength(4);
    const more = q("brief-incident-more")!;
    expect(more.textContent!.trim()).toBe("+2 more");
    await hover(more);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("2 more live");
    expect(peek.querySelectorAll('[data-testid="brief-peek-line"]')).toHaveLength(2);
    expect(peek.textContent).toContain("Fleet incident 6");
  });

  it("the card's own peek opens on hover with the launch prompt", async () => {
    render([GATE], { rows: 2, prompts: { "ci:hq-core-staging": "Look at the gate." } });
    expect(q("brief-incident-eyebrow")!.textContent!.trim()).toBe("HQ core main is red · live");
    // Under a day the track is the last 24 hours.
    expect(q("brief-incident-duration")!.getAttribute("aria-label")).toBe("Red for 5 hours");
    // Tall: the fix chip and the launch pill render on the face.
    expect(q("brief-incident")!.querySelector('[data-testid="brief-launch"]')).not.toBeNull();
    await hover(q("brief-incident")!);
    expect(q("brief-peek")!.textContent).toContain("Recheck hq-core release gate");
    expect(q("brief-peek-origin")!.textContent).toContain("HQ core");
    expect(q("brief-peek")!.textContent).toContain("Red for 5h");
    expect(q("brief-peek-prompt")!.textContent).toBe("Look at the gate.");
  });

  it("a red main's 'N of M workflows red' note is drawn as M dots with N lit, not a sentence", () => {
    expect(workflowsRed("1 of 3 workflows red on main.")).toEqual({ red: 1, total: 3 });
    expect(workflowsRed("Failing since Oct 9.")).toBeNull();
    expect(workflowsRed(null)).toBeNull();
    render([{ ...SYNC, ci: { ...SYNC.ci!, note: "1 of 3 workflows red on main." } }], { rows: 1 });
    const wf = q("brief-incident-workflows")!;
    expect(wf.getAttribute("aria-label")).toBe("1 of 3 workflows red on main.");
    const dots = [...wf.querySelectorAll(".wf-dots i")];
    expect(dots).toHaveLength(3);
    expect(dots.filter((d) => d.classList.contains("on"))).toHaveLength(1);
    expect(target.querySelector(".lede")).toBeNull();
  });
});
