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
  BRIEF_DISPATCH_TIMEOUT_MS,
  BRIEF_POLL_MS,
  BRIEF_QUIET_MS,
  BRIEF_STALL_GRACE_MS,
  BRIEF_WATCH_POLL_MS,
  folderFingerprint,
  type BriefRunFiles,
  BRIEF_STALL_TIMEOUT_MS,
  BRIEF_START_TIMEOUT_MS,
  BRIEF_TRY_AGAIN_WAIT_MS,
  failedMessage,
  isSkillNotFound,
  slowStartMessage,
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
  /** Legacy host seam, never consulted by person-scoped dispatch. */
  company?(): string | null | Promise<string | null>;
  /** Fresh bot list and model check. */
  check(): Promise<BriefBotCheck>;
  /**
   * Whether the person belongs to any company: false sends a `--personal`
   * brief, true or null (not known yet) the person brief (`--all`).
   */
  hasCompanies?(): boolean | null | Promise<boolean | null>;
  /**
   * Whether this HQ has the daily-brief skill: false skips the send and goes
   * straight to the slow-start path; "hq-folder" (the HQ folder itself could
   * not be read) shows the slow-start line without sending; null (could not
   * tell) sends anyway and lets the bot report `skill_not_found`.
   */
  skillInstalled?(): Promise<boolean | "hq-folder" | null>;
  /** Send the job to the bot. Resolves to a plain error sentence, or null when sent. */
  dispatch(bot: LocalBotRow, body: string, idempotencyKey: string): Promise<string | null>;
  /** Run the fix for a blocked check. Resolves to a plain error sentence, or null. */
  fix(fix: BriefBotFix, bot: LocalBotRow | null): Promise<string | null>;
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
  /** The job reached the bot; `company` is null for a personal-scope run. */
  onsent?(runId: string, company: string | null): void;
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
/** Removed after any new run so older company-scoped state cannot linger. */
const LEGACY_RUN_COMPANY_KEY = "hq.brief.activeRunCompany";

type Finished = Extract<BriefCreatePhase, { kind: "ready" | "failed" }>;

export class BriefCreateRun {
  phase = $state<BriefCreatePhase>({ kind: "idle" });
  /** What the run folder holds, probed while status.json is quiet. */
  files = $state<BriefRunFiles | null>(null);
  /** Person runs have no single company; retained for older host consumers. */
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
  /**
   * A run HQ keeps watching until `until`: one failed by the stall rule, or
   * (`start`) one that had not started when its start window ended.
   */
  private watch: { runId: string; sentAt: number; until: number; phase: Finished; kind: "stall" | "start" } | null = null;
  /** Try again on a run that never started: wait on that run until `until`, then send a new job. */
  private recheck: { runId: string; until: number } | null = null;
  private watchTimer: unknown = null;
  private blockedBot: LocalBotRow | null = null;
  /** The noun in the slow-start line, set by `start`. */
  private label = "brief";
  /** The automatic retry after a missing skill has been used. */
  private retried = false;
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
   * send happen after that. `label` names the brief in the slow-start line
   * ("welcome brief"); it never changes the job.
   */
  start(opts: { force?: boolean; label?: string } = {}): Promise<void> {
    if (this.busy) return Promise.resolve();
    // Try again on the slow-start line keeps its name ("welcome brief").
    const healing = this.phase.kind === "failed" && this.phase.heal != null;
    const label = opts.label?.trim() || (healing ? this.label : "brief");
    const unstarted = this.unstartedRun();
    if (unstarted && !opts.force) {
      // The first job may still be picked up: look at that run before sending another.
      this.label = label;
      return this.recheckRun(unstarted.runId, unstarted.sentAt);
    }
    if (this.watching && !opts.force) {
      // The last run may still finish: ask before sending a duplicate.
      this.phase = this.watch!.phase;
      this.duplicatePrompt = true;
      return Promise.resolve();
    }
    this.duplicatePrompt = false;
    this.endWatch();
    this.label = label;
    this.retried = false;
    return this.begin();
  }

