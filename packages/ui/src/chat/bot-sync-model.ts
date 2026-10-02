/**
 * The sync widget in a cloud bot's direct message: the pure model.
 *
 * A cloud bot keeps a copy of the company's files on its own computer. While
 * that copy is being brought up to date the conversation shows a slim bar
 * above the message box. This module decides what the bar says. It has two
 * halves:
 *
 *   1. {@link botSyncView} turns a plain "sync facts" object into what the
 *      bar draws. Any source can build those facts: the first download after
 *      a bot is created, a later sync the server reports, or a sync the app
 *      itself asked for.
 *   2. {@link observeBotSync} and {@link advanceBotSync} build the facts from
 *      the one source that exists today, the bot's status answer
 *      (`GET /v1/agents/{uid}/status`).
 *
 * WHAT THE SERVER REPORTS (hq-pro-agents, read 2026-10-02):
 *   - `agent.runtime.firstSync`: `{ phase: "pull" | "push", filesTotal,
 *     filesDone, bytesTotal?, bytesDone?, startedAt, updatedAt }`. Present
 *     while the bot's computer is doing its full download. The computer sends
 *     it once a minute until its own "first sync finished" marker exists; the
 *     server removes it on the first healthy sync report.
 *   - `agent.runtime.syncOkAt`: set once a sync has finished well, refreshed
 *     on every healthy report after that.
 *   - `agent.runtime.firstSyncStartedAt`: when the first download started.
 *   - `agent.runtime.lastHeartbeat.components.sync`: "ok", "degraded",
 *     "failed" or "unknown". The outcome of the last sync run. There is no
 *     "running" value.
 *   - `setupState.steps[]` has a `sync` step: "pending", "running",
 *     "waiting", "failed" or "done".
 * So the bar has real file counts during a full download, and nothing at all
 * for an ordinary later sync on a computer that already has the files.
 */

import { agentChatReadiness } from "./agent-channel.js";

export type BotSyncState = "syncing" | "done" | "failed";

/**
 * Everything known about one bot's sync. A plain object, so any source can
 * build it. Times are milliseconds.
 */
export interface BotSyncFacts {
  state: BotSyncState;
  /** When the sync started. Drives the estimate when there are no real numbers. */
  startedAt: number | null;
  /** When this app saw the sync finish or fail, on this device's clock. */
  endedAt: number | null;
  filesDone: number | null;
  filesTotal: number | null;
  bytesDone?: number | null;
  bytesTotal?: number | null;
  /** A percent the source itself reports (0 to 100). Wins over the counts. */
  percent?: number | null;
  /** Typical duration for this sync, when the source knows better than the default. */
  estimateMs?: number | null;
}

/** What the bar draws. Built by {@link botSyncView}. */
export interface BotSyncView {
  visible: boolean;
  state: BotSyncState;
  title: string;
  detail: string;
  /** 0 to 100, or null when no honest number exists. */
  progress: number | null;
  /** True when `progress` is a guess from elapsed time, not a number the server sent. */
  estimated: boolean;
  /** The percent as words ("31%"), only when it is a real number. */
  amount: string | null;
  /** The counts as words ("128 of 412 files"), only when they are real. */
  counts: string | null;
}

/**
 * Typical time a bot's first download takes. NOT MEASURED: no first download
 * through the new bot flow has been timed yet. Eight minutes is the worked
 * example in the server's status contract (docs/agents/hq-mint-status-contract.md
 * in hq-pro-agents, first sync 18:10:00 to 18:18:19), and it sits inside the
 * server's own allowance for a first sync (SYNC_FIRST_CYCLE_GRACE_MS, twenty
 * minutes). Replace it with a measured median when there is one. It is only
 * used when the server sends no file counts.
 */
export const BOT_SYNC_ESTIMATE_MS = 8 * 60_000;

/** An estimated bar never passes this. Only the server's "done" fills it. */
export const BOT_SYNC_ESTIMATE_HOLD = 90;

/** A bar from real counts holds here until the server says the sync is done. */
export const BOT_SYNC_REAL_HOLD = 99;

/** How long "Files are up to date." stays before the bar goes away. */
export const BOT_SYNC_DONE_VISIBLE_MS = 4_000;

/** How often the open conversation asks the server again. */
export const BOT_SYNC_POLL_MS = 30_000;

/**
 * Progress the server last heard this long ago is not a sync that is running
 * now. The bot's computer reports once a minute and stops sending a snapshot
 * that is over ten minutes old.
 */
export const BOT_SYNC_STALE_MS = 15 * 60_000;

export const BOT_SYNC_TITLE = "Syncing your company's files";
export const BOT_SYNC_DONE_TITLE = "Files are up to date.";
export const BOT_SYNC_FAILED_TITLE = "File sync did not finish";

const HIDDEN: BotSyncView = {
  visible: false,
  state: "done",
  title: "",
  detail: "",
  progress: null,
  estimated: false,
  amount: null,
  counts: null,
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number | null {
  const n = finite(value);
  return n === null || n < 0 ? null : Math.floor(n);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.floor(value)));
}

