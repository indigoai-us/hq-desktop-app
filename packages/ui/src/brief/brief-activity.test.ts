// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { LocalBotRow } from "@hq/platform";
import {
  BRIEF_QUIET_MS,
  advanceBriefRun,
  elapsedLabel,
  estimateLabel,
  parseBriefIndex,
  parseBriefStatus,
  stillWorkingLine,
  type BriefCreatePhase,
} from "./brief-runs.js";
import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import BriefActivity from "./BriefActivity.svelte";
import type { BriefActivity as Item } from "./brief-runs.js";

const RUN = "brief-20261009-090122";
const BOT = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;

const statusWith = (activity: unknown) =>
  JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.4, activity });

describe("activity in status.json", () => {
  it("parses the list, drops malformed entries, keeps the newest 12", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ at: `t${i}`, label: `item ${i}`, state: "done" }));
    const s = parseBriefStatus(
      statusWith([...many, { label: "", state: "done" }, { label: "x", state: "weird" }, { label: "Checking GitHub PRs", state: "running" }]),
    )!;
    expect(s.activity).toHaveLength(12);
    expect(s.activity.at(-1)).toEqual({ at: "", label: "Checking GitHub PRs", state: "running", detail: null });
    expect(s.activity[0]!.label).toBe("item 3");
  });

  it("falls back to an empty list when an older skill wrote no activity", () => {
    const s = parseBriefStatus(JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.25 }))!;
    expect(s.activity).toEqual([]);
    const phase = advanceBriefRun({ kind: "waiting", runId: RUN, sentAt: 0 }, { text: JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.25 }) }, 1000);
    expect(phase).toMatchObject({ kind: "running", step: "Sweeping your day", activity: [] });
  });
});

describe("still working", () => {
  const running = (activity: unknown[] = []): BriefCreatePhase => ({
    kind: "running",
    runId: RUN,
    sentAt: 0,
    step: "Sweeping your day",
    progress: 0.25,
    lastChangeAt: 100_000,
    updatedAt: "a",
    activity: activity as never,
  });

  it("stays quiet under 90 seconds, then names the running item", () => {
    const p = running([{ at: "", label: "Checking GitHub PRs", state: "running", detail: null }]);
    expect(stillWorkingLine(p, 100_000 + BRIEF_QUIET_MS - 1)).toBeNull();
    expect(stillWorkingLine(p, 100_000 + BRIEF_QUIET_MS)).toBe("Still working on checking GitHub PRs…");
  });

  it("without activity, names the phase the run folder shows", () => {
    const p = running();
    const at = 100_000 + BRIEF_QUIET_MS + 1;
    expect(stillWorkingLine(p, at, null)).toBe("Still working on sweeping your day…");
    expect(stillWorkingLine(p, at, { briefData: true, brief: false })).toBe("Still working on writing your brief…");
    expect(stillWorkingLine(p, at, { briefData: true, brief: true })).toBe("Still working on finishing up…");
  });

  it("is never shown for finished runs", () => {
    expect(stillWorkingLine({ kind: "ready", runId: RUN }, 10 ** 12)).toBeNull();
    expect(stillWorkingLine({ kind: "failed", runId: RUN, message: "x" }, 10 ** 12)).toBeNull();
  });

  it("the run probes its folder while quiet, so the line can name the phase", async () => {
    let clock = 0;
    const timers: (() => void)[] = [];
    const files: Record<string, string> = {
      [`workspace/brief/${RUN}/status.json`]: JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.25, updated_at: "u" }),
      [`workspace/brief/${RUN}/brief-data.json`]: "{}",
    };
    const run = new BriefCreateRun({
      creator: { company: () => "indigo", check: async () => ({ ok: true, bot: BOT }), dispatch: async () => null, fix: async () => null, notify: () => {} },
      read: async (p) => files[p] ?? null,
      storage: null,
      now: () => new Date(2026, 9, 9, 9, 1, 22 + clock / 1000),
      setTimer: (fn) => (timers.push(fn), 1),
      clearTimer: () => {},
      log: () => {},
    });
    await run.start();
    const step = async (ms: number) => {
      clock += ms;
      timers.shift()!();
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    };
    await step(2000);
    expect(run.files).toBeNull();
    await step(BRIEF_QUIET_MS + 2000);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(run.files).toEqual({ briefData: true, brief: false });
    run.stop();
  });
});

