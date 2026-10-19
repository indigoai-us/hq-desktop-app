import { describe, expect, it, vi } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import { ACTIVE_RUN_KEY, BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import { BRIEF_POLL_MS, BRIEF_STALL_GRACE_MS, BRIEF_START_TIMEOUT_MS, BRIEF_TRY_AGAIN_WAIT_MS, BRIEF_WATCH_POLL_MS } from "./brief-runs.js";

const BOT = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
const RUN = "brief-20261008-090000";

function harness(over: Partial<BriefCreator> = {}, files: Record<string, string> = {}) {
  let clock = new Date(2026, 9, 8, 9, 0, 0).getTime();
  const timers: (() => void)[] = [];
  // The quiet watch on a run that has not started yet polls on its own, slower timer.
  const watchTimers: (() => void)[] = [];
  const logs: string[] = [];
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
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const run = new BriefCreateRun({
    storage,
    creator,
    read: async (p) => {
      reads.push(p);
      return files[p] ?? null;
    },
    onfinish,
    now: () => new Date(clock),
    setTimer: (fn, ms) => {
      expect([BRIEF_POLL_MS, BRIEF_WATCH_POLL_MS]).toContain(ms);
      (ms === BRIEF_POLL_MS ? timers : watchTimers).push(fn);
      return timers.length + watchTimers.length;
    },
    clearTimer: () => {},
    log: (m) => void logs.push(m),
  });
  return {
    run,
    creator,
    reads,
    onfinish,
    files,
    store,
    storage,
    setClock: (ms: number) => (clock = ms),
    advance: (ms: number) => (clock += ms),
    timers,
    watchTimers,
    logs,
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

  it("a failed status ends the run with the plain failed line, never the skill's error, and no ready notice", async () => {
    const h = harness();
    await h.run.start();
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "failed", error: "The sweep could not read GitHub." });
    await h.tick();
    expect(h.run.phase).toEqual({ kind: "failed", runId: RUN, message: "The brief stopped before it finished." });
    expect(h.onfinish).toHaveBeenCalledWith({ kind: "failed", runId: RUN, message: "The brief stopped before it finished." });
    expect(h.creator.notify).not.toHaveBeenCalled();
  });

  it("the waiting phase names the bot the job went to", async () => {
    const h = harness();
    await h.run.start();
    expect(h.run.phase).toEqual({ kind: "waiting", runId: RUN, sentAt: expect.any(Number), bot: "pickles" });
    const named = harness({ check: vi.fn(async () => ({ ok: true as const, bot: { ...BOT, displayName: "Jellybean" } as LocalBotRow })) });
    await named.run.start();
    expect(named.run.phase).toMatchObject({ kind: "waiting", bot: "Jellybean" });
  });

  it("a failure written with `status:` and a `message` still ends the run, on a rehydrate too", async () => {
    const written = JSON.stringify({ run_id: RUN, status: "failed", error: "The sweep could not read GitHub.", message: "GitHub is not signed in." });
    const h = harness();
    await h.run.start();
    h.files[`workspace/brief/${RUN}/status.json`] = written;
    await h.tick();
    expect(h.run.phase).toEqual({ kind: "failed", runId: RUN, message: "GitHub is not signed in." });

    const again = harness({}, { [`workspace/brief/${RUN}/status.json`]: written });
    again.storage.setItem(ACTIVE_RUN_KEY, RUN);
    expect(await again.run.rehydrate()).toBe(true);
    expect(again.run.phase).toEqual({ kind: "failed", runId: RUN, message: "GitHub is not signed in." });
    expect(again.creator.notify).not.toHaveBeenCalled();
  });

  it("a missing daily-brief skill skips the send and goes straight to the heal path, with no wait", async () => {
    const skillInstalled = vi.fn(async () => false);
    const h = harness({ skillInstalled });
    await h.run.start({ label: "welcome brief" });
    // Checked twice (the automatic retry looks again), sent never.
    expect(skillInstalled).toHaveBeenCalledTimes(2);
    expect(h.creator.dispatch).not.toHaveBeenCalled();
    expect(h.run.phase).toEqual({
      kind: "failed",
      runId: null,
      message: "Your welcome brief is taking longer than expected.",
      heal: "skill-not-found",
    });
    expect(h.timers).toHaveLength(0);
    expect(h.reads).toEqual([]);
    expect(h.creator.notify).not.toHaveBeenCalled();
  });

  it("a skill that turns up on the automatic retry sends the job", async () => {
    const skillInstalled = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const h = harness({ skillInstalled });
    await h.run.start();
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: RUN });
  });

  it("an unknown skill check still sends the job", async () => {
    const h = harness({ skillInstalled: vi.fn(async () => null) });
    await h.run.start();
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
    const thrown = harness({ skillInstalled: vi.fn(async () => { throw new Error("io"); }) });
    await thrown.run.start();
    expect(thrown.creator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a run that reports skill_not_found retries once by itself, then shows the slow-start line", async () => {
    const h = harness();
    await h.run.start({ label: "welcome brief" });
    const notFound = (id: string) =>
      JSON.stringify({ run_id: id, state: "failed", error: "skill_not_found", message: "No daily-brief skill is installed in this HQ." });
    h.files[`workspace/brief/${RUN}/status.json`] = notFound(RUN);
    await h.tick();
    await vi.waitFor(() => expect(h.run.phase.kind).toBe("waiting"));
    expect(h.creator.dispatch).toHaveBeenCalledTimes(2);
    const retryId = (h.creator.dispatch as ReturnType<typeof vi.fn>).mock.calls[1]![2] as string;
    expect(retryId).not.toBe(RUN);
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: retryId });
    h.files[`workspace/brief/${retryId}/status.json`] = notFound(retryId);
    await h.tick();
    expect(h.creator.dispatch).toHaveBeenCalledTimes(2);
    expect(h.run.phase).toEqual({
      kind: "failed",
      runId: retryId,
      message: "Your welcome brief is taking longer than expected.",
      heal: "skill-not-found",
    });
    expect(JSON.stringify(h.run.phase)).not.toContain("No daily-brief skill");
  });

  it("a plain start timeout sends no second job: it shows one plain line and keeps watching the first run", async () => {
    const h = harness();
    await h.run.start({ label: "welcome brief" });
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
    expect(h.run.phase).toEqual({
      kind: "failed",
      runId: RUN,
      message: "Your welcome brief is taking longer than expected.",
      heal: "start-timeout",
    });
    expect(JSON.stringify(h.run.phase)).not.toMatch(/pickles|bot|check that it is running/i);
    // The first run is still followed, quietly.
    expect(h.watchTimers).toHaveLength(1);
    expect(h.store.get(ACTIVE_RUN_KEY)).toBe(RUN);
    h.advance(BRIEF_WATCH_POLL_MS);
    await h.run.pollWatch();
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
    expect(h.run.phase).toMatchObject({ kind: "failed", heal: "start-timeout" });
  });

  it("a late start of the first run after the timeout still lands, with no second job", async () => {
    const h = harness();
    await h.run.start({ label: "welcome brief" });
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    expect(h.run.phase).toMatchObject({ kind: "failed", heal: "start-timeout" });
    // A busy bot picks the first job up after the start window.
    const path = `workspace/brief/${RUN}/status.json`;
    h.files[path] = JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.2 });
    h.advance(BRIEF_WATCH_POLL_MS);
    await h.run.pollWatch();
    expect(h.run.phase).toMatchObject({ kind: "running", runId: RUN, step: "Sweeping your day" });
    h.files[path] = JSON.stringify({ run_id: RUN, state: "ready", progress: 1 });
    await h.tick();
    expect(h.run.phase).toEqual({ kind: "ready", runId: RUN });
    expect(h.creator.notify).toHaveBeenCalledTimes(1);
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a first run that lands ready straight after the timeout is the brief, with no second job", async () => {
    const h = harness();
    await h.run.start();
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "ready", progress: 1 });
    h.advance(BRIEF_WATCH_POLL_MS);
    await h.run.pollWatch();
    expect(h.run.phase).toEqual({ kind: "ready", runId: RUN });
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("Try again after a start timeout follows the first run when it has started, and sends nothing", async () => {
    const h = harness();
    await h.run.start({ label: "welcome brief" });
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.2 });
    await h.run.start();
    expect(h.run.phase).toMatchObject({ kind: "running", runId: RUN, step: "Sweeping your day" });
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("Try again after a start timeout waits a further window on the first run, then sends one new job", async () => {
    const h = harness();
    await h.run.start({ label: "welcome brief" });
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    await h.run.start();
    // Re-checked the same run: still nothing, so it waits on that run.
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: RUN });
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
    await h.tick();
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: RUN });
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
    // The further window ends with no start: one new job.
    await h.tick(BRIEF_TRY_AGAIN_WAIT_MS);
    await vi.waitFor(() => expect(h.creator.dispatch).toHaveBeenCalledTimes(2));
    const second = (h.creator.dispatch as ReturnType<typeof vi.fn>).mock.calls[1]![2] as string;
    expect(second).not.toBe(RUN);
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: second });
    // That job's own start timeout shows the line again, with no third job.
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    expect(h.creator.dispatch).toHaveBeenCalledTimes(2);
    expect(h.run.phase).toEqual({
      kind: "failed",
      runId: second,
      message: "Your welcome brief is taking longer than expected.",
      heal: "start-timeout",
    });
  });

  it("Try again after a start timeout sends a new job at once when the first run has failed", async () => {
    const h = harness();
    await h.run.start();
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "failed", error: "The sweep could not read GitHub." });
    await h.run.start();
    await vi.waitFor(() => expect(h.creator.dispatch).toHaveBeenCalledTimes(2));
    const second = (h.creator.dispatch as ReturnType<typeof vi.fn>).mock.calls[1]![2] as string;
    expect(second).not.toBe(RUN);
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: second });
  });

  it("an HQ folder that cannot be read shows the slow-start line without sending, logged as an HQ folder error", async () => {
    const skillInstalled = vi.fn(async () => "hq-folder" as const);
    const h = harness({ skillInstalled });
    await h.run.start({ label: "welcome brief" });
    expect(h.creator.dispatch).not.toHaveBeenCalled();
    // No automatic retry: the folder will not read on a second look either.
    expect(skillInstalled).toHaveBeenCalledTimes(1);
    expect(h.run.phase).toEqual({
      kind: "failed",
      runId: null,
      message: "Your welcome brief is taking longer than expected.",
      heal: "hq-folder",
    });
    expect(h.logs.join("\n")).toMatch(/HQ folder/);
    expect(h.logs.join("\n")).not.toMatch(/skill-not-found/);
  });

  it("Try again on the welcome brief's slow-start line keeps calling it the welcome brief", async () => {
    const skillInstalled = vi.fn(async () => false);
    const h = harness({ skillInstalled });
    await h.run.start({ label: "welcome brief" });
    expect(h.run.phase).toMatchObject({ message: "Your welcome brief is taking longer than expected." });
    // The Try again button calls start() with no label.
    await h.run.start();
    expect(h.run.phase).toMatchObject({ message: "Your welcome brief is taking longer than expected." });
    // A brief started after dismissing is a plain brief again.
    h.run.dismiss();
    await h.run.start();
    expect(h.run.phase).toMatchObject({ message: "Your brief is taking longer than expected." });
  });

  it("a run that started never takes the heal path", async () => {
    const h = harness();
    await h.run.start();
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "queued" });
    await h.tick();
    expect(h.run.phase.kind).toBe("running");
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
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

  it("the click flips to dispatching synchronously, before the bot check resolves", () => {
    let release!: () => void;
    const h = harness({ check: vi.fn(() => new Promise<never>((r) => (release = r as () => void))) });
    void h.run.start();
    expect(h.run.phase).toEqual({ kind: "dispatching", runId: RUN });
    expect(h.run.busy).toBe(true);
    expect(h.creator.dispatch).not.toHaveBeenCalled();
    void release;
  });

  it("remembers the active run while it is in flight and forgets it when it ends", async () => {
    const h = harness();
    await h.run.start();
    expect(h.store.get(ACTIVE_RUN_KEY)).toBe(RUN);
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "ready" });
    await h.tick();
    expect(h.store.has(ACTIVE_RUN_KEY)).toBe(false);
  });

  it("rehydrates a remembered run from a fresh running status.json and keeps polling", async () => {
    const h = harness();
    h.store.set(ACTIVE_RUN_KEY, RUN);
    const fresh = new Date(2026, 9, 8, 9, 0, 0).toISOString();
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.5, updated_at: fresh });
    expect(await h.run.rehydrate()).toBe(true);
    expect(h.run.phase).toMatchObject({ kind: "running", runId: RUN, step: "Sweeping your day", progress: 0.5 });
    expect(h.creator.dispatch).not.toHaveBeenCalled();
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "ready" });
    await h.tick();
    expect(h.run.phase).toEqual({ kind: "ready", runId: RUN });
    expect(h.creator.notify).toHaveBeenCalledTimes(1);
  });

  it("rehydrates a running run listed in index.jsonl with no remembered id", async () => {
    const h = harness();
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "running", step: "Writing your brief", progress: 0.9 });
    expect(await h.run.rehydrate([RUN])).toBe(true);
    expect(h.run.phase).toMatchObject({ kind: "running", progress: 0.9 });
  });

  it("does not resume a stale run, and finishes one that completed while away", async () => {
    const h = harness();
    h.store.set(ACTIVE_RUN_KEY, RUN);
    const old = new Date(2026, 9, 8, 8, 0, 0).toISOString();
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "running", step: "x", progress: 0.3, updated_at: old });
    expect(await h.run.rehydrate()).toBe(false);
    expect(h.run.phase).toEqual({ kind: "idle" });
    expect(h.store.has(ACTIVE_RUN_KEY)).toBe(false);

    const h2 = harness();
    h2.store.set(ACTIVE_RUN_KEY, RUN);
    h2.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "ready" });
    expect(await h2.run.rehydrate()).toBe(true);
    expect(h2.run.phase).toEqual({ kind: "ready", runId: RUN });
    expect(h2.creator.notify).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers of every finished run", async () => {
    const h = harness();
    const seen: string[] = [];
    const off = h.run.subscribe((p) => seen.push(p.kind));
    await h.run.start();
    h.files[`workspace/brief/${RUN}/status.json`] = JSON.stringify({ run_id: RUN, state: "failed", error: "x" });
    await h.tick();
    off();
    expect(seen).toEqual(["failed"]);
  });

  it("Try again stops re-checking once the first run starts: a later failure of that run shows, with no second job", async () => {
    const h = harness();
    await h.run.start();
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    await h.run.start();
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: RUN });
    const path = `workspace/brief/${RUN}/status.json`;
    h.files[path] = JSON.stringify({ run_id: RUN, state: "running", step: "Sweeping your day", progress: 0.2 });
    await h.tick();
    expect(h.run.phase).toMatchObject({ kind: "running", runId: RUN });
    h.files[path] = JSON.stringify({ run_id: RUN, state: "failed", message: "GitHub is not signed in." });
    await h.tick();
    expect(h.run.phase).toMatchObject({ kind: "failed", runId: RUN, message: "GitHub is not signed in." });
    expect(h.creator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a late Try again, after HQ stopped watching the first run, sends a new job at once", async () => {
    const h = harness();
    await h.run.start();
    await h.tick(BRIEF_START_TIMEOUT_MS + 1);
    expect(h.run.phase).toMatchObject({ kind: "failed", heal: "start-timeout" });
    h.advance(BRIEF_STALL_GRACE_MS + 1);
    await h.run.pollWatch();
    expect(h.run.watching).toBe(false);
    await h.run.start();
    await vi.waitFor(() => expect(h.creator.dispatch).toHaveBeenCalledTimes(2));
    const second = (h.creator.dispatch as ReturnType<typeof vi.fn>).mock.calls[1]![2] as string;
    expect(second).not.toBe(RUN);
    expect(h.run.phase).toMatchObject({ kind: "waiting", runId: second });
  });
});
