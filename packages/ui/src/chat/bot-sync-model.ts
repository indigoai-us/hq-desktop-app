/**
 * The sync strip in a cloud bot's direct message: the pure model.
 *
 * A cloud bot keeps a copy of the company's files on its own computer. While
 * that copy is being brought up to date the conversation shows a slim strip
 * under its header. This module decides what the strip says. It has two
 * halves:
 *
 *   1. {@link botSyncView} turns a plain "sync facts" object into what the
 *      strip draws. Any source can build those facts: the first download after
 *      a bot is created, a later sync the server reports, or a sync the app
 *      itself asked for.
 *   2. {@link observeBotSync} and {@link advanceBotSync} build the facts from
 *      the one source that exists today, the bot's status answer
 *      (`GET /v1/agents/{uid}/status`).
 *
 * WHAT THE SERVER REPORTS (hq-pro-agents, read 2026-10-03):
 *   - `agent.runtime.firstSync`: `{ phase: "pull" | "push", filesTotal,
 *     filesDone, bytesTotal?, bytesDone?, startedAt, updatedAt }`. The bot's
 *     computer puts it in its heartbeat only while its sync engine reports
 *     "syncing". When a heartbeat leaves the block out, the server KEEPS the
 *     last copy it had; it only removes the block, and sets `syncOkAt`, on a
 *     heartbeat whose `components.sync` is "ok". So a block whose `updatedAt`
 *     is old is a frozen snapshot, not a sync that is running now. Its counts
 *     must never be shown as live progress.
 *   - `agent.runtime.firstSyncFinalized`: `{ totalObjects, startedAt,
 *     finishedAt }`, written once on the first healthy heartbeat that carries
 *     first-sync evidence. Present means the first download finished.
 *   - `agent.runtime.syncOkAt`: set once a sync has finished well, refreshed
 *     on every healthy report after that.
 *   - `agent.runtime.firstSyncStartedAt`: when the first download started.
 *   - `agent.runtime.lastHeartbeat.at` and `.components.sync`: when the bot's
 *     computer last reported, and the outcome of its last sync run: "ok",
 *     "degraded", "failed" or "unknown". There is no "running" value.
 *   - `setupState.steps[]` has a `sync` step: "pending", "running",
 *     "waiting", "failed" or "done". Under background first sync "done" only
 *     means the sync started, so it says nothing about progress.
 * So the strip has real counts only while the block is fresh and the computer
 * is heartbeating, and no number at all before the first snapshot or for a
 * block that has gone quiet.
 *
 * WHAT THE COUNTS MEAN (hq-cloud-sync, read 2026-10-03): `filesTotal` is the
 * sum of the targets that have emitted their `plan` event. A bot syncs more
 * than one target: its personal files plan and finish in seconds, while the
 * company vault is still being listed. So a fresh snapshot that reads
 * `10 of 10` with no finish signal (no `syncOkAt`, no `firstSyncFinalized`)
 * is not 99 percent: it is "the next target has not been planned yet". The
 * console's setup page handles the same shape (hq-console
 * `src/lib/first-sync-view.ts`, `selectFirstSyncView`: a total of zero with
 * files done renders `running` with `percent: null`, an indeterminate bar and
 * "N so far"). This strip applies that rule to every snapshot whose counts
 * look complete while the sync is not finished: "Preparing.", an empty and
 * still bar, the files so far, and never a percent. A real percent, and a
 * filled bar, appear only while `filesDone < filesTotal`, and they hold below
 * 100 until the server says the sync is done.
 *
 * THE BAR is always determinate: its fill is the real fraction done, or
 * nothing. It never sweeps, shimmers or guesses from elapsed time. When no
 * honest total is known the track shows with no fill and the words carry the
 * state.
 *
 * THE COPY is the same for every sync, first or later: the title names the
 * scope, the status line names the phase and the counts, and nothing says
 * what the bot will know or that the person can chat.
 */

import { agentChatReadiness } from "./agent-channel.js";

