/**
 * Create brief: check the main local bot, send it the daily-brief job with a
 * fresh run id, then poll the run's status.json until it is ready or failed.
 * The host supplies the bot seam (`BriefCreator`); the poll logic is the pure
 * `advanceBriefRun` in brief-runs.ts.
 */

import type { LocalBotRow } from "@hq/platform";
import {
  BRIEF_POLL_MS,
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
  /** Company slug the run is bound to; null lets the bot use its session's company. */
  company(): string | null;
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
}

export class BriefCreateRun {
  phase = $state<BriefCreatePhase>({ kind: "idle" });
  private blockedBot: LocalBotRow | null = null;
  private timer: unknown = null;
  private stopped = false;
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (message: string, err?: unknown) => void;

  constructor(private readonly deps: BriefCreateDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = deps.log ?? ((m, e) => console.warn(`[daily-brief] ${m}`, e ?? ""));
  }

  get busy(): boolean {
    const k = this.phase.kind;
    return k === "dispatching" || k === "waiting" || k === "running";
  }

  /** Check the bot, send the job, start polling. No-op while a run is in flight. */
  async start(): Promise<void> {
    if (this.busy) return;
    this.stopped = false;
    const { creator } = this.deps;
    const check = await creator.check();
    if (!check.ok) {
      this.blockedBot = check.bot;
      this.phase = { kind: "blocked", message: check.message, fix: check.fix };
      return;
    }
    const runId = briefRunId(this.now());
    this.phase = { kind: "dispatching", runId };
    let error: string | null;
    try {
      error = await creator.dispatch(check.bot, briefJobMessage(runId, creator.company()), runId);
    } catch (err) {
      this.log("dispatch failed", err instanceof Error ? err.message : err);
      error = "Could not reach your bot. Try again in a moment.";
    }
    if (error) {
      this.finish({ kind: "failed", runId: null, message: error });
      return;
    }
    this.phase = { kind: "waiting", runId, sentAt: this.now().getTime() };
    this.schedule();
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
    const next = advanceBriefRun(phase, reading, this.now().getTime());
    if (next.kind === "ready" || next.kind === "failed") {
      this.finish(next);
      return;
    }
    this.phase = next;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.poll();
    }, BRIEF_POLL_MS);
  }

  private finish(phase: Extract<BriefCreatePhase, { kind: "ready" | "failed" }>): void {
    this.phase = phase;
    if (phase.kind === "ready") {
      this.deps.creator.notify("Your daily brief is ready", "Open HQ to read it.");
    }
    this.deps.onfinish?.(phase);
  }
}