  /**
   * `dispatch`, bounded: a bot check or send that never answers ends the run
   * with the slow-start line and Try again instead of leaving the starting
   * line up for good.
   */
  private async dispatchWithin(runId: string): Promise<void> {
    let timer: unknown = null;
    const expired = new Promise<"timeout">((resolve) => {
      timer = (this.deps.setDeadline ?? ((fn, ms) => setTimeout(fn, ms)))(() => resolve("timeout"), BRIEF_DISPATCH_TIMEOUT_MS);
    });
    const outcome = await Promise.race([this.dispatch(runId).then(() => "done" as const), expired]);
    if (timer != null) (this.deps.clearDeadline ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(timer);
    if (outcome === "timeout" && !this.stopped && this.phase.kind === "dispatching" && this.phase.runId === runId) {
      this.log("bot check or send did not answer", `${BRIEF_DISPATCH_TIMEOUT_MS} ms`);
      await this.heal(null, "dispatch-timeout");
    }
  }

  /** The sent run that had not started when its start window ended, if HQ still follows it. */
  private unstartedRun(): { runId: string; sentAt: number } | null {
    if (this.watch?.kind === "start" && this.watching) return { runId: this.watch.runId, sentAt: this.watch.sentAt };
    const p = this.phase;
    if (p.kind === "failed" && p.heal === "start-timeout" && p.runId) {
      const sentAt = runIdTime(p.runId)?.getTime() ?? this.now().getTime();
      // Past the start window and the watch after it, that run is not coming: send a new job.
      if (this.now().getTime() - sentAt < BRIEF_START_TIMEOUT_MS + BRIEF_STALL_GRACE_MS) return { runId: p.runId, sentAt };
    }
    return null;
  }

  /**
   * Try again on a run that never started: poll that run at once and keep
   * waiting on it for `BRIEF_TRY_AGAIN_WAIT_MS`. A new job goes out only when
   * the run failed or still has not started by then (see `poll`).
   */
  private recheckRun(runId: string, sentAt: number): Promise<void> {
    this.duplicatePrompt = false;
    this.endWatch();
    this.stopped = false;
    this.recheck = { runId, until: this.now().getTime() + BRIEF_TRY_AGAIN_WAIT_MS };
    this.remember(runId);
    this.phase = { kind: "waiting", runId, sentAt };
    return this.poll();
  }

  private begin(): Promise<void> {
    this.stopped = false;
    this.recheck = null;
    const runId = briefRunId(this.now());
    this.phase = { kind: "dispatching", runId };
    return this.dispatchWithin(runId);
  }

  /**
   * A run that never started: show the one slow-start line with Try again.
   * A missing skill first sends one fresh job by itself (the first run has
   * already ended). A start timeout sends nothing: a busy bot that handles one
   * job at a time may still build the first one, with its welcome edition, so
   * HQ keeps watching that run and follows it if it starts.
   */
  private heal(runId: string | null, why: NonNullable<Extract<BriefCreatePhase, { kind: "failed" }>["heal"]>, sentAt?: number): Promise<void> {
    const retry = why === "skill-not-found" && !this.retried;
    this.log(`brief did not start (${why})${retry ? ", retrying once" : ""}`);
    if (retry) {
      this.retried = true;
      this.forget();
      return this.begin();
    }
    const phase: Finished = { kind: "failed", runId, message: slowStartMessage(this.label), heal: why };
    if (why === "start-timeout" && runId) {
      const now = this.now().getTime();
      this.phase = phase;
      this.startWatch(runId, sentAt ?? now, phase, now + BRIEF_STALL_GRACE_MS, "start");
      this.deps.onfinish?.(phase);
      for (const fn of this.listeners) fn(phase);
      return Promise.resolve();
    }
    this.finish(phase);
    return Promise.resolve();
  }

  private async dispatch(runId: string): Promise<void> {
    const { creator } = this.deps;
    let check: Awaited<ReturnType<BriefCreator["check"]>>;
    try {
      check = await creator.check();
    } catch (err) {
      this.log("bot check failed", err instanceof Error ? err.message : err);
      this.finish({ kind: "failed", runId: null, message: "Could not start your brief. Try again in a moment." });
      return;
    }
    if (this.stopped || !this.dispatchingRun(runId)) return;
    if (!check.ok) {
      this.blockedBot = check.bot;
      this.phase = { kind: "blocked", message: check.message, fix: check.fix };
      return;
    }
    let installed: boolean | "hq-folder" | null = null;
    try {
      installed = (await creator.skillInstalled?.()) ?? null;
    } catch (err) {
      this.log("skill check failed", err instanceof Error ? err.message : err);
    }
    if (this.stopped || !this.dispatchingRun(runId)) return;
    if (installed === "hq-folder") {
      // Not a missing skill: the status reads would fail too, so nothing is sent.
      this.log("could not read the HQ folder, so the brief job was not sent");
      await this.heal(null, "hq-folder");
      return;
    }
    if (installed === false) {
      await this.heal(null, "skill-not-found");
      return;
    }
    let hasCompanies: boolean | null = null;
    try {
      hasCompanies = (await creator.hasCompanies?.()) ?? null;
    } catch (err) {
      this.log("company check failed", err instanceof Error ? err.message : err);
    }
    if (this.stopped || !this.dispatchingRun(runId)) return;
    let error: string | null;
    try {
      error = await creator.dispatch(check.bot, briefJobMessage(runId, { personal: hasCompanies === false }), runId);
    } catch (err) {
      this.log("dispatch failed", err instanceof Error ? err.message : err);
      error = "Could not start your brief. Try again in a moment.";
    }
    if (!this.dispatchingRun(runId)) return;
    if (error) {
      this.finish({ kind: "failed", runId: null, message: error });
      return;
    }
    this.company = null;
    this.remember(runId);
    this.deps.onsent?.(runId, null);
    this.sentBot = { runId, bot: check.bot, sentAt: this.now().getTime() };
    this.lastFailureCheck = this.now().getTime();
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
      const status = text != null ? parseBriefStatus(text, runId) : null;
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
            this.company = null;
            const phase = advanceBriefRun(
              { kind: "running", runId, sentAt: runIdTime(runId)?.getTime() ?? now, step: status.step, progress: status.progress, lastChangeAt: updated, updatedAt: status.updatedAt },
              { text: null },
              now,
            ) as Finished;
            this.phase = phase;
            this.startWatch(runId, runIdTime(runId)?.getTime() ?? now, phase, updated + BRIEF_STALL_TIMEOUT_MS + BRIEF_STALL_GRACE_MS, "stall");
            return true;
          }
          if (runId === stored) this.forget();
          continue;
        }
        this.stopped = false;
        this.company = null;
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
      // Retire legacy company state while remembering the person's run.
      this.storage?.removeItem(LEGACY_RUN_COMPANY_KEY);
    } catch (err) {
      this.log("could not remember the active run", err);
    }
  }

  private forget(): void {
    try {
      this.storage?.removeItem(ACTIVE_RUN_KEY);
      this.storage?.removeItem(LEGACY_RUN_COMPANY_KEY);
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

  private startWatch(runId: string, sentAt: number, phase: Finished, until: number, kind: "stall" | "start"): void {
    this.endWatch();
    this.watch = { runId, sentAt, until, phase, kind };
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
    const status = text != null ? parseBriefStatus(text, w.runId) : null;
    if (status && status.runId === w.runId && status.state === "ready") {
      this.endWatch();
      this.duplicatePrompt = false;
      this.finish({ kind: "ready", runId: w.runId });
      return;
    }
    if (status && status.runId === w.runId && (status.state === "failed" || status.state === "cancelled")) {
      this.endWatch();
      if (this.busy) this.forget();
      else if (w.kind === "start" && isSkillNotFound(status)) await this.heal(w.runId, "skill-not-found");
      else this.finish({ kind: "failed", runId: w.runId, message: failedMessage(status) });
      return;
    }
    if (status && status.runId === w.runId && w.kind === "start") {
      // The first job started after its start window: follow it.
      this.endWatch();
      if (this.busy) return;
      this.stopped = false;
      this.remember(w.runId);
      this.phase = advanceBriefRun({ kind: "waiting", runId: w.runId, sentAt: w.sentAt }, { text }, now);
      this.schedule();
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
    const recheck = this.recheck?.runId === phase.runId ? this.recheck : null;
    // The first run started after Try again: from here it is followed like any run.
    if (recheck && next.kind === "running") this.recheck = null;
    if (recheck && next.kind === "failed" && !next.stalled) {
      if (next.heal === "start-timeout" && nowMs < recheck.until) {
        // Try again is still waiting on the first run.
        this.schedule();
        return;
      }
      // That run failed, or still had not started: send one new job.
      this.log(`brief did not start after Try again (${next.heal ?? "failed"}), sending a new job`);
      this.recheck = null;
      this.forget();
      await this.begin();
      return;
    }
    if (next.kind === "running" && nowMs - next.lastChangeAt >= BRIEF_QUIET_MS && nowMs - this.lastProbe >= 15_000) {
      this.lastProbe = nowMs;
      void this.probeFolder(next.runId);
    }
    if (next.kind === "failed" && next.stalled && next.runId) {
      // Soft verdict: show it, but keep watching in case the run finishes.
      this.phase = next;
      this.startWatch(next.runId, phase.sentAt, next, nowMs + BRIEF_STALL_GRACE_MS, "stall");
      this.deps.onfinish?.(next);
      for (const fn of this.listeners) fn(next);
      return;
    }
    if (next.kind === "failed" && next.heal) {
      await this.heal(next.runId, next.heal, phase.sentAt);
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
