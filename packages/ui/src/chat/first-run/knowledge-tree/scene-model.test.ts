import { describe, expect, it } from "vitest";

import { parseScanEvent, type ScanEvent } from "./scan-stream.js";
import {
  PACE,
  countValue,
  countWord,
  feedingRow,
  createPlanMemo,
  planScene,
  richnessCrossing,
  richnessValue,
  treeSpecFor,
  type SceneInput,
  type TimedScanEvent,
} from "./scene-model.js";
import { branchCellAt, generateTree, leafVersionAt, rasterizeTree } from "./tree-model.js";

/** Build a log from [second, event] pairs, events as the CLI prints them (v is added). */
function log(...pairs: Array<[number, Record<string, unknown>]>): TimedScanEvent[] {
  return pairs.map(([at, raw]) => {
    const event = parseScanEvent({ v: 1, ...raw });
    if (!event) throw new Error(`fixture event did not parse: ${JSON.stringify(raw)}`);
    return { at, event: event as ScanEvent };
  });
}

const START = { type: "start", sources: [
  { id: "hq", label: "HQ companies" },
  { id: "repos", label: "Code repositories" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] };

/** A whole scan where every event lands within 50 ms of "Bring it in" at second 10. */
function fastScan(): TimedScanEvent[] {
  let t = 10;
  const at = () => (t += 0.001);
  return log(
    [at(), START],
    [at(), { type: "source", id: "hq", status: "scanning" }],
    [at(), { type: "company", id: "holler", name: "Holler", basis: "hq-company" }],
    [at(), { type: "company", id: "indigo", name: "Indigo", basis: "hq-company" }],
    [at(), { type: "company", id: "synesis", name: "Synesis Strategy", basis: "hq-company" }],
    [at(), { type: "count", source: "hq", key: "companies", value: 3 }],
    [at(), { type: "source", id: "hq", status: "done", counts: { companies: 3 } }],
    [at(), { type: "source", id: "repos", status: "scanning" }],
    [at(), { type: "project", id: "p_000000000001", name: "hq-desktop", company: "indigo", basis: "repo" }],
    [at(), { type: "project", id: "p_000000000002", name: "launch", company: "holler", basis: "repo" }],
    [at(), { type: "project", id: "p_000000000003", name: "ops", company: "synesis", basis: "repo" }],
    [at(), { type: "project", id: "p_000000000004", name: "dotfiles", company: null, basis: "repo" }],
    [at(), { type: "source", id: "repos", status: "done", counts: { repos: 4 } }],
    [at(), { type: "source", id: "claude-code", status: "scanning" }],
    ...[1, 2, 5, 10, 20, 50, 100, 200, 412].map(
      (value) => [at(), { type: "count", source: "claude-code", key: "sessions", value }] as [number, Record<string, unknown>],
    ),
    [at(), { type: "source", id: "claude-code", status: "done", counts: { sessions: 412 } }],
    [at(), { type: "source", id: "codex", status: "scanning" }],
    [at(), { type: "count", source: "codex", key: "sessions", value: 96 }],
    [at(), { type: "source", id: "codex", status: "done", counts: { sessions: 96 } }],
    [at(), { type: "done", report: "/tmp/report.json", summary: { companies: 3, projects: 4, sessions: 508 } }],
  );
}

function plan(events: TimedScanEvent[], extra: Partial<SceneInput> = {}) {
  return planScene({ scanStart: 10, events, failure: null, ...extra });
}

describe("scene model: plan memo", () => {
  it("reuses the plan while the lines, start and failure are the same, and replans when they change", () => {
    const planFor = createPlanMemo();
    const log = fastScan();
    const first = planFor({ scanStart: 10, events: log.slice(0, 5), failure: null });
    // A new view object with the same lines: the same plan, not a new one.
    expect(planFor({ scanStart: 10, events: [...log.slice(0, 5)], failure: null })).toBe(first);
    const more = planFor({ scanStart: 10, events: log.slice(0, 9), failure: null });
    expect(more).not.toBe(first);
    expect(more).toEqual(planScene({ scanStart: 10, events: log.slice(0, 9), failure: null }));
    const failed = planFor({ scanStart: 10, events: log.slice(0, 9), failure: { at: 12, message: "x" } });
    expect(failed).not.toBe(more);
    expect(planFor({ scanStart: 11, events: log.slice(0, 9), failure: null })).not.toBe(failed);
  });
});

describe("scene model: pacing", () => {
  it("asks first: nothing is planned before Bring it in", () => {
    const p = planScene({ scanStart: null, events: [], failure: null });
    expect(p.outcome).toBe("idle");
    expect(p.rows).toEqual([]);
    expect(p.trunk).toBeNull();
  });

  it("stages a fast scan: rows keep their dwell, limbs and twigs their gaps", () => {
    const p = plan(fastScan());
    expect(p.outcome).toBe("done");
    expect(p.rows.map((r) => r.id)).toEqual(["hq", "repos", "claude-code", "codex"]);
    for (let i = 1; i < p.rows.length; i += 1) {
      expect(p.rows[i]!.appear - p.rows[i - 1]!.appear).toBeGreaterThanOrEqual(PACE.rowDwell - 1e-9);
    }
    for (const r of p.rows) expect(r.resolve! - r.appear).toBeGreaterThanOrEqual(PACE.rowResolveMin - 1e-9);
    const limbs = p.limbs.filter((l) => l.slot !== "other");
    expect(limbs.map((l) => l.name)).toEqual(["Holler", "Indigo", "Synesis Strategy"]);
    expect(limbs.map((l) => l.slot)).toEqual([0, 1, 2]);
    const ready = p.limbs.map((l) => l.ready);
    for (let i = 1; i < ready.length; i += 1) expect(ready[i]! - ready[i - 1]!).toBeGreaterThanOrEqual(PACE.limbGap - 1e-9);
    const twigs = p.limbs.flatMap((l) => l.projects.map((x) => x.ready)).sort((a, b) => a - b);
    for (let i = 1; i < twigs.length; i += 1) expect(twigs[i]! - twigs[i - 1]!).toBeGreaterThanOrEqual(PACE.projectGap - 1e-9);
    // The trunk follows the first row; the crown fills at the capped rate.
    expect(p.trunk).toBeCloseTo(p.rows[0]!.appear + PACE.trunkAfterRow, 6);
    const full = p.richness[p.richness.length - 1]!;
    expect(full.t - p.richness[0]!.t).toBeGreaterThanOrEqual(p.richnessTarget / PACE.richRate - 1e-6);
    // It settles only after everything it scheduled.
    expect(p.settle).toBeGreaterThanOrEqual(p.rows[p.rows.length - 1]!.resolve! + PACE.settlePad - 1e-9);
    expect(p.settle! - 10).toBeGreaterThan(12);
  });

  it("never runs ahead of the data: no beat before the event behind it", () => {
    const events = fastScan().map((e, i) => ({ ...e, at: 10 + i * 0.7 }));
    const p = plan(events);
    const arrival = (pred: (e: ScanEvent) => boolean) => events.find((e) => pred(e.event))!.at;
    for (const limb of p.limbs.filter((l) => l.slot !== "other")) {
      expect(limb.ready).toBeGreaterThanOrEqual(arrival((e) => e.type === "company" && e.id === limb.id) + PACE.lag - 1e-9);
      for (const proj of limb.projects) {
        expect(proj.ready).toBeGreaterThanOrEqual(arrival((e) => e.type === "project" && e.id === proj.id) + PACE.lag - 1e-9);
      }
    }
    for (const row of p.rows) {
      for (const c of row.counts) {
        for (const s of c.samples) expect(s.t).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("is causal: a later event never changes what was already on screen", () => {
    const events = fastScan().map((e, i) => ({ ...e, at: 10 + i * 0.6 }));
    const box = { sx: 900, gy: 700, left: 560, right: 1300, top: 90 };
    const full = plan(events);
    const fullRaster = rasterizeTree(generateTree(treeSpecFor(full)), box);
    for (const cut of [13, 15, 17.5, 20, 22, 26, 30]) {
      const seen = plan(events.filter((e) => e.at <= cut));
      const seenRaster = rasterizeTree(generateTree(treeSpecFor(seen)), box);
      for (const t of [cut - 2, cut - 0.5, cut]) {
        expect(richnessValue(seen, t)).toBeCloseTo(richnessValue(full, t), 9);
        // every glyph on screen at t: the same cell, glyph and start second
        const shown = (r: typeof seenRaster) => [
          ...r.branches
            .map((slot) => branchCellAt(slot, t))
            .filter((c) => c !== null)
            .map((c) => `b ${c.c},${c.r},${c.line},${c.tg.toFixed(6)}`),
          ...r.leaves
            .map((l) => [l, leafVersionAt(l, t)] as const)
            .filter(([, v]) => v !== null)
            .map(([l, v]) => `l ${l.c},${l.r},${v!.ch},${v!.a.toFixed(4)},${l.tg.toFixed(6)}`),
          ...r.blossoms.filter((b) => b.tg <= t).map((b) => `f ${b.x.toFixed(2)},${b.y.toFixed(2)},${b.tg.toFixed(6)}`),
        ].sort();
        expect(shown(seenRaster)).toEqual(shown(fullRaster));
      }
      seen.rows.forEach((row, i) => expect(row.appear).toBe(full.rows[i]!.appear));
    }
  });

  it("interpolates milestone counts smoothly and never ahead of a value", () => {
    const samples = [
      { t: 1, v: 1 },
      { t: 1.2, v: 2 },
      { t: 1.4, v: 5 },
      { t: 1.6, v: 10 },
      { t: 3, v: 412 },
    ];
    let prev = -1;
    for (let t = 0; t <= 8; t += 0.05) {
      const v = countValue(samples, t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
      // never shows a value before it arrived
      const known = samples.filter((s) => s.t <= t).map((s) => s.v);
      expect(v).toBeLessThanOrEqual(known.length ? Math.max(...known) : 0);
    }
    expect(countValue(samples, 8)).toBe(412);
    expect(countValue(samples, 0.5)).toBe(0);
  });
});

describe("scene model: what the tree holds", () => {
  it("caps the crown: huge counts fill it once and no more", () => {
    const events = log(
      [10, { type: "start", sources: [{ id: "claude-code", label: "Claude Code" }] }],
      [10.1, { type: "count", source: "claude-code", key: "sessions", value: 900_000 }],
      [10.2, { type: "done", report: "/tmp/r.json", summary: { sessions: 900_000 } }],
    );
    const p = plan(events);
    expect(p.richnessTarget).toBe(1);
    expect(richnessValue(p, 1e6)).toBe(1);
    expect(richnessCrossing(p, 1.01)).toBe(Infinity);
  });

  it("puts unattached projects on a small other limb, and caps twigs per limb", () => {
    const events = log(
      [10, START],
      [10.1, { type: "company", id: "indigo", name: "Indigo", basis: "hq-company" }],
      ...Array.from({ length: 6 }, (_, i) => [10.2 + i * 0.01, { type: "project", id: `p_00000000010${i}`, name: `app-${i}`, company: "indigo", basis: "repo" }] as [number, Record<string, unknown>]),
      [10.4, { type: "project", id: "p_000000000201", name: "dotfiles", company: null, basis: "repo" }],
      [10.5, { type: "project", id: "p_000000000202", name: "scratch", company: "nobody", basis: "repo" }],
    );
    const p = plan(events);
    const indigo = p.limbs.find((l) => l.id === "indigo")!;
    expect(indigo.projectTotal).toBe(6);
    expect(indigo.projects).toHaveLength(4);
    const other = p.limbs.find((l) => l.slot === "other")!;
    expect(other.projects.map((x) => x.name)).toEqual(["dotfiles", "scratch"]);
    expect(p.totals.projects).toBe(8);
  });

  it("folds companies past five onto the other limb", () => {
    const events = log(
      [10, START],
      ...Array.from({ length: 7 }, (_, i) => [10.1 + i * 0.01, { type: "company", id: `co-${i}`, name: `Co ${i}`, basis: "folder" }] as [number, Record<string, unknown>]),
    );
    const p = plan(events);
    expect(p.limbs.filter((l) => l.slot !== "other")).toHaveLength(5);
    expect(p.limbs.find((l) => l.slot === "other")?.extraCompanies).toBe(2);
    expect(p.totals.companies).toBe(7);
  });

  it("moves a project that a later pass attaches to a company: the old twig withers after it grew", () => {
    const events = log(
      [10, START],
      [10.1, { type: "company", id: "hooli", name: "hooli", basis: "folder" }],
      [10.2, { type: "project", id: "p_9a1f3c2b7d40", name: "alpha", company: null, basis: "repo" }],
      [16, { type: "project", id: "p_9a1f3c2b7d40", name: "alpha", company: "hooli", basis: "repo" }],
    );
    const p = plan(events);
    const other = p.limbs.find((l) => l.slot === "other")!;
    const hooli = p.limbs.find((l) => l.id === "hooli")!;
    const old = other.projects[0]!;
    expect(old.gone).not.toBeNull();
    expect(old.gone!).toBeGreaterThanOrEqual(16 + PACE.lag);
    expect(old.gone!).toBeGreaterThanOrEqual(old.ready + 1.5);
    expect(hooli.projects.map((x) => x.id)).toEqual(["p_9a1f3c2b7d40"]);
    expect(hooli.projects[0]!.ready).toBeGreaterThanOrEqual(old.gone!);
    expect(hooli.projectTotal).toBe(1);
    expect(other.projectTotal).toBe(0);
    // The emptied other limb withers too; one project counted once.
    expect(other.gone).not.toBeNull();
    expect(p.totals.projects).toBe(1);
    // A repeat with nothing new changes nothing.
    const again = plan([...events, ...log([17, { type: "project", id: "p_9a1f3c2b7d40", name: "alpha", company: "hooli", basis: "repo" }])]);
    expect(again.limbs).toEqual(p.limbs);
  });
});

describe("scene model: rows, errors, empty, failure", () => {
  it("a source error shows on its row in plain words and the tree carries on", () => {
    const events = log(
      [10, START],
      [10.1, { type: "source", id: "codex", status: "scanning" }],
      [10.2, { type: "count", source: "codex", key: "sessions", value: 3 }],
      [10.3, { type: "error", source: "codex", message: "Some session folders could not be read." }],
      [10.4, { type: "source", id: "codex", status: "error", message: "Couldn't read Codex" }],
      [10.5, { type: "source", id: "claude-code", status: "scanning" }],
      [10.6, { type: "count", source: "claude-code", key: "sessions", value: 40 }],
      [10.7, { type: "source", id: "claude-code", status: "done", counts: { sessions: 40 } }],
      [10.8, { type: "done", report: "/tmp/r.json", summary: { sessions: 43 } }],
    );
    const p = plan(events);
    const codex = p.rows.find((r) => r.id === "codex")!;
    expect(codex.status).toBe("error");
    expect(codex.message).toBe("Couldn't read Codex");
    expect(p.rows.find((r) => r.id === "claude-code")!.status).toBe("done");
    expect(p.outcome).toBe("done");
    expect(p.trunk).not.toBeNull();
  });

  it("accepts skipped sources and gives listed sources that never spoke a row at the end", () => {
    const events = log(
      [10, START],
      [10.1, { type: "source", id: "hq", status: "skipped", message: "No HQ companies yet" }],
      [10.2, { type: "done", report: "/tmp/r.json", summary: { companies: 0, projects: 0, sessions: 0 } }],
    );
    const p = plan(events);
    expect(p.rows.find((r) => r.id === "hq")).toMatchObject({ status: "skipped", message: "No HQ companies yet" });
    expect(p.rows.map((r) => r.id)).toEqual(["hq", "repos", "claude-code", "codex"]);
  });

  it("an empty scan is calm: no tree, a title change, and rows that say nothing was found", () => {
    const events = log(
      [10, { type: "start", sources: [{ id: "claude-code", label: "Claude Code" }] }],
      [10.1, { type: "source", id: "claude-code", status: "scanning" }],
      [10.2, { type: "source", id: "claude-code", status: "done", counts: { sessions: 0 } }],
      [10.3, { type: "done", report: "/tmp/r.json", summary: { companies: 0, projects: 0, sessions: 0 } }],
    );
    const p = plan(events);
    expect(p.outcome).toBe("empty");
    expect(p.trunk).toBeNull();
    expect(p.limbs).toEqual([]);
    expect(p.settle).not.toBeNull();
    expect(p.rows[0]!.message).toBe("Nothing found");
    expect(p.summary).toEqual([]);
  });

  it("a scan with no sources at all is empty too", () => {
    const p = plan(log([10, { type: "start", sources: [] }], [10.2, { type: "done", report: "/tmp/r.json", summary: {} }]));
    expect(p.outcome).toBe("empty");
    expect(p.rows).toEqual([]);
  });

  it("hq-cli's own failure is not a row and not a result: the scene fails", () => {
    const events = log(
      [10.1, { type: "error", source: "scanner", message: "The import-context scanner is not installed in this HQ. Update HQ and try again." }],
      [10.2, { type: "done", report: null, summary: { companies: 0, projects: 0, sessions: 0 } }],
    );
    const p = plan(events, { failure: { at: 10.2, message: "Update HQ to bring in your context." } });
    expect(p.rows).toEqual([]);
    expect(p.outcome).toBe("failed");
    expect(p.settle).toBeNull();
    expect(p.failure?.message).toBe("Update HQ to bring in your context.");
  });

  it("a stream that breaks part way keeps what grew and stops the rows still reading", () => {
    const events = fastScan().filter((e) => e.event.type !== "done").slice(0, 15);
    const p = plan(events, { failure: { at: 12, message: "Couldn't finish reading this Mac." } });
    expect(p.outcome).toBe("failed");
    expect(p.limbs.length).toBeGreaterThan(0);
    const reading = p.rows.find((r) => r.id === "claude-code")!;
    expect(reading.status).toBe("stopped");
  });

  it("summarises with the done line's counts in the preview's words", () => {
    const p = plan(fastScan());
    expect(p.summary.map((s) => `${s.value} ${s.label}`)).toEqual(["3 companies", "4 projects", "508 conversations"]);
    expect(countWord("sessions", 1)).toBe("session");
    expect(countWord("claude_md", 5)).toBe("CLAUDE.md files");
    expect(countWord("mcp_servers", 1)).toBe("MCP server");
  });

  it("the latest row to appear is the one feeding the tree", () => {
    const p = plan(fastScan());
    expect(feedingRow(p, p.rows[0]!.appear)).toBe(-1);
    expect(feedingRow(p, p.rows[1]!.appear + 0.5)).toBe(1);
    expect(feedingRow(p, 1e6)).toBe(p.rows.length - 1);
  });
});
