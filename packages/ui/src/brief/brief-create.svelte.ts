/**
 * Create brief: check the main local bot, send it the daily-brief job with a
 * fresh run id, then poll the run's status.json until it is ready or failed.
 * The host supplies the bot seam (`BriefCreator`); the poll logic is the pure
 * `advanceBriefRun` in brief-runs.ts.
 */

import type { LocalBotRow } from "@hq/platform";
import {
  briefBotLabel,
  BRIEF_LIVENESS_FILES,
  BRIEF_BOT_FAILURE_POLL_MS,
  BRIEF_DISPATCH_TIMEOUT_MESSAGE,
  BRIEF_DISPATCH_TIMEOUT_MS,
  BRIEF_FALLBACK_TOOL,
  BRIEF_POLL_MS,
  BRIEF_WAKE_DISPATCH_TIMEOUT_MS,
  BRIEF_WAKE_TIMEOUT_MS,
  toolStep,
  wakeFailedMessage,
  wakeStep,
  BRIEF_QUIET_MS,
  BRIEF_STALL_GRACE_MS,
  BRIEF_WATCH_POLL_MS,
  folderFingerprint,
  type BriefRunFiles,
  BRIEF_STALL_TIMEOUT_MS,
  BRIEF_START_TIMEOUT_MS,
  failedMessage,
  isBriefRunId,
  parseBriefStatus,
  runIdTime,
  advanceBriefRun,
  briefJobMessage,
  briefRunId,
  briefRunPath,
  type BriefBotCheck,
  type BriefBotFix,
  type BriefCreatePhase,
  type BriefPollReading,
} from "./brief-runs.js";

/** What the host provides so the brief can start a run on a local bot. */
export interface BriefCreator {
  /**
   * The app's active company slug. The job always names it: a bot that
   * belongs to several companies would otherwise pick one itself.
   */
  company(): string | null | Promise<string | null>;
  /** Fresh bot list and model check. */
  check(): Promise<BriefBotCheck>;
  /** Send the job to the bot. Resolves to a plain error sentence, or null when sent. */
  dispatch(bot: LocalBotRow, body: string, idempotencyKey: string): Promise<string | null>;
  /** Run the fix for a blocked check. Resolves to a plain error sentence, or null. */
  fix(fix: BriefBotFix, bot: LocalBotRow | null): Promise<string | null>;
  /**
   * The fallback when the assistant cannot run: open the HQ folder in a
   * coding tool with the job as its first prompt, so the person always has
   * a way to get a brief. Resolves to a plain error sentence, or null once
   * the tool opened. Optional: without it the fallback is not offered.
   */
  launch?(engine: "claude" | "codex" | "grok", prompt: string): Promise<string | null>;
  /** Tell the person the brief is ready (OS banner and/or in-app toast). */
  notify(title: string, body: string): void;
  /**
   * Did the bot report that its turn on the job failed since `sinceMs`? A
   * plain sentence for the person when it did, else null. Optional: without
   * it a failed turn ends at the start timeout.
   */
  botFailure?(bot: LocalBotRow, sinceMs: number): Promise<string | null>;
}

export interface BriefCreateDeps {
  creator: BriefCreator;
  read(relPath: string): Promise<string | null>;
  /** The run finished, ready or failed. */
  onfinish?(phase: Extract<BriefCreatePhase, { kind: "ready" | "failed" }>): void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string, err?: unknown) => void;
  /**
   * The bot check and send deadline's timer, apart from the poll timer so a
   * host's poll loop is not shifted by it. Default: setTimeout.
   */
  setDeadline?: (fn: () => void, ms: number) => unknown;
  clearDeadline?: (handle: unknown) => void;
  /** A run file's modified time in ms, when the host can tell; null when absent. Optional. */
  mtime?(relPath: string): Promise<number | null>;
  /** Where the active run id is kept so a reload resumes it. Default: localStorage. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** localStorage key holding the run id while a run is in flight. */