/** A real percent from what the source sent, or null when it sent no usable number. */
function realPercent(facts: BotSyncFacts): number | null {
  const direct = finite(facts.percent);
  if (direct !== null) return clampPercent(direct);
  const filesTotal = count(facts.filesTotal);
  const filesDone = count(facts.filesDone);
  if (filesTotal !== null && filesTotal > 0 && filesDone !== null) {
    return clampPercent((Math.min(filesDone, filesTotal) / filesTotal) * 100);
  }
  const bytesTotal = count(facts.bytesTotal);
  const bytesDone = count(facts.bytesDone);
  if (bytesTotal !== null && bytesTotal > 0 && bytesDone !== null) {
    return clampPercent((Math.min(bytesDone, bytesTotal) / bytesTotal) * 100);
  }
  return null;
}

/**
 * A guess from elapsed time, the waking screen's approach: it moves quickly
 * at first, slows as it nears the typical duration, and holds below
 * {@link BOT_SYNC_ESTIMATE_HOLD} for as long as the sync keeps running.
 */
export function estimatedSyncProgress(
  startedAt: number,
  now: number,
  estimateMs: number = BOT_SYNC_ESTIMATE_MS,
): number {
  const elapsed = Math.max(0, now - startedAt);
  const typical = Math.max(1, estimateMs);
  const eased = 1 - Math.exp((-2.2 * elapsed) / typical);
  return Math.max(3, Math.min(BOT_SYNC_ESTIMATE_HOLD, Math.round(BOT_SYNC_ESTIMATE_HOLD * eased)));
}

function fileCounts(facts: BotSyncFacts): string | null {
  const total = count(facts.filesTotal);
  const done = count(facts.filesDone);
  if (total === null || total <= 0 || done === null) return null;
  return `${Math.min(done, total).toLocaleString("en-US")} of ${total.toLocaleString("en-US")} files`;
}

/**
 * What the bar draws for these facts at this moment. Pure: same input, same
 * view. With no facts there is no bar.
 */
export function botSyncView(
  facts: BotSyncFacts | null | undefined,
  input: { botName?: string | null; now: number },
): BotSyncView {
  if (!facts) return HIDDEN;
  const bot = input.botName?.trim() || "Your bot";
  if (facts.state === "failed") {
    return {
      visible: true,
      state: "failed",
      title: BOT_SYNC_FAILED_TITLE,
      detail: `${bot} could not finish downloading your company's files.`,
      progress: null,
      estimated: false,
      amount: null,
      counts: null,
    };
  }
  if (facts.state === "done") {
    // A sync that was already finished when the app first looked shows nothing.
    const endedAt = finite(facts.endedAt);
    // A reader whose clock is a moment behind still sees it: never less than zero.
    const elapsed = endedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, input.now - endedAt);
    if (elapsed >= BOT_SYNC_DONE_VISIBLE_MS) return HIDDEN;
    const total = count(facts.filesTotal);
    return {
      visible: true,
      state: "done",
      title: BOT_SYNC_DONE_TITLE,
      detail: total !== null && total > 0 ? `${total.toLocaleString("en-US")} files synced.` : "",
      progress: 100,
      estimated: false,
      amount: null,
      counts: null,
    };
  }
  const detail = `You can chat now. ${bot} will know more as this finishes.`;
  const real = realPercent(facts);
  if (real !== null) {
    const progress = Math.min(BOT_SYNC_REAL_HOLD, real);
    return {
      visible: true,
      state: "syncing",
      title: BOT_SYNC_TITLE,
      detail,
      progress,
      estimated: false,
      amount: `${progress}%`,
      counts: fileCounts(facts),
    };
  }
  const startedAt = finite(facts.startedAt);
  return {
    visible: true,
    state: "syncing",
    title: BOT_SYNC_TITLE,
    detail,
    progress:
      startedAt === null
        ? null
        : estimatedSyncProgress(startedAt, input.now, finite(facts.estimateMs) ?? BOT_SYNC_ESTIMATE_MS),
    estimated: startedAt !== null,
    amount: null,
    counts: null,
  };
}

/** Whether the view changes by itself as time passes, so the bar needs a clock. */
export function botSyncNeedsClock(facts: BotSyncFacts | null | undefined, now: number): boolean {
  if (!facts) return false;
  if (facts.state === "done") return botSyncView(facts, { now }).visible;
  return facts.state === "syncing" && realPercent(facts) === null && finite(facts.startedAt) !== null;
}

// ── Reading the bot's status answer ──────────────────────────────────────

