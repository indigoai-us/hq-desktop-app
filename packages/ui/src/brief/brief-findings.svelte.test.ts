// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { findingField, findingRows, findingState, parseFindings, parseSamples, pendingFindingRows, sampleCompany, sampleKindLabel, sampleTone } from "./brief-findings.js";
import { parseBriefStatus } from "./brief-runs.js";
import BriefFindings from "./BriefFindings.svelte";

const raw = {
  signals: { decision: 7, action_item: 12, risk: 3, commitment: 0, key_point: 19 },
  sessions: 42,
  meetings: 6,
  dms: { total: 31, need_you: 4 },
  prs: { merged: 34, open: 9, review_requested: 2 },
  ci_red: 1,
  agents: { total: 44, attention: 3 },
  integrations: { gmail: 5, linear: 0 },
};

describe("findings", () => {
  it("parses every count and drops zero or junk values", () => {
    const f = parseFindings({ ...raw, sessions: "lots", meetings: -2 })!;
    expect(f.signals).toEqual({ decision: 7, action_item: 12, risk: 3, commitment: 0, key_point: 19 });
    expect(f.sessions).toBe(0);
    expect(f.meetings).toBe(0);
    expect(f.integrations).toEqual({ gmail: 5 });
    expect(parseFindings(null)).toBeNull();
    expect(parseFindings([1, 2])).toBeNull();
  });

  const FIXED = ["decision", "action_item", "risk", "commitment", "key_point", "meetings", "sessions", "dms", "prs", "prs_open", "ci_red", "agents"];

  it("orders counters by meaning, with tones and sub-counts, in one fixed set", () => {
    const rows = findingRows(parseFindings(raw)!);
    expect(rows.map((r) => r.key)).toEqual([...FIXED, "int:gmail"]);
    expect(rows.find((r) => r.key === "commitment")!.value).toBe(0);
    expect(rows.find((r) => r.key === "decision")!.tone).toBe("decision");
    expect(rows.find((r) => r.key === "risk")!.tone).toBe("red");
    expect(rows.find((r) => r.key === "dms")!.sub).toEqual({ value: 4, label: "need you" });
  });

  it("keeps every tile in the same place as counts arrive; unreported ones have no value yet", () => {
    const early = findingRows(parseFindings({ signals: { risk: 2 }, sessions: 9 })!);
    const late = findingRows(parseFindings(raw)!);
    expect(early.map((r) => r.key)).toEqual(FIXED);
    expect(late.slice(0, FIXED.length).map((r) => r.key)).toEqual(FIXED);
    expect(early.find((r) => r.key === "risk")!.value).toBe(2);
    expect(early.find((r) => r.key === "decision")!.value).toBeNull();
    expect(early.find((r) => r.key === "agents")!.label).toBe("Agents");
  });

  it("status.json carries findings, raw samples and the run's company", () => {
    const s = parseBriefStatus(JSON.stringify({ run_id: "brief-20261009-090122", state: "running", findings: raw, samples: [{ title: "x" }], company: "indigo" }))!;
    expect(s.findings?.sessions).toBe(42);
    expect(s.company).toBe("indigo");
    expect(Array.isArray(s.samples)).toBe(true);
    expect(parseBriefStatus(JSON.stringify({ run_id: "brief-20261009-090122", state: "running" }))!.findings).toBeNull();
  });
});

describe("samples", () => {
  const list = [
    { kind: "decision", title: "Keep the no-self-merge rule?", company: "indigo", at: "1" },
    { kind: "decision", title: "LiveRecover: dunning copy", company: "liverecover", at: "2" },
    { kind: "risk", title: "No company on this one", at: "3" },
    { kind: "dm", title: "Izzy   is waiting\non your reply", company: "Indigo", at: "4" },
    { kind: "pr", title: "x".repeat(120), company: "indigo", at: "5" },
  ];

  it("keeps only the run's own company: other companies and unlabeled samples are dropped", () => {
    const out = parseSamples(list, "indigo");
    expect(out.map((s) => s.at)).toEqual(["1", "4", "5"]);
    expect(out.some((s) => s.company.toLowerCase() === "liverecover")).toBe(false);
    expect(out[1]!.title).toBe("Izzy is waiting on your reply");
    expect(out[2]!.title.length).toBeLessThanOrEqual(90);
  });

  it("shows nothing when the run's company is unknown, and caps at eight", () => {
    expect(parseSamples(list, null)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: "pr", title: `t${i}`, company: "indigo", at: `${i}` }));
    expect(parseSamples(many, "indigo").map((s) => s.title)).toEqual(["t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"]);
    expect(parseSamples("nope", "indigo")).toEqual([]);
  });

  it("tints sample kinds by meaning", () => {
    expect(sampleTone("decision")).toBe("decision");
    expect(sampleTone("ci")).toBe("red");
    expect(sampleTone("action_item")).toBe("ok");
  });
});