export const ACTIVE_RUN_KEY = "hq.brief.activeRun";
/** The company that run was sent for, kept beside the run id. */
export const ACTIVE_RUN_COMPANY_KEY = "hq.brief.activeRunCompany";

type Finished = Extract<BriefCreatePhase, { kind: "ready" | "failed" }>;

export class BriefCreateRun {
  phase = $state<BriefCreatePhase>({ kind: "idle" });
  /** What the run folder holds, probed while status.json is quiet. */
  files = $state<BriefRunFiles | null>(null);
  /** The company the in-flight run was sent for; samples are kept to it. */
  company = $state<string | null>(null);
  /**
   * Try again was pressed while a stalled run is still being watched: the UI
   * asks "Wait for it?" before sending a second job.
   */
  duplicatePrompt = $state(false);
  private lastProbe = 0;
  /** When a folder probe last saw the run folder change. */
  private folderChangeAt: { runId: string; at: number } | null = null;
  private lastPrint: { runId: string; print: string } | null = null;
  /** A run failed by the stall rule that HQ keeps watching until `until`. */
  private watch: { runId: string; sentAt: number; until: number; phase: Finished } | null = null;
  private watchTimer: unknown = null;
  private blockedBot: LocalBotRow | null = null;
  /** The bot the in-flight job went to, asked whether its turn failed. */
  private sentBot: { runId: string; bot: LocalBotRow; sentAt: number } | null = null;
  private lastFailureCheck = 0;
  private timer: unknown = null;
  private stopped = false;
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (message: string, err?: unknown) => void;
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  private readonly listeners = new Set<(phase: Finished) => void>();

  constructor(private readonly deps: BriefCreateDeps) {
    this.storage = deps.storage !== undefined ? deps.storage : defaultStorage();
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = deps.log ?? ((m, e) => console.warn(`[daily-brief] ${m}`, e ?? ""));
  }

  get busy(): boolean {
    const k = this.phase.kind;
    return k === "dispatching" || k === "waiting" || k === "running";
  }

  /**
   * Check the bot, send the job, start polling. No-op while a run is in
   * flight. The phase flips to `dispatching` synchronously, before any await,
   * so the click paints the sunrise at once; the bot lookup, model check and
   * send happen after that.
   *
   * `wake`: start the assistant first (the blocked check's Start it), wait
   * until a fresh listing shows it running, then send the job in the same
   * motion. One press, one outcome: the brief, or a plain sentence saying
   * why the assistant is not up and what to do instead.
   */
  start(opts: { force?: boolean; wake?: boolean } = {}): Promise<void> {
    if (this.busy) return Promise.resolve();
    if (this.watching && !opts.force) {
      // The last run may still finish: ask before sending a duplicate.
      this.phase = this.watch!.phase;
      this.duplicatePrompt = true;
      return Promise.resolve();
    }
    this.duplicatePrompt = false;
    this.endWatch();
    this.stopped = false;
    const runId = briefRunId(this.now());
    if (opts.wake) {
      const bot = this.blockedBot;
      this.phase = { kind: "dispatching", runId, step: wakeStep(bot ? briefBotLabel(bot) : "your assistant") };
      return this.dispatchWithin(runId, () => this.wakeThenDispatch(runId, bot), BRIEF_WAKE_DISPATCH_TIMEOUT_MS);
    }
    this.phase = { kind: "dispatching", runId };
    return this.dispatchWithin(runId, () => this.dispatch(runId));
  }