/**
 * - syncing: the sync is running, with real counts, or none yet.
 * - stale: the server still holds a progress snapshot but nobody has refreshed
 *   it: the sync is not known to be finished, and no number is honest.
 * - done, failed: the outcome.
 */
export type BotSyncState = "syncing" | "stale" | "done" | "failed";

/** What a live snapshot is doing: pulling files down to the bot, or pushing them up. */
export type BotSyncPhase = "pull" | "push";

/**
 * Whose files the sync is about. It names the title: the company's files, or
 * just "files" for anything else. The bot's status answer is always about the
 * company's vault, so a missing scope means company.
 */
export type BotSyncScope = "company" | "other";

/**
 * Everything known about one bot's sync. A plain object, so any source can
 * build it. Times are milliseconds.
 */
export interface BotSyncFacts {
  state: BotSyncState;
  /** Whose files. Missing means the company's. */
  scope?: BotSyncScope | null;
  /** When the sync started. */
  startedAt: number | null;
  /** When this app saw the sync finish or fail, on this device's clock. */
  endedAt: number | null;
  filesDone: number | null;
  filesTotal: number | null;
  bytesDone?: number | null;
  bytesTotal?: number | null;
  /** A percent the source itself reports (0 to 100). Wins over the counts. */
  percent?: number | null;
  /** The phase of a live snapshot, named in the copy. */
  phase?: BotSyncPhase | null;
}

/** What the strip draws. Built by {@link botSyncView}. */
export interface BotSyncView {
  visible: boolean;
  state: BotSyncState;
  title: string;
  detail: string;
  /**
   * The whole percent, 0 to 100, for the progress bar's value; null when no
   * honest number exists.
   */
  progress: number | null;
  /**
   * How much of the bar is filled, 0 to 100, unrounded, so a sync that has
   * barely started shows a sliver. Zero when no honest number exists: the
   * track shows with no fill, and nothing moves.
   */
  fill: number;
  /** The percent as words ("31%", "<1%"), only when it is a real number. */
  amount: string | null;
  /**
   * The counts as words, only when they are real: "128 of 412 files" with a
   * real percent, "10 files so far" while the next part is being prepared.
   */
  counts: string | null;
}

/**
 * A bar from live counts holds here until the server says the sync is done.
 * It only matters for a source that reports its own percent: a file or byte
 * percent is only shown while done is below total, which is already below 100.
 */
export const BOT_SYNC_REAL_HOLD = 99;

/** How long "Files are up to date." stays before the strip goes away. */
export const BOT_SYNC_DONE_VISIBLE_MS = 4_000;

/** How often the open conversation asks the server again. */
export const BOT_SYNC_POLL_MS = 30_000;

/**
 * A snapshot refreshed longer ago than this is not live. The bot's computer
 * reports once a minute while it is syncing; ten minutes without an update
 * means it stopped sending the block and the server kept the old copy.
 */
export const BOT_SYNC_STALE_MS = 10 * 60_000;

/**
 * A heartbeat older than this means the bot's computer is not reporting now:
 * neither its snapshot nor its last sync outcome describe the present.
 */
export const BOT_SYNC_HEARTBEAT_FRESH_MS = 5 * 60_000;

export const BOT_SYNC_TITLE = "Syncing your company's files";
/** The title when the sync is not about the company's files. */
export const BOT_SYNC_FILES_TITLE = "Syncing files";
export const BOT_SYNC_STALE_TITLE = "Still syncing.";
export const BOT_SYNC_DONE_TITLE = "Files are up to date.";
export const BOT_SYNC_FAILED_TITLE = "Sync hit a problem.";
/** The status line while the server has reported no countable progress yet. */
export const BOT_SYNC_PREPARING = "Preparing.";

const HIDDEN: BotSyncView = {
  visible: false,
  state: "done",
  title: "",
  detail: "",
  progress: null,
  fill: 0,
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
  return Math.max(0, Math.min(100, value));
}