describe("BriefFindings counters", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });
  const values = () =>
    Object.fromEntries(
      [...target.querySelectorAll<HTMLElement>('[data-testid="brief-finding"]')].map((r) => [r.dataset.key, r.querySelector('[data-testid="brief-finding-value"]')!.textContent]),
    );

  it("reduced motion: counters show their values at once and cards appear", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefFindings, {
      target,
      props: { findings: parseFindings(raw)!, samples: parseSamples([{ kind: "decision", title: "Keep the rule?", company: "indigo", at: "1" }], "indigo"), reducedMotion: true },
    });
    flushSync();
    await tick();
    expect(values()).toMatchObject({ decision: "7", sessions: "42", prs: "34" });
    expect(target.querySelectorAll('[data-testid="brief-sample"]')).toHaveLength(1);
  });

  it("renders a fixed 3-column grid; a tile with no value yet shows a dash and its full label", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefFindings, { target, props: { findings: parseFindings({ agents: { total: 48, attention: 17 } })!, reducedMotion: true } });
    flushSync();
    await tick();
    const tiles = target.querySelectorAll('[data-testid="brief-finding"]');
    expect(tiles).toHaveLength(12);
    expect(values()).toMatchObject({ decision: "—", risk: "—", agents: "48" });
    const agents = target.querySelector('[data-key="agents"]')!;
    expect(agents.querySelector(".name")!.textContent).toBe("Agents");
    expect(agents.textContent).toContain("17 need attention");
  });

  it("sample cards drop the PR's conventional-commit prefix", async () => {
    const out = parseSamples([{ kind: "pr", title: "hq-packages #76: feat(pack): add hq-pack-imessage for local iMessage read/send", company: "indigo", at: "1" }], "indigo");
    expect(out[0]!.title).toBe("Add hq-pack-imessage for local iMessage read/send");
  });

  it("with motion, a counter ticks up from where it was toward the new value", async () => {
    let now = 100;
    target = document.createElement("div");
    document.body.appendChild(target);
    const props = $state({ findings: parseFindings({ sessions: 10 })!, reducedMotion: false, clock: () => now });
    app = mount(BriefFindings, { target, props });
    flushSync();
    now = 101.2;
    props.findings = parseFindings({ sessions: 10 })!;
    flushSync();
    await tick();
    // A fresh object with the same value re-reads the clock: settled at 10.
    expect(values().sessions).toBe("10");
    props.findings = parseFindings({ sessions: 42 })!;
    flushSync();
    expect(values().sessions).toBe("10");
    now = 101.8;
    props.findings = parseFindings({ sessions: 42 })!;
    flushSync();
    const mid = Number(values().sessions);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(42);
  });
});

describe("tiles fill in as the brief assembles", () => {
  const FIXED = ["decision", "action_item", "risk", "commitment", "key_point", "meetings", "sessions", "dms", "prs", "prs_open", "ci_red", "agents"];

  it("before any report, every fixed tile is there with no value", () => {
    const rows = pendingFindingRows();
    expect(rows.map((r) => r.key)).toEqual(FIXED);
    expect(rows.every((r) => r.value === null && findingState(r) === "pending")).toBe(true);
  });

  it("a tile is pending, zero, or found; only a found count wears a colour field, by meaning", () => {
    const rows = findingRows(parseFindings({ ...raw, signals: { ...raw.signals, commitment: 0 } })!);
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(findingState(by("commitment"))).toBe("zero");
    expect(findingField(by("commitment"))).toBe("mono");
    expect(findingField(by("decision"))).toBe("violet");
    expect(findingField(by("action_item"))).toBe("teal");
    expect(findingField(by("prs"))).toBe("teal");
    expect(findingField(by("risk"))).toBe("pink");
    expect(findingField(by("ci_red"))).toBe("pink");
    expect(findingField(by("dms"))).toBe("sky");
    // Background counts stay monochrome even with something in them.
    expect(findingState(by("sessions"))).toBe("found");
    expect(findingField(by("sessions"))).toBe("mono");
    expect(findingField({ key: "decision", tone: "decision", value: null })).toBe("mono");
  });

  it("a sample names its company with the page's label and icon, matched by slug, uid or label", () => {
    const companies = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo", iconUrl: "https://x/i.png" }];
    expect(sampleCompany("indigo", companies)).toEqual({ name: "Indigo", uid: "cmp_indigo", iconUrl: "https://x/i.png" });
    expect(sampleCompany("CMP_INDIGO", companies).name).toBe("Indigo");
    expect(sampleCompany("live_recover", []).name).toBe("Live recover");
    expect(sampleKindLabel("action_item")).toBe("action item");
  });
});

