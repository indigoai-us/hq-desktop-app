// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// The Create brief loader: idle line, fixed layout, and the single swap to the finished brief.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRawSnippet, flushSync, mount, tick, unmount } from "svelte";
import type { LocalBotRow } from "@hq/platform";
import BriefActivity from "./BriefActivity.svelte";
import BriefDawn from "./BriefDawn.svelte";
import BriefRunsPage from "./BriefRunsPage.svelte";
import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import type { BriefSweepSource } from "./brief-data.js";
import type { BriefActivity as Item } from "./brief-runs.js";

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
const q = (id: string) => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
  flushSync();
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
  localStorage.clear();
});

describe("BriefActivity idle line", () => {
  it("after 20 quiet seconds the last row says still working and for how long; new steps render", () => {
    // happy-dom has no Web Animations; a finished stub lets the row's intro run.
    if (!Element.prototype.animate) {
      Element.prototype.animate = function () {
        const a = { onfinish: null as null | (() => void), cancel() {}, finish() {}, play() {}, pause() {}, currentTime: 0, finished: Promise.resolve() };
        setTimeout(() => a.onfinish?.(), 0);
        return a as unknown as Animation;
      };
    }
    target = document.createElement("div");
    document.body.appendChild(target);
    const activity = [{ at: "1", label: "Read 42 work sessions", state: "done", detail: null }] as Item[];
    const props = $state({ activity, elapsed: "2m 0s", idle: null as string | null });
    app = mount(BriefActivity, { target, props });
    flushSync();
    expect(q("brief-activity-idle")).toBeNull();
    props.idle = "45s";
    flushSync();
    expect(q("brief-activity-idle")?.textContent).toBe("· still working… 45s");
    expect(target.querySelector('[data-testid="brief-activity-item"] .pulse')).not.toBeNull();
    props.activity = [...activity, { at: "2", label: "Writing your brief", state: "running", detail: null }] as Item[];
    props.idle = null;
    flushSync();
    expect(target.textContent).toContain("Writing your brief");
    expect(q("brief-activity-idle")).toBeNull();
    expect(q("brief-elapsed")?.textContent).toBe("2m 0s");
  });
});

describe("finishing a run", () => {
  it("holds 'Your brief is ready' until brief.json is parsed, then swaps once with no placeholder brief", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const f: Record<string, string> = {};
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: true, bot }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    const timers: (() => void)[] = [];
    const run = new BriefCreateRun({
      creator,
      read: async (p) => f[p] ?? null,
      storage: null,
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => {},
      log: () => {},
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const source: BriefSweepSource = {
      readHqFile: async (p) => {
        if (p.endsWith("/brief.json")) await gate;
        return f[p] ?? null;
      },
    };
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefRunsPage, { target, props: { adapter: {}, companies: [], source, creator, run } });
    await settle();
    q("brief-create")!.click();
    await settle();
    const runId = (run.phase as { runId: string }).runId;
    f[`workspace/brief/${runId}/status.json`] = JSON.stringify({ run_id: runId, state: "ready", step: "Done", progress: 1 });
    f["workspace/brief/index.jsonl"] = JSON.stringify({ run_id: runId, created_at: new Date().toISOString(), state: "ready", lead: "decisions", counts: {} });
    f[`workspace/brief/${runId}/brief.json`] = JSON.stringify({ items: { decisions: [{ id: "d1", title: "Ship the gate fix" }] } });
    f[`workspace/brief/${runId}/brief-data.json`] = "{}";
    timers.shift()!();
    await settle();
    expect(run.phase.kind).toBe("ready");
    // brief.json is still being read: the loader holds its final state.
    expect(q("daily-brief")).toBeNull();
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("ready");
    expect(q("brief-dawn-step")?.textContent).toBe("Your brief is ready");
    expect(target.textContent).not.toContain("Nothing owed");
    release();
    await settle();
    expect(q("daily-brief")).not.toBeNull();
    expect(target.textContent).toContain("Ship the gate fix");
    expect(target.textContent).not.toContain("Nothing owed");
    run.stop();
  });
});