/**
 * What the source's numbers say about a running sync:
 *
 *   - "partial": a real percent (unrounded), below 100, from counts that are
 *     still short of their total.
 *   - "complete": the counts have reached their total (or the source says
 *     100 percent) while the sync is not finished. The total only covers
 *     what has been planned so far, so this is the gap before the next part
 *     is planned: no percent is honest. The console's setup page shows the
 *     same shape with no percent (hq-console `src/lib/first-sync-view.ts`,
 *     `selectFirstSyncView`, the `filesTotal === 0` branch).
 *     A total of zero is the same gap (the console's `starting` shape when
 *     nothing is done yet): the server has reported, and planned nothing.
 *   - null: the source sent no counts at all.
 *
 * A percent the source states wins; then bytes, which move evenly; then file
 * counts. A number that is still moving wins over one at its total.
 */
type BotSyncMeasure = { kind: "partial"; percent: number } | { kind: "complete" };

function measureOf(done: number | null, total: number | null): BotSyncMeasure | null {
  if (total === null || done === null) return null;
  if (total <= 0 || done >= total) return { kind: "complete" };
  return { kind: "partial", percent: clampPercent((done / total) * 100) };
}

function measure(facts: BotSyncFacts): BotSyncMeasure | null {
  const direct = finite(facts.percent);
  if (direct !== null) return direct >= 100 ? { kind: "complete" } : { kind: "partial", percent: clampPercent(direct) };
  const bytes = measureOf(count(facts.bytesDone), count(facts.bytesTotal));
  const files = measureOf(count(facts.filesDone), count(facts.filesTotal));
  // A number that is still moving wins over one that has reached its total.
  if (bytes?.kind === "partial") return bytes;
  if (files?.kind === "partial") return files;
  return bytes ?? files;
}

/** A real percent as words: "<1%" for a sync that has barely started, else the whole percent. */
function percentWords(exact: number): string {
  return exact > 0 && exact < 1 ? "<1%" : `${Math.floor(exact)}%`;
}

const number = (n: number): string => n.toLocaleString("en-US");

/** "128 of 412 files", only while the counts are short of their total. */
function fileCounts(facts: BotSyncFacts): string | null {
  const total = count(facts.filesTotal);
  const done = count(facts.filesDone);
  if (total === null || total <= 0 || done === null || done >= total) return null;
  return `${number(done)} of ${number(total)} files`;
}

/** "10 files so far", for counts that say how much is done but not how much is left. */
function filesSoFar(facts: BotSyncFacts): string | null {
  const done = count(facts.filesDone);
  if (done === null || done <= 0) return null;
  return `${number(done)} ${done === 1 ? "file" : "files"} so far`;
}

/** The phase as the words the status line uses. */
function phaseWords(phase: BotSyncPhase | null | undefined): string | null {
  if (phase === "pull") return "Pulling files down.";
  if (phase === "push") return "Pushing files up.";
  return null;
}

/** The status line: the parts that are known, in order, one space apart. */
const line = (...parts: Array<string | null>): string => parts.filter((part): part is string => part !== null).join(" ");

function titleFor(facts: BotSyncFacts): string {
  return facts.scope === "other" ? BOT_SYNC_FILES_TITLE : BOT_SYNC_TITLE;
}

/**
 * What the strip draws for these facts at this moment. Pure: same input, same
 * view. With no facts there is no strip. The copy never names the bot:
 * `botName` is accepted so callers from before need not change, and ignored.
 */