describe("BriefFindings bento", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });
  const tiles = () => [...target.querySelectorAll<HTMLElement>('[data-testid="brief-finding"]')];

  it("with no findings yet, shows all twelve tiles waiting with a dash", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefFindings, { target, props: { findings: null, reducedMotion: true } });
    flushSync();
    await tick();
    expect(tiles()).toHaveLength(12);
    expect(tiles().every((t) => t.dataset.state === "pending" && t.querySelector('[data-testid="brief-finding-value"]')!.textContent === "—")).toBe(true);
    expect(target.querySelectorAll('[data-testid="brief-sample"]')).toHaveLength(0);
  });

  it("a found count fills with its colour field; an empty one stays monochrome; tiles keep their order", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    const props = $state({ findings: parseFindings({ signals: { decision: 7 } }) as ReturnType<typeof parseFindings>, reducedMotion: true });
    app = mount(BriefFindings, { target, props });
    flushSync();
    const before = tiles().map((t) => t.dataset.key);
    const decision = () => target.querySelector<HTMLElement>('[data-key="decision"]')!;
    expect(decision().dataset.state).toBe("found");
    expect(decision().dataset.field).toBe("violet");
    expect(decision().querySelector('.fill[data-field="violet"]')).not.toBeNull();
    expect(target.querySelector<HTMLElement>('[data-key="risk"]')!.dataset.state).toBe("pending");
    props.findings = parseFindings({ signals: { decision: 7, risk: 0 } });
    flushSync();
    const risk = target.querySelector<HTMLElement>('[data-key="risk"]')!;
    expect(risk.dataset.state).toBe("zero");
    expect(risk.dataset.field).toBe("mono");
    expect(tiles().map((t) => t.dataset.key)).toEqual(before);
  });

  it("sample chips name their company through CompanyLabel, with the page's label", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    const samples = parseSamples([{ kind: "action_item", title: "Send Jacob the memo folder", company: "indigo", at: "1" }], "indigo");
    app = mount(BriefFindings, {
      target,
      props: { findings: parseFindings(raw)!, samples, companies: [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo" }], reducedMotion: true },
    });
    flushSync();
    await tick();
    const card = target.querySelector<HTMLElement>('[data-testid="brief-sample"]')!;
    expect(card.querySelector('[data-testid="company-label"]')?.textContent).toContain("Indigo");
    expect(card.textContent).toContain("action item");
    expect(card.textContent).toContain("Send Jacob the memo folder");
  });

  it("connected apps keep their counter, in the samples card header", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefFindings, { target, props: { findings: parseFindings(raw)!, reducedMotion: true } });
    flushSync();
    const gmail = target.querySelector<HTMLElement>('[data-key="int:gmail"]')!;
    expect(gmail.querySelector('[data-testid="brief-finding-value"]')!.textContent).toBe("5");
    expect(tiles()).toHaveLength(13);
  });

  it("is drawn in the page style: no backdrop-filter, no inset shadows, no dashed borders, motion off for reduced motion", () => {
    const css = readFileSync(resolve(process.cwd(), "src/brief/BriefFindings.svelte"), "utf8");
    const style = css.slice(css.indexOf("<style"));
    expect(style).not.toMatch(/backdrop-filter/);
    expect(style).not.toMatch(/inset 0 0 0/);
    expect(style).not.toMatch(/dashed/);
    expect(style).toMatch(/prefers-reduced-motion: reduce/);
    // Labels are the brief's mono caps.
    expect(/\.name \{([^}]*)\}/.exec(style)![1]).toMatch(/text-transform: uppercase/);
  });
});
