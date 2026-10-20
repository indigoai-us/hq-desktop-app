import { describe, expect, it, vi } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import { ACTIVE_RUN_KEY, BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import {
  advanceBriefRun,
  BRIEF_STALL_GRACE_MS,
  BRIEF_STALL_TIMEOUT_MS,
  BRIEF_WATCH_POLL_MS,
  folderFingerprint,
  stillWorkingLine,
  type BriefCreatePhase,
} from "./brief-runs.js";

const BOT = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
const RUN = "brief-20261008-090000";
const dir = `workspace/brief/${RUN}/`;
const MIN = 60_000;

function harness() {
  let clock = new Date(2026, 9, 8, 9, 0, 0).getTime();
  const timers: { fn: () => void; ms: number }[] = [];
  const files: Record<string, string> = {};
  const creator: BriefCreator = {
    company: () => "indigo",
    check: vi.fn(async () => ({ ok: true as const, bot: BOT })),
    dispatch: vi.fn(async () => null),
    fix: vi.fn(async () => null),
    notify: vi.fn(),
  };
  const store = new Map<string, string>();
  const run = new BriefCreateRun({
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    creator,
    read: async (p) => files[p] ?? null,
    now: () => new Date(clock),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
    log: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  return {
    run,
    creator,
    files,
    store,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    flush,
    status: (state: string, extra: object = {}) =>
      (files[`${dir}status.json`] = JSON.stringify({ run_id: RUN, state, step: "Sweeping your day", progress: 0.3, ...extra })),
  };
}

/** A running run that last changed at t=0 and has been silent since. */
const running = (lastChangeAt = 0): BriefCreatePhase => ({
  kind: "running",
  runId: RUN,
  sentAt: 0,
  step: "Sweeping",
  progress: 0.3,
  lastChangeAt,
  updatedAt: "a",
});
const same = { text: JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping", progress: 0.3, updated_at: "a" }) };

describe("stall rule", () => {
  it("does not fail the owner's real run: 10m29s with no status change is still running", () => {
    const at = 10 * MIN + 29_000;
    const p = advanceBriefRun(running(), same, at);
    expect(p.kind).toBe("running");
    expect(stillWorkingLine(p, at)).toMatch(/^Still working on /);
  });

  it("calls a run stalled only after 20 minutes, and marks the verdict soft", () => {
    expect(advanceBriefRun(running(), same, BRIEF_STALL_TIMEOUT_MS - 1).kind).toBe("running");
    expect(advanceBriefRun(running(), same, BRIEF_STALL_TIMEOUT_MS + 1)).toMatchObject({ kind: "failed", stalled: true });
    expect(BRIEF_STALL_TIMEOUT_MS).toBe(20 * MIN);
  });

  it("a bot-reported failure is a hard failure", () => {
    const failed = advanceBriefRun(running(), { text: JSON.stringify({ run_id: RUN, state: "failed", error: "No GitHub." }) }, 1_000);
    expect(failed).toEqual({ kind: "failed", runId: RUN, message: "The brief stopped before it finished." });
  });

  it("fingerprints content and mtime", () => {
    const a = folderFingerprint([{ text: "{}" }, { text: null }]);
    expect(folderFingerprint([{ text: "{}" }, { text: null }])).toBe(a);
    expect(folderFingerprint([{ text: "{}" }, { text: "x" }])).not.toBe(a);
    expect(folderFingerprint([{ text: "{}", mtime: 1 }])).not.toBe(folderFingerprint([{ text: "{}", mtime: 2 }]));
  });
});

describe("BriefCreateRun liveness and stall watch", () => {
  async function startRunning(h: ReturnType<typeof harness>) {
    await h.run.start();
    h.status("running");
    await h.run.poll();
    expect(h.run.phase.kind).toBe("running");
  }

  it("counts new and changing run-folder files as progress", async () => {
    const h = harness();
    await startRunning(h);
    // status.json never changes again; the bot writes other files.
    for (let m = 1; m <= 30; m++) {
      h.advance(MIN);
      if (m % 5 === 0) h.files[`${dir}brief-data.json`] = `{"pass":${m}}`;
      await h.run.probeFolder(RUN);
      await h.run.poll();
      expect(h.run.phase.kind).toBe("running");
    }
    expect(h.run.files).toEqual({ briefData: true, brief: false });
  });

  it("after a stall verdict keeps watching and flips to ready when the run finishes", async () => {
    const h = harness();
    await startRunning(h);
    const onfinish = vi.fn();
    h.run.subscribe(onfinish);
    h.advance(BRIEF_STALL_TIMEOUT_MS + 1);
    await h.run.poll();
    expect(h.run.phase).toMatchObject({ kind: "failed", stalled: true });
    expect(h.run.watching).toBe(true);
    expect(h.store.get(ACTIVE_RUN_KEY)).toBe(RUN);

    h.advance(BRIEF_WATCH_POLL_MS);
    await h.run.pollWatch();
    await h.flush();
    expect(h.run.phase.kind).toBe("failed");

    h.status("ready", { progress: 1 });
    h.advance(BRIEF_WATCH_POLL_MS);
    await h.run.pollWatch();
    expect(h.run.phase).toEqual({ kind: "ready", runId: RUN });
    expect(h.creator.notify).toHaveBeenCalledWith("Your daily brief is ready", expect.any(String));
    expect(onfinish).toHaveBeenLastCalledWith({ kind: "ready", runId: RUN });
    expect(h.run.watching).toBe(false);
    expect(h.store.get(ACTIVE_RUN_KEY)).toBeUndefined();
  });

  it("goes back to running when the folder changes after a stall verdict", async () => {
    const h = harness();
    await startRunning(h);
    h.advance(BRIEF_STALL_TIMEOUT_MS + 1);
    await h.run.poll();
    await h.run.pollWatch(); // records the fingerprint
    h.files[`${dir}brief.json`] = "{}";
    h.advance(BRIEF_WATCH_POLL_MS);
    await h.run.pollWatch();
    await h.flush();
    expect(h.run.phase.kind).toBe("running");
  });

  it("stops watching after the grace window", async () => {
    const h = harness();
    await startRunning(h);
    h.advance(BRIEF_STALL_TIMEOUT_MS + 1);
    await h.run.poll();
    h.advance(BRIEF_STALL_GRACE_MS);
    await h.run.pollWatch();
    expect(h.run.watching).toBe(false);
    expect(h.store.get(ACTIVE_RUN_KEY)).toBeUndefined();
  });

  it("Try again while the last run is watched asks first and defaults to waiting", async () => {
    const h = harness();
    await startRunning(h);
    h.advance(BRIEF_STALL_TIMEOUT_MS + 1);
    await h.run.poll();
    h.run.dismiss();
    expect(h.run.watching).toBe(true);

    await h.run.start();
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
    expect(h.run.duplicatePrompt).toBe(true);
    expect(h.run.phase).toMatchObject({ kind: "failed", stalled: true });

    h.run.waitForLast();
    expect(h.run.duplicatePrompt).toBe(false);
    expect(h.run.phase).toMatchObject({ kind: "running", runId: RUN });
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("Start a new one dispatches a second run", async () => {
    const h = harness();
    await startRunning(h);
    h.advance(BRIEF_STALL_TIMEOUT_MS + 1);
    await h.run.poll();
    await h.run.start();
    expect(h.run.duplicatePrompt).toBe(true);
    h.advance(1_000);
    await h.run.start({ force: true });
    expect(h.creator.dispatch).toHaveBeenCalledTimes(2);
    expect(h.run.watching).toBe(false);
    expect(h.run.phase.kind).toBe("waiting");
  });

  it("a bot-reported failure ends the run with no watch and no prompt", async () => {
    const h = harness();
    await startRunning(h);
    h.status("failed", { error: "The sweep could not read GitHub." });
    await h.run.poll();
    expect(h.run.phase).toEqual({ kind: "failed", runId: RUN, message: "The brief stopped before it finished." });
    expect(h.run.watching).toBe(false);
    await h.run.start();
    expect(h.run.duplicatePrompt).toBe(false);
    expect(h.creator.dispatch).toHaveBeenCalledTimes(2);
  });
});
