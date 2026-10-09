/**
 * Create brief: check the main local bot, send it the daily-brief job with a
 * fresh run id, then poll the run's status.json until it is ready or failed.
 * The host supplies the bot seam (`BriefCreator`); the poll logic is the pure
 * `advanceBriefRun` in brief-runs.ts.
 */

import type { LocalBotRow } from "@hq/platform";
import {
  BRIEF_POLL_MS,
  BRIEF_QUIET_MS,
  type BriefRunFiles,
  BRIEF_STALL_TIMEOUT_MS,
  BRIEF_START_TIMEOUT_MS,
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
  /** Tell the person the brief is ready (OS banner and/or in-app toast). */
  notify(title: string, body: string): void;
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
  /** Where the active run id is kept so a reload resumes it. Default: localStorage. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** localStorage key holding the run id while a run is in flight. */
export const ACTIVE_RUN_KEY = "hq.brief.activeRun";

type Finished = Extract<BriefCreatePhase, { kind: "ready" | "failed" }>;

export class BriefCreateRun {
  phase = $state<BriefCreatePhase>({ kind: "idle" });
  /** What the run folder holds, probed while status.json is quiet. */
  files = $state<BriefRunFiles | null>(null);
  private lastProbe = 0;
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
  start(): Promise<void> {
    if (this.busy) return Promise.resolve();
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
    if (!company) {
      this.finish({ kind: "failed", runId: null, message: "Open a company first, then create the brief." });
      return;
    }
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
    this.remember(runId);
    this.phase = { kind: "waiting", runId, sentAt: this.now().getTime() };
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
        if (status.state === "failed") {
          this.finish({ kind: "failed", runId, message: status.error ?? "The brief stopped before it finished." });
          return true;
        }
        const updated = status.updatedAt ? Date.parse(status.updatedAt) : NaN;
        if (Number.isFinite(updated) && now - updated > BRIEF_STALL_TIMEOUT_MS) {
          if (runId === stored) this.forget();
          continue;
        }
        this.stopped = false;
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
    } catch (err) {
      this.log("could not remember the active run", err);
    }
  }

  private forget(): void {
    try {
      this.storage?.removeItem(ACTIVE_RUN_KEY);
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
    if (!this.busy) this.phase = { kind: "idle" };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
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
    const next = advanceBriefRun(phase, reading, nowMs);
    if (next.kind === "running" && nowMs - next.lastChangeAt >= BRIEF_QUIET_MS && nowMs - this.lastProbe >= 15_000) {
      this.lastProbe = nowMs;
      void this.probeFiles(next.runId);
    }
    if (next.kind === "ready" || next.kind === "failed") {
      this.finish(next);
      return;
    }
    this.phase = next;
    this.schedule();
  }

  /** Which run files exist, so a quiet run can name its phase. */
  private async probeFiles(runId: string): Promise<void> {
    const has = async (file: "brief-data.json" | "brief.json") => {
      try {
        return (await this.deps.read(briefRunPath(runId, file))) != null;
      } catch {
        return false;
      }
    };
    const [briefData, brief] = await Promise.all([has("brief-data.json"), has("brief.json")]);
    this.files = { briefData, brief };
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
