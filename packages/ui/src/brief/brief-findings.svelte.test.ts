// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { findingRows, parseFindings, parseSamples, sampleTone } from "./brief-findings.js";
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

  it("orders counters by meaning, with tones, sub-counts, and no zero rows", () => {
    const rows = findingRows(parseFindings(raw)!);
    expect(rows.map((r) => r.key)).toEqual(["decision", "action_item", "risk", "key_point", "meetings", "sessions", "dms", "prs", "prs_open", "ci_red", "agents", "int:gmail"]);
    expect(rows.find((r) => r.key === "decision")!.tone).toBe("decision");
    expect(rows.find((r) => r.key === "risk")!.tone).toBe("red");
    expect(rows.find((r) => r.key === "dms")!.sub).toEqual({ value: 4, label: "need you" });
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