describe("the waiting stage", () => {
  function mountWaiting() {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const creator: BriefCreator = { company: () => "indigo", check: async () => ({ ok: true, bot }), dispatch: vi.fn(async () => null), fix: vi.fn(async () => null), notify: vi.fn() };
    const run = new BriefCreateRun({ creator, read: async () => null, storage: null, setTimer: () => 0, clearTimer: () => {}, log: () => {} });
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefRunsPage, { target, props: { adapter: {}, companies: [], source: { readHqFile: async () => null }, creator, run } });
    return run;
  }

  it("is one full card with the eyebrow, headline and the big Create brief centred inside it, and no progress", async () => {
    const run = mountWaiting();
    await settle();
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("idle");
    const copy = target.querySelector<HTMLElement>(".sun .idle-copy")!;
    expect(copy).not.toBeNull();
    expect(copy.querySelector('[data-testid="brief-dawn-kicker"]')?.textContent).toBe("Daily brief");
    expect(copy.querySelector("h2")?.textContent).toBe("Your first brief is waiting");
    const create = copy.querySelector<HTMLButtonElement>('[data-testid="brief-create"]')!;
    expect(create.textContent?.trim()).toBe("Create brief");
    expect(create.classList.contains("big")).toBe(true);
    // Nothing above the card, and none of the run's chrome inside it.
    expect(target.querySelector(".making > header")).toBeNull();
    expect(q("brief-dawn-cells")).toBeNull();
    expect(q("brief-dawn-readout")).toBeNull();
    expect(target.textContent).not.toMatch(/not started|sunrise|progress/i);
    expect(target.querySelectorAll('[data-testid="brief-create"]')).toHaveLength(1);
    run.stop();
  });

  it("Create brief turns the same card into the creating scene", async () => {
    const run = mountWaiting();
    await settle();
    const card = q("brief-dawn");
    q("brief-create")!.click();
    flushSync();
    await settle();
    expect(q("brief-dawn")).toBe(card);
    expect(card?.getAttribute("data-phase")).toBe("running");
    expect(q("brief-dawn-cells")).not.toBeNull();
    run.stop();
  });

  it("the big button is white on the card with a mono caps label and an arrow, 48px, no heavy shadow", async () => {
    const run = mountWaiting();
    await settle();
    const create = q("brief-create")!;
    // The accessible name stays "Create brief"; caps are CSS.
    expect(create.textContent?.trim()).toBe("Create brief");
    expect(create.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    run.stop();
    const css = readFileSync(resolve(process.cwd(), "src/brief/BriefRunsPage.svelte"), "utf8");
    const big = /\.cta\.big \{([^}]*)\}/.exec(css)![1]!;
    expect(big).toMatch(/min-height: 48px/);
    expect(big).toMatch(/border-radius: 10px/);
    expect(big).toMatch(/font-family: var\(--b-code/);
    expect(big).toMatch(/text-transform: uppercase/);
    expect(big).toMatch(/letter-spacing: 0\.08em/);
    expect(big).toMatch(/background: #fff/);
    expect(big).toMatch(/color: #18181b/);
    expect(big).toMatch(/box-shadow: 0 1px 2px rgba\(20, 10, 40, 0\.12\);/);
    expect(/\.cta\.big:hover \:global\(svg\) \{([^}]*)\}/.exec(css)![1]).toMatch(/translateX\(3px\)/);
    expect(/\.cta\.big:hover,\s*\.cta\.big:focus-visible \{([^}]*)\}/.exec(css)![1]).toMatch(/0 0 0 4px rgba\(255, 255, 255, 0\.18\)/);
  });
});

