// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import FirstRunTakeover from "../FirstRunTakeover.svelte";
import FirstRunImportStep from "./FirstRunImportStep.svelte";
import { IMPORT_COPY, type ImportRunView, type ImportScanEnd, type ImportScanHost } from "./import-runner.js";
import { parseScanEvent, type ScanEvent } from "./scan-stream.js";
import type { SceneClock } from "./scene-clock.js";
import { countValue, planScene } from "./scene-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const click = (sel: string) => q<HTMLButtonElement>(sel)!.click();

/** A scan host the test drives by hand. */
function fakeHost() {
  const runs: Array<{ scanId: string; emit: (raw: unknown) => void; end: (status: string) => void }> = [];
  const cancel = vi.fn();
  const importHost: ImportScanHost = {
    run: vi.fn(
      (scanId: string, emit: (raw: unknown) => void) =>
        new Promise<ImportScanEnd>((resolve) =>
          runs.push({ scanId, emit, end: (status) => resolve({ status: status as ImportScanEnd["status"] }) }),
        ),
    ),
    cancel,
  };
  return { importHost, runs, cancel };
}

const SCAN: Array<Record<string, unknown>> = [
  { type: "start", sources: [{ id: "hq", label: "HQ companies" }, { id: "claude-code", label: "Claude Code" }] },
  { type: "source", id: "hq", status: "scanning" },
  { type: "company", id: "indigo", name: "Indigo", basis: "hq-company" },
  { type: "source", id: "hq", status: "done", counts: { companies: 1 } },
  { type: "source", id: "claude-code", status: "scanning" },
  { type: "count", source: "claude-code", key: "sessions", value: 412 },
  { type: "source", id: "claude-code", status: "done", counts: { sessions: 412 } },
  { type: "done", report: "/tmp/r.json", summary: { companies: 1, sessions: 412 } },
];

async function waitForStep(): Promise<void> {
  await vi.waitFor(() => expect(q('[data-testid="first-run-import"]')).toBeTruthy(), { timeout: 3000 });
  await settle();
}