describe("elapsed and estimate", () => {
  it("formats elapsed time", () => {
    expect(elapsedLabel(45_000)).toBe("45s");
    expect(elapsedLabel(134_000)).toBe("2m 14s");
    expect(elapsedLabel(3_780_000)).toBe("1h 3m");
  });

  it("needs two past ready runs and uses their median duration", () => {
    const line = (id: string, created: string, state = "ready", extra = "") =>
      `{"run_id":"${id}","created_at":"${created}","state":"${state}","counts":{}${extra}}`;
    const one = parseBriefIndex(line("brief-20261006-090000", new Date(2026, 9, 6, 9, 10).toISOString())).entries;
    expect(estimateLabel(one)).toBeNull();
    const text = [
      line("brief-20261006-090000", new Date(2026, 9, 6, 9, 10).toISOString()),
      line("brief-20261007-090000", new Date(2026, 9, 7, 9, 14).toISOString()),
      line("brief-20261008-090000", "", "ready", ',"duration_s":720'),
      line("brief-20261008-120000", new Date(2026, 9, 8, 13, 0).toISOString(), "failed"),
    ].join("\n");
    // 10, 14 and 12 minutes; the failed run is left out.
    expect(estimateLabel(parseBriefIndex(text).entries)).toBe("usually ~12 min");
  });
});

describe("dispatch names the app's active company", () => {
  const creator = (company: () => string | null | Promise<string | null>): BriefCreator => ({
    company,
    check: async () => ({ ok: true, bot: BOT }),
    dispatch: vi.fn(async () => null),
    fix: async () => null,
    notify: () => {},
  });

  it("sends /daily-brief <company> --run-id … with the company in the text", async () => {
    const c = creator(async () => "indigo");
    const run = new BriefCreateRun({ creator: c, read: async () => null, storage: null, setTimer: () => 0, clearTimer: () => {}, log: () => {} });
    await run.start();
    const body = (c.dispatch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(body).toMatch(/^\/daily-brief indigo --run-id brief-\d{8}-\d{6}\n/);
    expect(body).toContain("for company indigo");
    run.stop();
  });

  it("does not dispatch when there is no active company", async () => {
    const c = creator(() => null);
    const run = new BriefCreateRun({ creator: c, read: async () => null, storage: null, setTimer: () => 0, clearTimer: () => {}, log: () => {} });
    await run.start();
    expect(c.dispatch).not.toHaveBeenCalled();
    expect(run.phase).toEqual({ kind: "failed", runId: null, message: "Open a company first, then create the brief." });
  });
});

describe("BriefActivity rendering", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("shows the last five items with their states, elapsed, estimate and the still-working line", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    const activity = [
      { at: "1", label: "Checked your setup", state: "done", detail: null },
      { at: "2", label: "Read your last brief", state: "done", detail: null },
      { at: "3", label: "Read 42 work sessions", state: "done", detail: "Oct 4–9" },
      { at: "4", label: "Linear not connected", state: "skipped", detail: null },
      { at: "5", label: "Main CI on 6 repos", state: "failed", detail: "GitHub rate limit" },
      { at: "6", label: "Checking GitHub PRs", state: "running", detail: null },
    ] as Item[];
    app = mount(BriefActivity, {
      target,
      props: { activity, elapsed: "2m 14s", estimate: "usually ~12 min", stillWorking: "Still working on checking GitHub PRs…" },
    });
    flushSync();
    await tick();
    const items = [...target.querySelectorAll<HTMLElement>('[data-testid="brief-activity-item"]')];
    expect(items.map((i) => i.dataset.state)).toEqual(["done", "done", "skipped", "failed", "running"]);
    expect(items[1]!.textContent).toContain("Read 42 work sessions · Oct 4–9");
    expect(items[3]!.textContent).toContain("GitHub rate limit");
    expect(items[4]!.querySelector(".pulse")).not.toBeNull();
    expect(Number(items[0]!.style.opacity)).toBeLessThan(Number(items[4]!.style.opacity));
    expect(target.querySelector('[data-testid="brief-elapsed"]')?.textContent).toBe("2m 14s · usually ~12 min");
    expect(target.querySelector('[data-testid="brief-still-working"]')?.textContent).toBe("Still working on checking GitHub PRs…");
  });

  it("with no activity (older skill) shows only the time line", () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefActivity, { target, props: { activity: [], elapsed: "45s" } });
    flushSync();
    expect(target.querySelectorAll('[data-testid="brief-activity-item"]')).toHaveLength(0);
    expect(target.querySelector('[data-testid="brief-elapsed"]')?.textContent).toBe("45s");
    expect(target.querySelector('[data-testid="brief-still-working"]')).toBeNull();
  });
});
