/**
 * Brief runs: the files one daily-brief skill run writes and the app reads.
 *
 * Briefs are made on demand, so several can exist per day. Each run has its
 * own folder, `workspace/brief/<run_id>/`, and appends one line to
 * `workspace/brief/index.jsonl` when it ends. Everything here is pure: id and
 * path rules, index and status parsing, the poll state machine, and picking
 * the bot that runs the job. The host does the reads and the dispatch.
 */

import type { LocalBotRow } from "@hq/platform";
import { parseFindings, type BriefFindings } from "./brief-findings.js";

export const BRIEF_ROOT = "workspace/brief";
export const BRIEF_INDEX_PATH = `${BRIEF_ROOT}/index.jsonl`;
export type BriefRunFile = "status.json" | "brief.json" | "brief-data.json" | "housekeeping.json";

const RUN_ID = /^brief-\d{8}-\d{6}$/;
/** The skill's fallback id when the app did not pass one. */
const RUN_ID_UNIX = /^brief-\d{9,11}$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** `brief-YYYYMMDD-HHMMSS` in local time. */
export function briefRunId(now: Date): string {
  return `brief-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Only ids the app or the skill mint; anything else could escape the folder. */
export function isBriefRunId(value: unknown): value is string {
  return typeof value === "string" && (RUN_ID.test(value) || RUN_ID_UNIX.test(value));
}

/** The local time a run id names, or null. */
export function runIdTime(runId: string): Date | null {
  const m = /^brief-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(runId);
  if (m) return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const u = /^brief-(\d{9,11})$/.exec(runId);
  return u ? new Date(Number(u[1]) * 1000) : null;
}

export function briefRunFolder(runId: string): string {
  if (!isBriefRunId(runId)) throw new Error(`not a brief run id: ${runId}`);
  return `${BRIEF_ROOT}/${runId}`;
}

/** HQ-relative path of one file in a run's folder. */
export function briefRunPath(runId: string, file: BriefRunFile): string {
  return `${briefRunFolder(runId)}/${file}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type BriefRunState = "running" | "ready" | "failed";

export interface BriefIndexEntry {
  runId: string;
  createdAt: string;
  window: { from: string; to: string } | null;
  state: BriefRunState;
  catchUp: boolean;
  lead: string;
  counts: { decisions: number; shipped: number; incidents: number };
  headline: string;
  /** Optional run length the skill may record (`duration_s` / `finished_at`). */
  durationMs?: number | null;
  finishedAt?: string | null;
}

function runState(v: unknown): BriefRunState | null {
  return v === "running" || v === "ready" || v === "failed" ? v : null;
}

/**
 * `index.jsonl`, newest first. Bad lines are skipped (and counted), a run
 * listed twice keeps its last line, and entries without a usable time fall
 * back to the time in their id.
 */
export function parseBriefIndex(text: string): { entries: BriefIndexEntry[]; skipped: number } {
  const byId = new Map<string, BriefIndexEntry>();
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const r = rec(raw);
    const runId = str(r.run_id);
    const state = runState(r.state);
    if (!isBriefRunId(runId) || !state) {
      skipped += 1;
      continue;
    }
    let createdAt = str(r.created_at);
    if (!Number.isFinite(Date.parse(createdAt))) createdAt = runIdTime(runId)?.toISOString() ?? "";
    if (!createdAt) {
      skipped += 1;
      continue;
    }
    const w = rec(r.window);
    const c = rec(r.counts);
    byId.set(runId, {
      runId,
      createdAt,
      window: str(w.from) && str(w.to) ? { from: str(w.from), to: str(w.to) } : null,
      state,
      catchUp: r.catch_up === true,
      lead: str(r.lead),
      counts: { decisions: num(c.decisions), shipped: num(c.shipped), incidents: num(c.incidents) },
      headline: str(r.headline),
      durationMs: typeof r.duration_s === "number" && Number.isFinite(r.duration_s) ? r.duration_s * 1000 : null,
      finishedAt: str(r.finished_at) || null,
    });
  }
  const entries = [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { entries, skipped };
}

/** The newest run that finished with a brief. */
export function latestReadyRun(entries: readonly BriefIndexEntry[]): BriefIndexEntry | null {
  return entries.find((e) => e.state === "ready") ?? null;
}

/** Neighbours for prev/next stepping; `older` is further back in time. */
export function stepRun(
  entries: readonly BriefIndexEntry[],
  runId: string | null,
): { older: BriefIndexEntry | null; newer: BriefIndexEntry | null; index: number } {
  const index = runId ? entries.findIndex((e) => e.runId === runId) : -1;
  if (index < 0) return { older: null, newer: null, index };
  return { older: entries[index + 1] ?? null, newer: index > 0 ? entries[index - 1]! : null, index };
}

/** "Just now", "3h ago · 9:14 AM", "Yesterday · 9:14 AM", "Mon, Oct 5 · 9:14 AM". Created time, never "today". */
export function relativeRunLabel(createdAt: string, now: Date): string {
  const t = new Date(createdAt);
  const ms = now.getTime() - t.getTime();
  if (!Number.isFinite(ms)) return "";
  const time = t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (ms < 60_000) return "Just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (t.toDateString() === now.toDateString()) return `${Math.floor(ms / 3_600_000)}h ago · ${time}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return `Yesterday · ${time}`;
  return `${t.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
}

// ── status.json ─────────────────────────────────────────────────────────────

export type BriefActivityState = "running" | "done" | "skipped" | "failed";

/** One line of the run's activity list (status.json `activity`, newest last). */
export interface BriefActivity {
  at: string;
  label: string;
  state: BriefActivityState;
  detail: string | null;
}

/** status.json `activity`; malformed entries dropped, newest last, at most 12. */
export function parseActivity(raw: unknown): BriefActivity[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefActivity[] = [];
  for (const item of raw) {
    const r = rec(item);
    const label = str(r.label);
    const state = r.state;
    if (!label || (state !== "running" && state !== "done" && state !== "skipped" && state !== "failed")) continue;
    out.push({ at: str(r.at), label, state, detail: str(r.detail) || null });
  }
  return out.slice(-12);
}

export interface BriefRunStatus {
  runId: string;
  state: BriefRunState;
  step: string;
  progress: number;
  startedAt: string | null;
  updatedAt: string | null;
  error: string | null;
  sources: Record<string, unknown>;
  housekeeping: Record<string, unknown> | null;
  /** Empty when the skill that wrote it predates the activity list. */
  activity: BriefActivity[];
  /** Counts found so far; null before the first source lands (or an older skill). */
  findings: BriefFindings | null;
  /** status.json `samples`, unfiltered; the UI keeps only the run's company. */
  samples: unknown;
  /** The company the run says it is for, when it says. */
  company: string | null;
}

export function parseBriefStatus(text: string): BriefRunStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = rec(raw);
  const state = runState(r.state);
  const runId = str(r.run_id);
  if (!state || !runId) return null;
  return {
    runId,
    state,
    step: str(r.step),
    progress: Math.min(1, Math.max(0, num(r.progress))),
    startedAt: str(r.started_at) || null,
    updatedAt: str(r.updated_at) || null,
    error: str(r.error) || null,
    sources: rec(r.sources),
    housekeeping: r.housekeeping && typeof r.housekeeping === "object" ? rec(r.housekeeping) : null,
    activity: parseActivity(r.activity),
    findings: parseFindings(r.findings),
    samples: r.samples ?? null,
    company: str(r.company) || null,
  };
}

/**
 * What the Create brief control shows. `waiting` = the job was sent and no
 * status file exists yet; `running` once the bot writes one.
 */
export type BriefCreatePhase =
  | { kind: "idle" }
  | { kind: "blocked"; message: string; fix: BriefBotFix }
  | { kind: "dispatching"; runId: string }
  | { kind: "waiting"; runId: string; sentAt: number }
  | {
      kind: "running";
      runId: string;
      sentAt: number;
      step: string;
      progress: number;
      lastChangeAt: number;
      updatedAt: string | null;
      activity?: BriefActivity[];
      findings?: BriefFindings | null;
      samples?: unknown;
    }
  | { kind: "ready"; runId: string }
  | { kind: "failed"; runId: string | null; message: string };

/** No status file this long after sending: the bot never picked the job up. */
export const BRIEF_START_TIMEOUT_MS = 3 * 60_000;
/** A running status that has not changed this long is treated as stalled. */
export const BRIEF_STALL_TIMEOUT_MS = 10 * 60_000;
export const BRIEF_POLL_MS = 2_000;

/** One poll's reading: the status file text, null when absent, or a read error. */
export type BriefPollReading = { text: string | null } | { error: string };

/**
 * Advance the run by one poll. Pure: `now` is the poll's clock. Only
 * `waiting` and `running` move; every other phase is returned unchanged. A
 * status written for a different run is ignored.
 */
export function advanceBriefRun(phase: BriefCreatePhase, reading: BriefPollReading, now: number): BriefCreatePhase {
  if (phase.kind !== "waiting" && phase.kind !== "running") return phase;
  const { runId, sentAt } = phase;
  const status = "text" in reading && reading.text != null ? parseBriefStatus(reading.text) : null;
  if (status && status.runId === runId) {
    if (status.state === "ready") return { kind: "ready", runId };
    if (status.state === "failed") {
      return { kind: "failed", runId, message: status.error ?? "The brief stopped before it finished." };
    }
    const changed =
      phase.kind !== "running" ||
      phase.step !== status.step ||
      phase.progress !== status.progress ||
      phase.updatedAt !== status.updatedAt;
    const lastChangeAt = changed ? now : phase.lastChangeAt;
    if (now - lastChangeAt > BRIEF_STALL_TIMEOUT_MS) {
      return { kind: "failed", runId, message: `The brief stopped making progress at "${status.step || "a step"}".` };
    }
    return {
      kind: "running",
      runId,
      sentAt,
      step: status.step || "Working",
      progress: status.progress,
      lastChangeAt,
      updatedAt: status.updatedAt,
      activity: status.activity,
      findings: status.findings,
      samples: status.samples,
    };
  }
  // No usable status yet: absent, mid-write, or a read error.
  if (phase.kind === "running") {
    if (now - phase.lastChangeAt > BRIEF_STALL_TIMEOUT_MS) {
      return { kind: "failed", runId, message: "The brief stopped reporting progress." };
    }
    return phase;
  }
  if (now - sentAt > BRIEF_START_TIMEOUT_MS) {
    return { kind: "failed", runId, message: "Your bot did not start the brief. Check that it is running, then try again." };
  }
  return phase;
}

// ── Elapsed, estimate, still working ────────────────────────────────────────

/** status.json unchanged this long: show a calm "Still working on …" line. */
export const BRIEF_QUIET_MS = 90_000;

/** "45s", "2m 14s", "1h 3m". */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * How long a past run took. index.jsonl lines are appended when a run ends,
 * so `duration_s` or `finished_at` when present, else `created_at` against the
 * start time in the run id. Implausible values (under 30 s, over 2 h) are left out.
 */
export function runDurationMs(entry: BriefIndexEntry & { durationMs?: number | null; finishedAt?: string | null }): number | null {
  if (entry.durationMs != null) return entry.durationMs;
  const start = runIdTime(entry.runId)?.getTime();
  const end = Date.parse(entry.finishedAt ?? entry.createdAt);
  if (start == null || !Number.isFinite(end)) return null;
  const ms = end - start;
  return ms >= 30_000 && ms <= 2 * 3_600_000 ? ms : null;
}

/** "usually ~12 min", from the median of two or more past ready runs; else null. */
export function estimateLabel(entries: readonly BriefIndexEntry[]): string | null {
  const ds = entries
    .filter((e) => e.state === "ready")
    .map((e) => runDurationMs(e))
    .filter((d): d is number => d != null)
    .sort((a, b) => a - b);
  if (ds.length < 2) return null;
  const mid = ds.length / 2;
  const median = ds.length % 2 ? ds[Math.floor(mid)]! : (ds[mid - 1]! + ds[mid]!) / 2;
  return `usually ~${Math.max(1, Math.round(median / 60_000))} min`;
}

/** Which files a run has written, for naming the phase when activity is missing. */
export interface BriefRunFiles {
  briefData: boolean;
  brief: boolean;
}

/** The phase the run is in, from the files it has written so far. */
export function phaseFromFiles(files: BriefRunFiles | null, step: string): string {
  if (files?.brief) return "Finishing up";
  if (files?.briefData) return "Writing your brief";
  return step || "your brief";
}

/**
 * The calm line shown when status.json has been quiet for 90 s (until the
 * 10-minute stall rule ends the run). Names the running activity item when
 * there is one, else the phase the run folder shows.
 */
export function stillWorkingLine(
  phase: BriefCreatePhase,
  now: number,
  files: BriefRunFiles | null = null,
): string | null {
  if (phase.kind !== "running" && phase.kind !== "waiting") return null;
  const since = phase.kind === "running" ? phase.lastChangeAt : phase.sentAt;
  if (now - since < BRIEF_QUIET_MS) return null;
  const running = phase.kind === "running" ? [...(phase.activity ?? [])].reverse().find((a) => a.state === "running") : undefined;
  const what = running?.label ?? phaseFromFiles(files, phase.kind === "running" ? phase.step : "Waiting for your bot to start");
  return `Still working on ${what.charAt(0).toLowerCase()}${what.slice(1)}…`;
}

// ── The bot that runs the job ───────────────────────────────────────────────

export type BriefBotFix = "create-bot" | "start-bot" | "sign-in" | "connect-model";

export type BriefBotCheck =
  | { ok: true; bot: LocalBotRow }
  | { ok: false; message: string; fix: BriefBotFix; bot: LocalBotRow | null };

const isSetup = (b: LocalBotRow) => b.workerId === "setup" || b.name === "setup";

/**
 * The main local bot: the setup bot when there is one, else the first
 * personal bot hosted on this computer.
 */
export function pickBriefBot(bots: readonly LocalBotRow[]): LocalBotRow | null {
  const local = bots.filter((b) => (b.hosting ?? "local") === "local");
  return local.find(isSetup) ?? local.find((b) => (b.kind ?? "personal") === "personal") ?? null;
}

/**
 * Can the main bot take the job now? `runtimeReady` is the coding-tool
 * preflight (`{ claude: true, ... }`), null when not read yet; then only the
 * bot's own report counts.
 */
export function checkBriefBot(
  bots: readonly LocalBotRow[],
  runtimeReady: Record<string, boolean> | null,
): BriefBotCheck {
  const bot = pickBriefBot(bots);
  if (!bot) {
    return {
      ok: false,
      bot: null,
      fix: "create-bot",
      message: "Create brief runs on your setup bot, and this computer does not have one yet.",
    };
  }
  const label = bot.displayName?.trim() || bot.name;
  if (bot.runtimeSignIn?.state === "expired") {
    return { ok: false, bot, fix: "sign-in", message: `${label}'s coding tool needs you to sign in again before it can build a brief.` };
  }
  if (runtimeReady && bot.runtime in runtimeReady && runtimeReady[bot.runtime] !== true) {
    return { ok: false, bot, fix: "connect-model", message: `${label} has no model connected on this computer.` };
  }
  if (bot.state !== "running" || !bot.processAlive) {
    return { ok: false, bot, fix: "start-bot", message: `${label} is not running.` };
  }
  return { ok: true, bot };
}

/** Button label for each fix. */
export const BRIEF_FIX_LABEL: Record<BriefBotFix, string> = {
  "create-bot": "Create your setup bot",
  "start-bot": "Start it",
  "sign-in": "Sign in again",
  "connect-model": "Connect a model",
};

/**
 * The job message the bot receives: the skill invocation first so the bot
 * runs it as written, then the run id and company in plain words.
 */
export function briefJobMessage(runId: string, company: string): string {
  const co = company.trim();
  return (
    `/daily-brief ${co} --run-id ${runId}\n\n` +
    `Run the daily-brief skill now with run_id ${runId} for company ${co}. ` +
    `The company is ${co}, the one open in the HQ app; do not pick another company. ` +
    `Write workspace/brief/${runId}/status.json at every step and append workspace/brief/index.jsonl when the run ends.`
  );
}