function renderTakeover(opts: { importHost?: ImportScanHost | null; reducedMotion?: boolean } = {}) {
  const handlers = {
    onconfirmname: vi.fn(),
    onretry: vi.fn(),
    ontalk: vi.fn(),
    oncontinueinchat: vi.fn(),
    onimport: vi.fn(),
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(FirstRunTakeover, {
    target: host,
    props: {
      initialName: "Pickles",
      initialStep: "tools",
      creation: { state: "idle" },
      runtimeReady: { claude: true, codex: false, grok: false },
      importHost: opts.importHost ?? null,
      reducedMotion: opts.reducedMotion ?? true,
      ...handlers,
    },
  });
  return handlers;
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("Bring in your context: in the flow", () => {
  it("is left out when the host cannot scan", async () => {
    renderTakeover({ importHost: null });
    await settle();
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 3");
    click('[data-testid="first-run-next"]');
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("done");
  });

  it("follows Your coding tools and asks first: nothing runs until Bring it in", async () => {
    const { importHost } = fakeHost();
    renderTakeover({ importHost });
    await settle();
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 4");
    expect(q('[data-testid="first-run-next"]')?.textContent).toContain("Next: Bring in your context");
    click('[data-testid="first-run-next"]');
    await waitForStep();
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 4");
    expect(q('[data-testid="first-run-import-start"]')?.textContent).toContain("Bring it in");
    expect(q('[data-testid="first-run-import-skip"]')?.textContent).toContain("Skip for now");
    expect(q('[data-testid="first-run-import-consent"]')?.textContent).toBe("It reads only this Mac, and nothing leaves it.");
    expect(q('[data-testid="first-run-next"]')).toBeNull();
    expect(importHost.run).not.toHaveBeenCalled();
  });

  it("Bring it in starts one scan, shows it running at once, and Next: Done stays available", async () => {
    const { importHost, runs } = fakeHost();
    renderTakeover({ importHost });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForStep();
    const start = q<HTMLButtonElement>('[data-testid="first-run-import-start"]')!;
    start.click();
    start.click();
    await settle();
    expect(importHost.run).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(q('[data-testid="first-run-import-start"]')).toBeNull();
    expect(q('[data-testid="first-run-next"]')?.textContent).toContain("Next: Done");
    // Context is the last step before Done, so there is nothing for Finish to skip.
    expect(q('[data-testid="first-run-finish"]')).toBeNull();
    expect(q('[data-testid="first-run-live"]')?.textContent).toContain("Reading this Mac");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("leaving mid-scan (Back or Next) cancels the scan", async () => {
    const { importHost, runs, cancel } = fakeHost();
    renderTakeover({ importHost });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForStep();
    click('[data-testid="first-run-import-start"]');
    await settle();
    click('[data-testid="first-run-back"]');
    await settle();
    expect(cancel).toHaveBeenCalledWith(runs[0]!.scanId);
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("tools");

    click('[data-testid="first-run-next"]');
    await waitForStep();
    expect(q('[data-testid="first-run-import-start"]')).toBeTruthy();
    click('[data-testid="first-run-import-start"]');
    await settle();
    click('[data-testid="first-run-next"]');
    await settle();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("done");
  });

  it("Skip for now goes on to Done without scanning", async () => {
    const { importHost } = fakeHost();
    const handlers = renderTakeover({ importHost });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForStep();
    click('[data-testid="first-run-import-skip"]');
    await settle();
    expect(importHost.run).not.toHaveBeenCalled();
    expect(handlers.onimport).not.toHaveBeenCalled();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("done");
  });

  it("a finished scan hands its counts and report path to the host once, and with reduced motion shows the settled scene", async () => {
    const { importHost, runs } = fakeHost();
    const handlers = renderTakeover({ importHost, reducedMotion: true });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForStep();
    click('[data-testid="first-run-import-start"]');
    await settle();
    for (const line of SCAN) runs[0]!.emit({ v: 1, ...line });
    runs[0]!.end("done");
    await settle();
    expect(handlers.onimport).toHaveBeenCalledTimes(1);
    expect(handlers.onimport).toHaveBeenCalledWith({ summary: { companies: 1, sessions: 412 }, report: "/tmp/r.json" });
    await vi.waitFor(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="first-run-import-row"]')];
      expect(rows.map((r) => r.dataset.source)).toEqual(["hq", "claude-code"]);
      expect(rows.every((r) => r.dataset.status === "done")).toBe(true);
      expect(rows[1]!.querySelector("[data-fr-num]")?.textContent).toBe("412");
    });
    expect(q('[data-testid="first-run-import-title-done"]')?.getAttribute("aria-hidden")).toBe("false");
    expect(q('[data-testid="first-run-import-summary"]')?.textContent).toContain("412");
    expect(q('[data-testid="first-run-live"]')?.textContent).toContain("Pickles knows your world.");
  });

  it("a failed scan says so plainly, offers Retry, and Next still works", async () => {
    const { importHost, runs } = fakeHost();
    renderTakeover({ importHost });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForStep();
    click('[data-testid="first-run-import-start"]');
    await settle();
    runs[0]!.end("failed");
    await vi.waitFor(() => expect(q('[data-testid="first-run-import-failed"]')?.textContent).toContain(IMPORT_COPY.failed));
    click('[data-testid="first-run-import-retry"]');
    await settle();
    expect(runs).toHaveLength(2);
    runs[1]!.end("unavailable");
    await vi.waitFor(() => expect(q('[data-testid="first-run-import-failed"]')?.textContent).toContain(IMPORT_COPY.update));
    // Running again cannot help until HQ is updated: no Retry.
    expect(q('[data-testid="first-run-import-retry"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(false);
    click('[data-testid="first-run-next"]');
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("done");
  });
});

describe("Bring in your context: the step on its own", () => {
  const clock: SceneClock = { now: () => 30, dispose: () => undefined };
  const timed = (lines: Array<Record<string, unknown>>, at = 10) =>
    lines.map((l, i) => ({ at: at + i * 0.01, event: parseScanEvent({ v: 1, ...l }) as ScanEvent }));

  function renderStep(run: ImportRunView, offersFinish: boolean) {
    const handlers = {
      onstart: vi.fn(),
      onskip: vi.fn(),
      onretry: vi.fn(),
      onnext: vi.fn(),
      onfinish: vi.fn(),
      onback: vi.fn(),
      onannounce: vi.fn(),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(FirstRunImportStep, {
      target: host,
      props: { name: "Pickles", stepNumber: 3, total: 5, run, clock, nextLabel: "Next: Agents", offersFinish, reducedMotion: true, ...handlers },
    });
    return handlers;
  }

  it("while running, a later step means Finish with defaults is offered, and each press counts once", async () => {
    const handlers = renderStep({ phase: "running", scanStart: 10, events: timed(SCAN.slice(0, 3)), failure: null }, true);
    await settle();
    const finish = q<HTMLButtonElement>('[data-testid="first-run-finish"]')!;
    expect(finish.textContent).toContain("Finish with defaults");
    expect(q('[data-testid="first-run-next"]')?.textContent).toContain("Next: Agents");
    finish.click();
    await settle();
    finish.click();
    click('[data-testid="first-run-next"]');
    await settle();
    expect(handlers.onfinish).toHaveBeenCalledTimes(1);
    expect(handlers.onnext).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(true);
  });

  it("an empty scan shows the empty state", async () => {
    const handlers = renderStep(
      {
        phase: "done",
        scanStart: 10,
        events: timed([
          { type: "start", sources: [{ id: "codex", label: "Codex" }] },
          { type: "source", id: "codex", status: "done", counts: { sessions: 0 } },
          { type: "done", report: "/tmp/r.json", summary: {} },
        ]),
        failure: null,
      },
      false,
    );
    await settle();
    expect(q('[data-testid="first-run-import-summary"]')?.textContent).toContain("found no history");
    expect(handlers.onannounce).toHaveBeenLastCalledWith("Nothing to bring in yet.");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("a row shows its two largest non-zero counts", async () => {
    renderStep(
      {
        phase: "done",
        scanStart: 10,
        events: timed([
          { type: "start", sources: [{ id: "artifacts", label: "Skills and settings" }] },
          { type: "source", id: "artifacts", status: "done", counts: { skills: 42, policies: 31, plans: 14, hooks: 0 } },
          { type: "done", report: "/tmp/r.json", summary: {} },
        ]),
        failure: null,
      },
      false,
    );
    await settle();
    const nums = [...document.querySelectorAll<HTMLElement>('[data-testid="first-run-import-row"] [data-fr-num]')];
    expect(nums.map((n) => n.dataset.frNum)).toEqual(["skills", "policies"]);
  });

  it("mid-count, the word agrees with the number on screen (1 company, then 3 companies)", async () => {
    const events = timed([
      { type: "start", sources: [{ id: "hq", label: "HQ companies" }] },
      { type: "source", id: "hq", status: "scanning" },
      { type: "count", source: "hq", key: "companies", value: 1 },
      { type: "count", source: "hq", key: "companies", value: 3 },
      { type: "source", id: "hq", status: "done", counts: { companies: 3 } },
      { type: "done", report: "/tmp/r.json", summary: {} },
    ]);
    const plan = planScene({ scanStart: 10, events, failure: null });
    const samples = plan.rows[0]!.counts.find((c) => c.key === "companies")!.samples;
    let at = plan.rows[0]!.shown!;
    while (countValue(samples, at) !== 1) at += 0.01;
    const midClock: SceneClock = { now: () => at, dispose: () => undefined };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(FirstRunImportStep, {
      target: host,
      props: {
        name: "Pickles", stepNumber: 3, total: 4, run: { phase: "running", scanStart: 10, events, failure: null },
        clock: midClock, nextLabel: "Next: Done", offersFinish: false, reducedMotion: false,
        onstart: vi.fn(), onskip: vi.fn(), onretry: vi.fn(), onnext: vi.fn(), onfinish: vi.fn(),
      },
    });
    await vi.waitFor(() => expect(q("[data-fr-num]")?.textContent).toBe("1"));
    expect(q('[data-fr-word="companies"]')?.textContent).toBe("company");
  });

  it("a source error shows on its row while the others carry on", async () => {
    renderStep(
      {
        phase: "done",
        scanStart: 10,
        events: timed([
          SCAN[0]!,
          { type: "source", id: "hq", status: "error", message: "Could not read the HQ folder." },
          ...SCAN.slice(4),
        ]),
        failure: null,
      },
      false,
    );
    await settle();
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="first-run-import-row"]')];
    expect(rows[0]!.dataset.status).toBe("error");
    expect(rows[0]!.querySelector('[data-testid="first-run-import-row-message"]')?.textContent).toBe("Could not read the HQ folder.");
    expect(rows[1]!.dataset.status).toBe("done");
  });
});
