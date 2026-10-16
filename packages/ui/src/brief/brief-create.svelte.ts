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
  BRIEF_POLL_MS,
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
   * The app's active company slug. The job names it when there is one: a bot
   * that belongs to several companies would otherwise pick one itself. With
   * none the job runs in personal scope.
   */
  company(): string | null | Promise<string | null>;
  /** Fresh bot list and model check. */
  check(): Promise<BriefBotCheck>;
  /** Send the job to the bot. Resolves to a plain error sentence, or null when sent. */
  dispatch(bot: LocalBotRow, body: string, idempotencyKey: string): Promise<string | null>;
  /** Run the fix for a blocked check. Resolves to a plain error sentence, or null. */
  fix(fix: BriefBotFix, bot: LocalBotRow | null): Promise<string | null>;
  /** Tell the person the brief is ready (OS banner and/or in-app toast). */
  notify(title: string, body: string): void;
}

export interface BriefCreateDeps {
  creator: BriefCreator;
  read(relPath: string): Promise<string | null>;
  /** The job reached the bot; `company` is null for a personal-scope run. */
  onsent?(runId: string, company: string | null): void;
  /** The run finished, ready or failed. */
  onfinish?(phase: Extract<BriefCreatePhase, { kind: "ready" | "failed" }>): void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string, err?: unknown) => void;
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
   */
  start(opts: { force?: boolean } = {}): Promise<void> {
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
    this.phase = { kind: "dispatching", runId };
    return this.dispatch(runId);
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
    if (this.stopped) return;
    if (!check.ok) {
      this.blockedBot = check.bot;
      this.phase = { kind: "blocked", message: check.message, fix: check.fix };
      return;
    }
    let company: string | null;
    try {
      company = (await creator.company())?.trim() || null;
    } catch (err) {
      this.log("active company read failed", err instanceof Error ? err.message : err);
      company = null;
    }
    if (this.stopped) return;
    let error: string | null;
    try {
      error = await creator.dispatch(check.bot, briefJobMessage(runId, company), runId);
    } catch (err) {
      this.log("dispatch failed", err instanceof Error ? err.message : err);
      error = "Could not reach your bot. Try again in a moment.";
    }
    if (error) {
      this.finish({ kind: "failed", runId: null, message: error });
      return;
    }
    this.company = company;
    this.remember(runId);
    this.deps.onsent?.(runId, company);
    const label = briefBotLabel(check.bot);
    const bot = label === "Your assistant" ? "your assistant" : label;
    this.phase = { kind: "waiting", runId, sentAt: this.now().getTime(), ...(bot ? { bot } : {}) };
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

  /** Called with every finished run; returns the unsubscribe. */
  subscribe(fn: (phase: Finished) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private remember(runId: string): void {
    try {
      this.storage?.setItem(ACTIVE_RUN_KEY, runId);
      if (this.company) this.storage?.setItem(ACTIVE_RUN_COMPANY_KEY, this.company);
      // A personal-scope run must not resume with an earlier run's company.
      else this.storage?.removeItem(ACTIVE_RUN_COMPANY_KEY);
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

  /** Run the blocked check's fix, then go back to idle so the person can retry. */
  async fix(): Promise<string | null> {
    if (this.phase.kind !== "blocked") return null;
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