/** What one status answer says about the bot's sync right now. */
export type BotSyncObservation =
  | {
      state: "syncing";
      startedAt: number | null;
      filesDone: number | null;
      filesTotal: number | null;
      bytesDone: number | null;
      bytesTotal: number | null;
    }
  | { state: "done"; filesTotal: number | null }
  /** `first`: the bot has never finished a sync. */
  | { state: "failed"; first: boolean }
  /** The answer says nothing usable about a sync. */
  | { state: "none" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function time(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Read a bot's status answer. Every field may be missing; nothing here
 * throws. `expectFirstSync` is for a bot made in the new bot flow on this
 * device: its first download counts as running from the moment it can chat,
 * even before its computer has reported any progress.
 */
export function observeBotSync(
  payload: unknown,
  now: number,
  options: { expectFirstSync?: boolean } = {},
): BotSyncObservation {
  const root = isRecord(payload) ? payload : null;
  if (!root) return { state: "none" };
  const agent = isRecord(root.agent) ? root.agent : root;
  const runtime = isRecord(agent.runtime) ? agent.runtime : null;
  const setup = isRecord(root.setupState) ? root.setupState : isRecord(agent.setupState) ? agent.setupState : null;
  const readiness = agentChatReadiness(payload);
  const everSynced = time(runtime?.syncOkAt) !== null;

  const live = isRecord(runtime?.firstSync) ? runtime.firstSync : null;
  const liveStartedAt = time(live?.startedAt);
  const liveUpdatedAt = time(live?.updatedAt);
  const liveFresh = live !== null && liveUpdatedAt !== null && now - liveUpdatedAt <= BOT_SYNC_STALE_MS;
  const heartbeat = isRecord(runtime?.lastHeartbeat) ? runtime.lastHeartbeat : null;
  const components = isRecord(heartbeat?.components) ? heartbeat.components : null;
  const lastRunFailed = lower(components?.sync) === "failed";
  const steps = Array.isArray(setup?.steps) ? setup.steps.filter(isRecord) : [];
  const syncStepFailed = steps.some((step) => lower(step.name) === "sync" && lower(step.status) === "failed");

  const syncing = (): BotSyncObservation => ({
    state: "syncing",
    startedAt: liveStartedAt ?? time(runtime?.firstSyncStartedAt),
    filesDone: live ? count(live.filesDone) : null,
    filesTotal: live ? count(live.filesTotal) : null,
    bytesDone: live ? count(live.bytesDone) : null,
    bytesTotal: live ? count(live.bytesTotal) : null,
  });

  if (everSynced) {
    // A sync after the first one: the server only shows it while the bot's
    // computer reports fresh progress (a full download on a rebuilt computer).
    if (liveFresh) return syncing();
    if (lastRunFailed) return { state: "failed", first: false };
    const finalized = isRecord(runtime?.firstSyncFinalized) ? runtime.firstSyncFinalized : null;
    return { state: "done", filesTotal: count(finalized?.totalObjects) };
  }
  // The first download. Setup can fail for a reason that is not the files (the
  // brain sign-in, say): that only counts for a download this app saw running.
  if (syncStepFailed) return { state: "failed", first: true };
  if (readiness.failed) return { state: "failed", first: false };
  if (!readiness.chatReady) return { state: "none" };
  if (!runtime) return { state: "none" };
  if (live || time(runtime.firstSyncStartedAt) !== null || options.expectFirstSync === true) return syncing();
  return { state: "none" };
}

/**
 * Fold one observation into the facts the bar is drawn from. Returns the same
 * object when nothing changed.
 *
 *   - syncing: the bar shows, with the newest counts.
 *   - done: shows "up to date" for a few seconds, but only after a sync this
 *     app saw running (or failing). A bot that was already in sync shows
 *     nothing.
 *   - failed: stays until the next change. A later sync's failure counts only
 *     when this app saw that sync running; a first download's always does.
 *   - none: a sync that was showing stops showing; anything else stays.
 */
export function advanceBotSync(
  previous: BotSyncFacts | null | undefined,
  observation: BotSyncObservation,
  now: number,
): BotSyncFacts | null {
  const prev = previous ?? null;
  if (observation.state === "syncing") {
    const startedAt = observation.startedAt ?? (prev?.state === "syncing" ? prev.startedAt : null) ?? now;
    const next: BotSyncFacts = {
      state: "syncing",
      startedAt,
      endedAt: null,
      filesDone: observation.filesDone,
      filesTotal: observation.filesTotal,
      bytesDone: observation.bytesDone,
      bytesTotal: observation.bytesTotal,
    };
    if (
      prev?.state === "syncing" &&
      prev.startedAt === next.startedAt &&
      prev.filesDone === next.filesDone &&
      prev.filesTotal === next.filesTotal &&
      (prev.bytesDone ?? null) === next.bytesDone &&
      (prev.bytesTotal ?? null) === next.bytesTotal
    ) {
      return prev;
    }
    return next;
  }
  if (observation.state === "done") {
    if (!prev || prev.state === "done") return prev;
    return {
      state: "done",
      startedAt: prev.startedAt,
      endedAt: now,
      filesDone: observation.filesTotal ?? prev.filesTotal,
      filesTotal: observation.filesTotal ?? prev.filesTotal,
    };
  }
  if (observation.state === "failed") {
    if (prev?.state === "failed") return prev;
    if (!observation.first && prev?.state !== "syncing") return prev;
    return {
      state: "failed",
      startedAt: prev?.startedAt ?? null,
      endedAt: now,
      filesDone: prev?.filesDone ?? null,
      filesTotal: prev?.filesTotal ?? null,
    };
  }
  return prev?.state === "syncing" ? null : prev;
}