export function botSyncView(
  facts: BotSyncFacts | null | undefined,
  input: { botName?: string | null; now: number },
): BotSyncView {
  if (!facts) return HIDDEN;
  if (facts.state === "failed") {
    return {
      visible: true,
      state: "failed",
      title: BOT_SYNC_FAILED_TITLE,
      detail: "",
      progress: null,
      fill: 0,
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
      detail: total !== null && total > 0 ? `${number(total)} files synced.` : "",
      progress: 100,
      fill: 100,
      amount: null,
      counts: null,
    };
  }
  if (facts.state === "stale") {
    // The server holds a snapshot nobody has refreshed. Whatever counts it
    // carries are frozen, so no number is shown, whatever the facts say.
    return {
      visible: true,
      state: "stale",
      title: BOT_SYNC_STALE_TITLE,
      detail: "",
      progress: null,
      fill: 0,
      amount: null,
      counts: null,
    };
  }
  const title = titleFor(facts);
  const measured = measure(facts);
  if (measured?.kind === "partial") {
    const exact = Math.min(BOT_SYNC_REAL_HOLD, measured.percent);
    const counts = fileCounts(facts);
    return {
      visible: true,
      state: "syncing",
      title,
      detail: line(phaseWords(facts.phase), counts),
      progress: Math.floor(exact),
      fill: exact,
      amount: percentWords(exact),
      counts,
    };
  }
  if (measured?.kind === "complete") {
    // Everything planned so far is done and the sync is not finished: the
    // next part is being planned. The files so far, no percent, an empty bar.
    const counts = filesSoFar(facts);
    return {
      visible: true,
      state: "syncing",
      title,
      detail: line(BOT_SYNC_PREPARING, counts),
      progress: null,
      fill: 0,
      amount: null,
      counts,
    };
  }
  // No snapshot yet: no number, an empty bar, and the words.
  return {
    visible: true,
    state: "syncing",
    title,
    detail: BOT_SYNC_PREPARING,
    progress: null,
    fill: 0,
    amount: null,
    counts: null,
  };
}

/**
 * Whether the view changes by itself as time passes, so the strip needs a
 * clock. Only "up to date" does: it goes away after a few seconds.
 */
export function botSyncNeedsClock(facts: BotSyncFacts | null | undefined, now: number): boolean {
  if (!facts || facts.state !== "done") return false;
  return botSyncView(facts, { now }).visible;
}

// ── Reading the bot's status answer ──────────────────────────────────────

/** What one status answer says about the bot's sync right now. */
export type BotSyncObservation =
  | {
      state: "syncing";
      startedAt: number | null;
      /** Null before the first snapshot. */
      phase: BotSyncPhase | null;
      filesDone: number | null;
      filesTotal: number | null;
      bytesDone: number | null;
      bytesTotal: number | null;
    }
  /** A snapshot the server still holds, that nobody has refreshed. */
  | { state: "stale"; startedAt: number | null }
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

function phaseOf(value: unknown): BotSyncPhase | null {
  const word = lower(value);
  return word === "pull" || word === "push" ? word : null;
}