describe("the creating scene", () => {
  const lit = () => target.querySelectorAll('[data-testid="brief-dawn-cells"] .cell.lit').length;

  it("lights the progress strip with the run's progress; failed marks the cell where it stopped", () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    const props = $state({ progress: 0.25, phase: "running" as "running" | "failed" | "ready", step: "Sweeping your day" });
    app = mount(BriefDawn, { target, props });
    flushSync();
    expect(lit()).toBe(6);
    expect(q("brief-dawn-readout")?.textContent).toBe("25%");
    expect(q("brief-dawn-cells")?.getAttribute("aria-valuenow")).toBe("6");
    expect(target.querySelector(".cell.next")).not.toBeNull();
    props.progress = 0.5;
    flushSync();
    expect(lit()).toBe(12);
    props.phase = "failed";
    flushSync();
    expect(lit()).toBe(12);
    expect(target.querySelectorAll(".cell.stop")).toHaveLength(1);
    expect(q("brief-dawn-readout")?.textContent).toBe("Stopped at 50%");
    props.phase = "ready";
    flushSync();
    expect(lit()).toBe(24);
    // The cell count follows the measured row (24 before layout); both ends sit flush.
    expect(q("brief-dawn-cells")?.getAttribute("data-count")).toBe("24");
    const css = readFileSync(resolve(process.cwd(), "src/brief/BriefDawn.svelte"), "utf8");
    expect(/\n  \.cells \{([^}]*)\}/.exec(css)![1]).toMatch(/justify-content: space-between/);
  });

  it("over a brief, the step sits on the sun field; on the page, under the headline", () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefDawn, { target, props: { progress: 0.4, phase: "running", step: "Sweeping your day", size: "masthead" } });
    flushSync();
    expect(target.querySelector(".sun [data-testid='brief-dawn-step']")?.textContent).toContain("Sweeping your day");
    unmount(app);
    app = mount(BriefDawn, { target, props: { progress: 0.4, phase: "running", step: "Sweeping your day", headline: "Your first brief is on its way" } });
    flushSync();
    expect(target.querySelector("header [data-testid='brief-dawn-step']")?.textContent).toContain("Sweeping your day");
    expect(target.querySelector("header h2")?.textContent).toBe("Your first brief is on its way");    // With the card's status row showing the step, the header does not repeat it.
    unmount(app);
    const status = createRawSnippet(() => ({ render: () => `<div data-testid="row">Sweeping your day · 7s</div>` }));
    app = mount(BriefDawn, { target, props: { progress: 0.4, phase: "running", step: "Sweeping your day", headline: "Your first brief is on its way", status } });
    flushSync();
    // Still read out for screen readers, but not drawn twice.
    expect(target.querySelector("header [data-testid='brief-dawn-step']")?.closest(".step-wrap")?.classList.contains("sr")).toBe(true);
    expect(target.querySelector("header h2")?.textContent).toBe("Your first brief is on its way");
  });

  it("the counters and samples sit beside the sun from the run's first frame, before any findings", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const f: Record<string, string> = {};
    const creator: BriefCreator = { company: () => "indigo", check: async () => ({ ok: true, bot }), dispatch: vi.fn(async () => null), fix: vi.fn(async () => null), notify: vi.fn() };
    const run = new BriefCreateRun({ creator, read: async (p) => f[p] ?? null, storage: null, setTimer: () => 0, clearTimer: () => {}, log: () => {} });
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefRunsPage, { target, props: { adapter: {}, companies: [], source: { readHqFile: async (p: string) => f[p] ?? null }, creator, run } });
    await settle();
    q("brief-create")!.click();
    await settle();
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("running");
    expect(q("brief-loader")).not.toBeNull();
    const tiles = target.querySelectorAll<HTMLElement>('[data-testid="brief-finding"]');
    expect(tiles).toHaveLength(12);
    expect([...tiles].every((t) => t.dataset.state === "pending")).toBe(true);
    // The status rows ride on the sun field.
    expect(target.querySelector('.sun [data-testid="brief-activity"]')).not.toBeNull();
    run.stop();
  });

  it("a first brief's page scene plays its ready ripple to the end, then swaps straight to the brief (no band)", async () => {
    // A canvas that draws, so the scene animates as in the app.
    // Every method returns the context itself, so gradients and the like chain (the brief's own canvases draw too).
    const ctx: object = new Proxy({}, { get: (_t, k) => (k === "canvas" || k === "then" ? undefined : () => ctx), set: () => true });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    try {
      const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
      const f: Record<string, string> = {};
      const creator: BriefCreator = { company: () => "indigo", check: async () => ({ ok: true, bot }), dispatch: vi.fn(async () => null), fix: vi.fn(async () => null), notify: vi.fn() };
      const timers: (() => void)[] = [];
      const run = new BriefCreateRun({ creator, read: async (p) => f[p] ?? null, storage: null, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {}, log: () => {} });
      target = document.createElement("div");
      document.body.appendChild(target);
      app = mount(BriefRunsPage, { target, props: { adapter: {}, companies: [], source: { readHqFile: async (p: string) => f[p] ?? null }, creator, run } });
      await settle();
      q("brief-create")!.click();
      await settle();
      const runId = (run.phase as { runId: string }).runId;
      f[`workspace/brief/${runId}/status.json`] = JSON.stringify({ run_id: runId, state: "ready", step: "Done", progress: 1 });
      f["workspace/brief/index.jsonl"] = JSON.stringify({ run_id: runId, created_at: new Date().toISOString(), state: "ready", lead: "decisions", counts: {} });
      f[`workspace/brief/${runId}/brief.json`] = JSON.stringify({ items: { decisions: [{ id: "d1", title: "Ship the gate fix" }] } });
      f[`workspace/brief/${runId}/brief-data.json`] = "{}";
      timers.shift()!();
      await settle();
      // brief.json is parsed, but the ripple is still playing: the page scene holds.
      expect(run.phase.kind).toBe("ready");
      expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("ready");
      expect(q("daily-brief")).toBeNull();
      expect(target.querySelector(".masthead-wrap")).toBeNull();
      // The ripple ends: one swap to the brief, with no band replaying the bloom over it.
      await vi.waitFor(() => expect(q("daily-brief")).not.toBeNull(), { timeout: 6000, interval: 50 });
      expect(q("brief-dawn")).toBeNull();
      expect(target.textContent).toContain("Ship the gate fix");
      run.stop();
    } finally {
      getContext.mockRestore();
    }
  }, 10_000);
});