  /**
   * The fallback: run the brief in a coding tool instead of the assistant.
   * Same run id, same files, same polling; only the worker differs. Offered
   * wherever the assistant cannot take the job (not running, not here, its
   * start failed), so the person is never left without a way to a brief.
   */
  startInTool(engine: "claude" | "codex" | "grok" = "claude"): Promise<void> {
    if (this.busy || !this.deps.creator.launch) return Promise.resolve();
    this.duplicatePrompt = false;
    this.endWatch();
    this.stopped = false;
    const runId = briefRunId(this.now());
    this.phase = { kind: "dispatching", runId, step: toolStep(engine === "claude" ? BRIEF_FALLBACK_TOOL : engine === "codex" ? "Codex" : "Grok") };
    return this.dispatchWithin(runId, () => this.dispatchToTool(runId, engine));
  }

  /** True when the host can open the brief job in a coding tool. */
  get canLaunch(): boolean {
    return typeof this.deps.creator.launch === "function";
  }

  /**
   * One dispatch, bounded: a bot check or send that never answers ends the run
   * with a plain message instead of leaving "Waking your bot…" up for good.
   */
  private async dispatchWithin(runId: string, work: () => Promise<void>, limitMs: number = BRIEF_DISPATCH_TIMEOUT_MS): Promise<void> {
    let timer: unknown = null;
    const expired = new Promise<"timeout">((resolve) => {
      timer = (this.deps.setDeadline ?? ((fn, ms) => setTimeout(fn, ms)))(() => resolve("timeout"), limitMs);
    });
    const outcome = await Promise.race([work().then(() => "done" as const), expired]);
    if (timer != null) (this.deps.clearDeadline ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(timer);
    if (outcome === "timeout" && !this.stopped && this.phase.kind === "dispatching" && this.phase.runId === runId) {
      this.log("bot check or send did not answer", `${limitMs} ms`);
      this.finish({ kind: "failed", runId: null, message: BRIEF_DISPATCH_TIMEOUT_MESSAGE });
    }
  }

  /**
   * Start the assistant, then poll the listing until it is running (or a
   * different fix is needed), then send. `hq bot start` says "running" the
   * moment launchd is kicked, and a bot that dies on boot keeps that word,
   * so only a check that passes counts as started.
   */
  private async wakeThenDispatch(runId: string, bot: LocalBotRow | null): Promise<void> {
    const { creator } = this.deps;
    let error: string | null;
    try {
      error = await creator.fix("start-bot", bot);
    } catch (err) {
      this.log("bot start failed", err instanceof Error ? err.message : err);
      error = wakeFailedMessage(bot ? briefBotLabel(bot) : "Your assistant", bot?.state);
    }
    if (this.stopped || !this.dispatchingRun(runId)) return;
    if (error) {
      this.finish({ kind: "failed", runId: null, message: error });
      return;
    }
    const started = this.now().getTime();
    let last: LocalBotRow | null = bot;
    for (;;) {
      let check: Awaited<ReturnType<BriefCreator["check"]>>;
      try {
        check = await creator.check();
      } catch (err) {
        this.log("bot check failed", err instanceof Error ? err.message : err);
        this.finish({ kind: "failed", runId: null, message: "Could not check your bot. Try again in a moment." });
        return;
      }
      if (this.stopped || !this.dispatchingRun(runId)) return;
      if (check.ok) {
        await this.send(runId, check.bot);
        return;
      }
      // A different obstacle surfaced (sign-in, model): hand it to the person.
      if (check.fix !== "start-bot") {
        this.blockedBot = check.bot;
        this.phase = { kind: "blocked", message: check.message, fix: check.fix };
        return;
      }
      last = check.bot ?? last;
      if (this.now().getTime() - started >= BRIEF_WAKE_TIMEOUT_MS) {
        this.blockedBot = last;
        this.finish({ kind: "failed", runId: null, message: wakeFailedMessage(last ? briefBotLabel(last) : "Your assistant", last?.state) });
        return;
      }
      await new Promise<void>((resolve) => this.setTimer(resolve, BRIEF_POLL_MS));
      if (this.stopped || !this.dispatchingRun(runId)) return;
    }
  }

  private async dispatch(runId: string): Promise<void> {
    const { creator } = this.deps;
    let check: Awaited<ReturnType<BriefCreator["check"]>>;
    try {
      check = await creator.check();
    } catch (err) {
      this.log("bot check failed", err instanceof Error ? err.message : err);
      this.finish({ kind: "failed", runId: null, message: "Could not check your bot. Try again in a moment." });
      return;
    }
    if (this.stopped || !this.dispatchingRun(runId)) return;
    if (!check.ok) {
      this.blockedBot = check.bot;
      this.phase = { kind: "blocked", message: check.message, fix: check.fix };
      return;
    }
    await this.send(runId, check.bot);
  }

  /**
   * The app's company, when one is open. The brief never needs one: with no
   * company the job is the person's brief across everything they belong to.
   */
  private async activeCompany(): Promise<string | null> {
    try {
      return (await this.deps.creator.company())?.trim() || null;
    } catch (err) {
      this.log("active company read failed", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Send the job to a bot the check passed, then wait for its status file. */
  private async send(runId: string, bot: LocalBotRow): Promise<void> {
    const { creator } = this.deps;
    const company = await this.activeCompany();
    if (this.stopped || !this.dispatchingRun(runId)) return;
    let error: string | null;
    try {
      error = await creator.dispatch(bot, briefJobMessage(runId, company), runId);
    } catch (err) {
      this.log("dispatch failed", err instanceof Error ? err.message : err);
      error = "Could not reach your bot. Try again in a moment.";
    }
    if (!this.dispatchingRun(runId)) return;
    if (error) {
      this.finish({ kind: "failed", runId: null, message: error });
      return;
    }
    this.company = company;
    this.remember(runId);
    this.sentBot = { runId, bot, sentAt: this.now().getTime() };
    this.lastFailureCheck = this.now().getTime();
    const label = briefBotLabel(bot);
    const who = label === "Your assistant" ? "your assistant" : label;
    this.phase = { kind: "waiting", runId, sentAt: this.now().getTime(), ...(who ? { bot: who } : {}) };
    this.schedule();
  }

  /** Open the job in a coding tool, then wait for its status file like any run. */
  private async dispatchToTool(runId: string, engine: "claude" | "codex" | "grok"): Promise<void> {
    const launch = this.deps.creator.launch;
    if (!launch) return;
    const company = await this.activeCompany();
    if (this.stopped || !this.dispatchingRun(runId)) return;
    const tool = engine === "claude" ? BRIEF_FALLBACK_TOOL : engine === "codex" ? "Codex" : "Grok";
    let error: string | null;
    try {
      error = await launch.call(this.deps.creator, engine, briefJobMessage(runId, company));
    } catch (err) {
      this.log("tool launch failed", err instanceof Error ? err.message : err);
      error = `Could not open ${tool}. Try again in a moment.`;
    }
    if (!this.dispatchingRun(runId)) return;
    if (error) {
      this.finish({ kind: "failed", runId: null, message: error });
      return;
    }
    this.company = company;
    this.remember(runId);
    // No bot conversation to ask about a failed turn; the status file speaks.
    this.sentBot = null;
    this.phase = { kind: "waiting", runId, sentAt: this.now().getTime(), bot: tool };
    this.schedule();
  }

  /**
   * Pick up a run that was in flight before this page, window or app started:
   * the remembered run id first, then any `running` entry from index.jsonl.
   * A run whose status is still fresh resumes polling; one that finished
   * meanwhile ends here (ready still notifies). Returns true when it found one.
   */
  async rehydrate(indexRunning: readonly string[] = []): Promise<boolean> {
    if (this.busy || this.phase.kind === "ready") return false;
    const stored = this.storage?.getItem(ACTIVE_RUN_KEY) ?? null;
    const ids = [...new Set([...(stored && isBriefRunId(stored) ? [stored] : []), ...indexRunning])];
    for (const runId of ids) {
      let text: string | null;
      try {
        text = await this.deps.read(briefRunPath(runId, "status.json"));
      } catch (err) {
        this.log("status read failed", err instanceof Error ? err.message : err);
        continue;
      }
      if (this.busy) return true;
      const now = this.now().getTime();
      const status = text != null ? parseBriefStatus(text) : null;
      if (status && status.runId === runId) {
        if (status.state === "ready") {
          this.finish({ kind: "ready", runId });
          return true;
        }
        if (status.state === "failed" || status.state === "cancelled") {
          this.finish({ kind: "failed", runId, message: failedMessage(status) });
          return true;
        }
        const updated = status.updatedAt ? Date.parse(status.updatedAt) : NaN;
        if (Number.isFinite(updated) && now - updated > BRIEF_STALL_TIMEOUT_MS) {
          // Stale, but it may still finish: watch it quietly within the grace window.
          if (runId === stored && now - updated < BRIEF_STALL_TIMEOUT_MS + BRIEF_STALL_GRACE_MS) {
            this.company = status.company ?? this.storage?.getItem(ACTIVE_RUN_COMPANY_KEY) ?? null;
            const phase = advanceBriefRun(
              { kind: "running", runId, sentAt: runIdTime(runId)?.getTime() ?? now, step: status.step, progress: status.progress, lastChangeAt: updated, updatedAt: status.updatedAt },
              { text: null },
              now,
            ) as Finished;
            this.phase = phase;
            this.startWatch(runId, runIdTime(runId)?.getTime() ?? now, phase, updated + BRIEF_STALL_TIMEOUT_MS + BRIEF_STALL_GRACE_MS);
            return true;
          }
          if (runId === stored) this.forget();
          continue;
        }
        this.stopped = false;
        this.company = status.company ?? this.storage?.getItem(ACTIVE_RUN_COMPANY_KEY) ?? null;
        this.remember(runId);
        this.phase = {
          kind: "running",
          runId,
          sentAt: runIdTime(runId)?.getTime() ?? now,
          step: status.step || "Working",
          progress: status.progress,
          lastChangeAt: now,
          updatedAt: status.updatedAt,
          activity: status.activity,
          findings: status.findings,
          samples: status.samples,
        };
        this.schedule();
        return true;
      }
      // Sent but not started yet: wait out the rest of the start window.
      const sentAt = runIdTime(runId)?.getTime() ?? NaN;
      if (runId === stored && Number.isFinite(sentAt) && now - sentAt < BRIEF_START_TIMEOUT_MS) {
        this.stopped = false;
        this.phase = { kind: "waiting", runId, sentAt };
        this.schedule();
        return true;
      }
      if (runId === stored) this.forget();
    }
    return false;
  }

  /** True while `runId` is still the run being dispatched (not timed out or replaced). */
  private dispatchingRun(runId: string): boolean {
    return this.phase.kind === "dispatching" && this.phase.runId === runId;
  }

  /**
   * Ask the bot's conversation whether its turn on the job failed. A failed
   * turn writes no status.json, so without this the page waits out the whole
   * start window for a run that already ended (owner report, 2026-10-16:
   * the assistant's Claude turn failed in under a second).
   */
  private async checkBotFailure(runId: string): Promise<string | null> {
    const sent = this.sentBot;
    const ask = this.deps.creator.botFailure;
    if (!ask || !sent || sent.runId !== runId) return null;
    const nowMs = this.now().getTime();
    if (nowMs - this.lastFailureCheck < BRIEF_BOT_FAILURE_POLL_MS) return null;
    this.lastFailureCheck = nowMs;
    try {
      return await ask.call(this.deps.creator, sent.bot, sent.sentAt);
    } catch (err) {
      this.log("bot failure check failed", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Called with every finished run; returns the unsubscribe. */
  subscribe(fn: (phase: Finished) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private remember(runId: string): void {
    try {
      this.storage?.setItem(ACTIVE_RUN_KEY, runId);
      if (this.company) this.storage?.setItem(ACTIVE_RUN_COMPANY_KEY, this.company);
    } catch (err) {
      this.log("could not remember the active run", err);
    }
  }

  private forget(): void {
    try {
      this.storage?.removeItem(ACTIVE_RUN_KEY);
      this.storage?.removeItem(ACTIVE_RUN_COMPANY_KEY);
    } catch (err) {
      this.log("could not clear the active run", err);
    }
  }

  /**
   * Run the blocked check's fix. Start it starts the assistant and carries
   * straight on into the brief (see `start({ wake: true })`); the other
   * fixes happen elsewhere (a sign-in, a model), so the run goes back to
   * idle for the person to press Create brief again afterwards.
   */
  async fix(): Promise<string | null> {
    if (this.phase.kind !== "blocked") return null;
    if (this.phase.fix === "start-bot") {
      void this.start({ wake: true, force: true });
      return null;
    }
    const error = await this.deps.creator.fix(this.phase.fix, this.blockedBot);
    if (!error) this.phase = { kind: "idle" };
    return error;
  }

  dismiss(): void {
    // A watched stalled run keeps being watched in the background.
    if (!this.busy) this.phase = { kind: "idle" };
    this.duplicatePrompt = false;
  }

  /** Answer to "Wait for it?": go back to following the last run. */
  waitForLast(): void {
    this.duplicatePrompt = false;
    const w = this.watch;
    if (!w) return;
    this.endWatch();
    this.resumeRunning(w.runId, w.sentAt);
  }

  get watching(): boolean {
    return this.watch != null && this.now().getTime() < this.watch.until;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    this.endWatch();
  }

  private resumeRunning(runId: string, sentAt: number): void {
    const now = this.now().getTime();
    this.stopped = false;
    this.remember(runId);
    const prev = this.phase;
    this.phase = {
      kind: "running",
      runId,
      sentAt,
      step: prev.kind === "running" ? prev.step : "Working",
      progress: prev.kind === "running" ? prev.progress : 0.5,
      lastChangeAt: now,
      updatedAt: null,
    };
    this.schedule();
  }

  private startWatch(runId: string, sentAt: number, phase: Finished, until: number): void {
    this.endWatch();
    this.watch = { runId, sentAt, until, phase };
    this.scheduleWatch();
  }

  private endWatch(): void {
    if (this.watchTimer != null) this.clearTimer(this.watchTimer);
    this.watchTimer = null;
    this.watch = null;
  }

  private scheduleWatch(): void {
    this.watchTimer = this.setTimer(() => {
      this.watchTimer = null;
      void this.pollWatch();
    }, BRIEF_WATCH_POLL_MS);
  }

  /** One poll of a stalled run. Exposed for tests; normally driven by the timer. */
  async pollWatch(): Promise<void> {
    const w = this.watch;
    if (!w) return;
    const now = this.now().getTime();
    if (now >= w.until) {
      this.endWatch();
      if (!this.busy) this.forget();
      return;
    }
    let text: string | null = null;
    try {
      text = await this.deps.read(briefRunPath(w.runId, "status.json"));
    } catch (err) {
      this.log("status read failed", err instanceof Error ? err.message : err);
    }
    if (this.watch !== w) return;
    const status = text != null ? parseBriefStatus(text) : null;
    if (status && status.runId === w.runId && status.state === "ready") {
      this.endWatch();
      this.duplicatePrompt = false;
      this.finish({ kind: "ready", runId: w.runId });
      return;
    }
    if (status && status.runId === w.runId && (status.state === "failed" || status.state === "cancelled")) {
      this.endWatch();
      if (!this.busy) this.finish({ kind: "failed", runId: w.runId, message: failedMessage(status) });
      else this.forget();
      return;
    }
    // The folder changed since the stall verdict: the bot is still writing.
    if ((await this.folderChanged(w.runId)) && this.watch === w && !this.busy) {
      this.endWatch();
      this.duplicatePrompt = false;
      this.resumeRunning(w.runId, w.sentAt);
      return;
    }
    if (this.watch === w) this.scheduleWatch();
  }

  /**
   * Fingerprint the run folder; true when it differs from the last probe of
   * the same run. The first probe of a run only records the fingerprint.
   */
  private async folderChanged(runId: string): Promise<boolean> {
    const files = await Promise.all(
      BRIEF_LIVENESS_FILES.map(async (f) => {
        const rel = briefRunPath(runId, f);
        let text: string | null = null;
        let mtime: number | null = null;
        try {
          text = await this.deps.read(rel);
        } catch {
          text = null;
        }
        if (this.deps.mtime) {
          try {
            mtime = await this.deps.mtime(rel);
          } catch {
            mtime = null;
          }
        }
        return { text, mtime };
      }),
    );
    this.files = { briefData: files[1]!.text != null, brief: files[2]!.text != null };
    const print = folderFingerprint(files);
    const prev = this.lastPrint;
    this.lastPrint = { runId, print };
    return prev != null && prev.runId === runId && prev.print !== print;
  }

  /** One poll. Exposed for tests; normally driven by the timer. */
  async poll(): Promise<void> {
    const phase = this.phase;
    if (this.stopped || (phase.kind !== "waiting" && phase.kind !== "running")) return;
    let reading: BriefPollReading;
    try {
      reading = { text: await this.deps.read(briefRunPath(phase.runId, "status.json")) };
    } catch (err) {
      reading = { error: err instanceof Error ? err.message : String(err) };
      this.log("status read failed", reading.error);
    }
    if (this.stopped || this.phase !== phase) return;
    // A bot that said its turn failed: end now, in its words made plain.
    // Only before the run has reported progress; once status.json moves the
    // run speaks for itself.
    const botSaid = phase.kind === "waiting" ? await this.checkBotFailure(phase.runId) : null;
    if (this.stopped || this.phase !== phase) return;
    if (botSaid) {
      this.finish({ kind: "failed", runId: phase.runId, message: botSaid });
      return;
    }
    const nowMs = this.now().getTime();
    const fc = this.folderChangeAt;
    const seen = phase.kind === "running" && fc && fc.runId === phase.runId && fc.at > phase.lastChangeAt ? { ...phase, lastChangeAt: fc.at } : phase;
    const next = advanceBriefRun(seen, reading, nowMs);
    if (next.kind === "running" && nowMs - next.lastChangeAt >= BRIEF_QUIET_MS && nowMs - this.lastProbe >= 15_000) {
      this.lastProbe = nowMs;
      void this.probeFolder(next.runId);
    }
    if (next.kind === "failed" && next.stalled && next.runId) {
      // Soft verdict: show it, but keep watching in case the run finishes.
      this.phase = next;
      this.startWatch(next.runId, phase.sentAt, next, nowMs + BRIEF_STALL_GRACE_MS);
      this.deps.onfinish?.(next);
      for (const fn of this.listeners) fn(next);
      return;
    }
    if (next.kind === "ready" || next.kind === "failed") {
      this.finish(next);
      return;
    }
    this.phase = next;
    this.schedule();
  }

  /**
   * While status.json is quiet: note which files exist (to name the phase)
   * and count any change in the run folder as progress, so a skill that only
   * writes status.json at start and end is not called stalled while it works.
   */
  async probeFolder(runId: string): Promise<void> {
    if (await this.folderChanged(runId)) this.folderChangeAt = { runId, at: this.now().getTime() };
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.poll();
    }, BRIEF_POLL_MS);
  }

  private finish(phase: Finished): void {
    this.phase = phase;
    this.sentBot = null;
    this.forget();
    if (phase.kind === "ready") {
      this.deps.creator.notify("Your daily brief is ready", "Open HQ to read it.");
    }
    this.deps.onfinish?.(phase);
    for (const fn of this.listeners) fn(phase);
  }
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