/**
 * Read a bot's status answer. Every field may be missing; nothing here
 * throws. `expectFirstSync` is for a bot made in the new bot flow on this
 * device: its first download counts as running from the moment it can chat,
 * even before its computer has reported any progress.
 *
 * The order of the checks is the rule:
 *   1. Finished: `firstSyncFinalized` present, or `syncOkAt` set with no
 *      snapshot left, or a fresh heartbeat whose last sync run is "ok".
 *   2. The setup's sync step failed: a failed first download.
 *   3. Not yet able to chat, or no runtime: nothing to say.
 *   4. A snapshot refreshed within {@link BOT_SYNC_STALE_MS} on a computer
 *      that heartbeated within {@link BOT_SYNC_HEARTBEAT_FRESH_MS}: live,
 *      with its counts.
 *   5. A fresh heartbeat whose last sync run is "failed": failed.
 *   6. A snapshot that is present but not live: stale, with no counts.
 *   7. No snapshot yet, but the download has started or is expected:
 *      syncing, with no counts.
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

  const snapshot = isRecord(runtime?.firstSync) ? runtime.firstSync : null;
  const finalized = isRecord(runtime?.firstSyncFinalized) ? runtime.firstSyncFinalized : null;
  const syncOkAt = time(runtime?.syncOkAt);
  const heartbeat = isRecord(runtime?.lastHeartbeat) ? runtime.lastHeartbeat : null;
  const heartbeatAt = time(heartbeat?.at);
  // A heartbeat stamped a little ahead of this clock is fresh too.
  const heartbeatFresh = heartbeatAt !== null && now - heartbeatAt < BOT_SYNC_HEARTBEAT_FRESH_MS;
  const components = isRecord(heartbeat?.components) ? heartbeat.components : null;
  const lastRun = lower(components?.sync);
  const steps = Array.isArray(setup?.steps) ? setup.steps.filter(isRecord) : [];
  const syncStepFailed = steps.some((step) => lower(step.name) === "sync" && lower(step.status) === "failed");
  const startedAt = time(snapshot?.startedAt) ?? time(runtime?.firstSyncStartedAt);

  // 1. Finished.
  if (finalized !== null || (syncOkAt !== null && snapshot === null) || (heartbeatFresh && lastRun === "ok")) {
    return { state: "done", filesTotal: count(finalized?.totalObjects) };
  }
  // 2. The files step itself failed. Setup can fail for another reason (the
  //    brain sign-in, say): that only counts for a download this app saw running.
  if (syncStepFailed) return { state: "failed", first: true };
  if (readiness.failed) return { state: "failed", first: false };
  // 3. Nothing to say yet.
  if (!readiness.chatReady) return { state: "none" };
  if (!runtime) return { state: "none" };
  const runFailed = heartbeatFresh && lastRun === "failed";
  if (snapshot) {
    const updatedAt = time(snapshot.updatedAt);
    const snapshotFresh = updatedAt !== null && now - updatedAt <= BOT_SYNC_STALE_MS;
    // 4. Live.
    if (snapshotFresh && heartbeatFresh) {
      return {
        state: "syncing",
        startedAt,
        phase: phaseOf(snapshot.phase),
        filesDone: count(snapshot.filesDone),
        filesTotal: count(snapshot.filesTotal),
        bytesDone: count(snapshot.bytesDone),
        bytesTotal: count(snapshot.bytesTotal),
      };
    }
    // 5. Failed.
    if (runFailed) return { state: "failed", first: syncOkAt === null };
    // 6. Stale: the server kept a snapshot the computer stopped refreshing.
    return { state: "stale", startedAt };
  }
  if (runFailed) return { state: "failed", first: syncOkAt === null };
  // 7. Before the first snapshot.
  if (startedAt !== null || options.expectFirstSync === true) {
    return { state: "syncing", startedAt, phase: null, filesDone: null, filesTotal: null, bytesDone: null, bytesTotal: null };
  }
  return { state: "none" };
}

/** True for the states that mean a strip is showing a sync in progress. */
function inProgress(facts: BotSyncFacts | null): facts is BotSyncFacts {
  return facts?.state === "syncing" || facts?.state === "stale";
}

/**
 * Fold one observation into the facts the strip is drawn from. Returns the
 * same object when nothing changed.
 *
 *   - syncing: the strip shows, with the newest counts.
 *   - stale: the strip shows with no number. Counts from before are dropped,
 *     so a frozen snapshot never reads as progress.
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
    const startedAt = observation.startedAt ?? (inProgress(prev) ? prev.startedAt : null) ?? now;
    const next: BotSyncFacts = {
      state: "syncing",
      startedAt,
      endedAt: null,
      filesDone: observation.filesDone,
      filesTotal: observation.filesTotal,
      bytesDone: observation.bytesDone,
      bytesTotal: observation.bytesTotal,
      phase: observation.phase,
    };
    if (
      prev?.state === "syncing" &&
      prev.startedAt === next.startedAt &&
      prev.filesDone === next.filesDone &&
      prev.filesTotal === next.filesTotal &&
      (prev.bytesDone ?? null) === next.bytesDone &&
      (prev.bytesTotal ?? null) === next.bytesTotal &&
      (prev.phase ?? null) === next.phase
    ) {
      return prev;
    }
    return next;
  }
  if (observation.state === "stale") {
    const startedAt = observation.startedAt ?? (inProgress(prev) ? prev.startedAt : null);
    if (prev?.state === "stale" && prev.startedAt === startedAt) return prev;
    return { state: "stale", startedAt, endedAt: null, filesDone: null, filesTotal: null };
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
    if (!observation.first && !inProgress(prev)) return prev;
    return {
      state: "failed",
      startedAt: prev?.startedAt ?? null,
      endedAt: now,
      filesDone: prev?.filesDone ?? null,
      filesTotal: prev?.filesTotal ?? null,
    };
  }
  return inProgress(prev) ? null : prev;
}
