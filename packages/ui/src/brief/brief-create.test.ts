import { describe, expect, it, vi } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import { BRIEF_POLL_MS } from "./brief-runs.js";

const BOT = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
const RUN = "brief-20261008-090000";

function harness(over: Partial<BriefCreator> = {}, files: Record<string, string> = {}) {
  let clock = new Date(2026, 9, 8, 9, 0, 0).getTime();
  const timers: (() => void)[] = [];
  const creator: BriefCreator = {
    company: () => "indigo",
    check: vi.fn(async () => ({ ok: true as const, bot: BOT })),
    dispatch: vi.fn(async () => null),
    fix: vi.fn(async () => null),
    notify: vi.fn(),
    ...over,
  };
  const reads: string[] = [];
  const onfinish = vi.fn();
  const run = new BriefCreateRun({
    creator,
    read: async (p) => {
      reads.push(p);
      return files[p] ?? null;
    },
    onfinish,
    now: () => new Date(clock),
    setTimer: (fn, ms) => {
      expect(ms).toBe(BRIEF_POLL_MS);
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    log: () => {},
  });
  return {
    run,
    creator,
    reads,
    onfinish,
    files,
    tick: async (ms = BRIEF_POLL_MS) => {
      clock += ms;
      const fn = timers.shift();
      fn?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("BriefCreateRun", () => {
  it("dispatches with a local-time run id and polls that run's status.json to ready", async () => {
    const h = harness();
    await h.run.start();
    expect(h.creator.dispatch).toHaveBeenCalledWith(BOT, expect.stringContaining(`--run-id ${RUN}`), RUN);
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: RUN });
    expect(h.run.busy).toBe(true);

    const path = `workspace/brief/${RUN}/status.json`;
    h.files[path] = JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.4 });
    await h.tick();
    expect(h.reads).toEqual([path]);
    expect(h.run.phase).toMatchObject({ kind: "running", step: "Sweeping your day", progress: 0.4 });

    h.files[path] = JSON.stringify({ run_id: RUN, state: "ready", progress: 1 });
    await h.tick();
    expect(h.run.phase).toEqual({ kind: "ready", runId: RUN });
    expect(h.creator.notify).toHaveBeenCalledTimes(1);
    expect(h.onfinish).toHaveBeenCalledWith({ kind: "ready", runId: RUN });
    expect(h.run.busy).toBe(false);
  });

  it("stops at a blocked check and runs its fix", async () => {
    const h = harness({
      check: vi.fn(async () => ({ ok: false as const, bot: BOT, fix: "connect-model" as const, message: "No model connected." })),
    });
    await h.run.start();
    expect(h.run.phase).toEqual({ kind: "blocked", fix: "connect-model", message: "No model connected." });
    expect(h.creator.dispatch).not.toHaveBeenCalled();
    expect(await h.run.fix()).toBeNull();
    expect(h.creator.fix).toHaveBeenCalledWith("connect-model", BOT);
    expect(h.run.phase).toEqual({ kind: "idle" });
  });

  it("a failed send ends the run with the host's sentence and does not poll", async () => {
    const h = harness({ dispatch: vi.fn(async () => "Could not send the brief job to pickles.") });
    await h.run.start();
    expect(h.run.phase).toEqual({ kind: "failed", runId: null, message: "Could not send the brief job to pickles." });
    await h.tick();
    expect(h.reads).toEqual([]);
    expect(h.creator.notify).not.toHaveBeenCalled();
  });

  it("a failed status ends the run with the skill's error and no ready notice", async () => {
    const h = harness();
    await h.run.start();
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "failed", error: "The sweep could not read GitHub." });
    await h.tick();
    expect(h.run.phase).toEqual({ kind: "failed", runId: RUN, message: "The sweep could not read GitHub." });
    expect(h.onfinish).toHaveBeenCalledWith({ kind: "failed", runId: RUN, message: "The sweep could not read GitHub." });
    expect(h.creator.notify).not.toHaveBeenCalled();
  });

  it("ignores a second start while a run is in flight", async () => {
    const h = harness();
    await h.run.start();
    await h.run.start();
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("stop() halts polling", async () => {
    const h = harness();
    await h.run.start();
    h.run.stop();
    await h.tick();
    expect(h.reads).toEqual([]);
  });
});
