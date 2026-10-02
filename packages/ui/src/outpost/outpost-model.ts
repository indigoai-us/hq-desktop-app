/**
 * Personal Outpost (console-rail US-034).
 *
 * Jobs, runs, logs, and settings paint from a cache. Alerts are DM or none.
 * Custom cadence is a five-field cron expression, validated before save, with
 * the next five runs previewed. Logs append incrementally and paint a window.
 */

export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export type OutpostTab = "overview" | "jobs" | "runs" | "logs" | "settings";
export type JobAlert = "dm" | "none";
export type JobCadence = "hourly" | "daily" | "weekdays" | "weekly" | "custom";
export type JobRunMode = "prompt" | "skill";
export type RunStatus = "ok" | "failed" | "running" | "pending_probe";
export type LogLevel = "info" | "warn" | "err";

export const JOB_ALERTS: readonly JobAlert[] = ["dm", "none"];

export function clampJobAlert(value: string): JobAlert {
  return value === "dm" || value === "on fail" || value === "always" ? "dm" : "none";
}

export interface OutpostHost {
  name: string;
  hostname: string;
  region: string;
  instance: string;
  online: boolean;
  heartbeatAgo: string;
  lastHeartbeatAt: string;
  /** Absolute time of the box's latest report to hq-pro (ISO). */
  lastHeartbeatIso?: string;
  uptime: string;
  cpuPct: number;
  memUsed: string;
  memTotal: string;
  diskUsed: string;
  diskTotal: string;
  version: string;
  identity: string;
}

export interface OutpostJob {
  id: string;
  name: string;
  detail: string;
  runtime: "Claude" | "Codex";
  cadence: JobCadence;
  cadenceLabel: string;
  cron: string;
  timezone: string;
  nextRun: string;
  /** Absolute next run (ISO). When set, the label re-renders from it (QA-069). */
  nextRunAt?: string;
  lastResult: string;
  /** Absolute time of the last run (ISO). */
  lastRunAt?: string;
  /** Rest of the last-result label after the age, e.g. "3 in a row" or "38s". */
  lastResultNote?: string;
  status: RunStatus;
  paused: boolean;
  alert: JobAlert;
  alertWhen: "on fail" | "always";
  mode: JobRunMode;
  prompt: string;
  skill: string;
  args: string;
  secretNames: string[];
}

export interface OutpostRun {
  id: string;
  jobId: string;
  job: string;
  when: string;
  /** Absolute run start (ISO). When set, `when` is recomputed from it. */
  at?: string;
  detail: string;
  status: RunStatus;
}

export interface LogLine {
  id: string;
  t: string;
  level: LogLevel;
  job: string;
  message: string;
}

export interface OutpostCache {
  /** true = the account has an Outpost; false = none; null = not read yet. */
  provisioned: boolean | null;
  host: OutpostHost;
  jobs: OutpostJob[];
  runs: OutpostRun[];
  logs: LogLine[];
  unreachable: boolean;
  retryInSec: number;
  retryAttempt: number;
  /** When this data last came from the Outpost (ISO). null = never refreshed. */
  fetchedAt: string | null;
}

/** Reads the current state from the Outpost. Rejects when it cannot. */
export type OutpostRefresher = () => Promise<OutpostCache>;

/** Refresh cadence while the page is visible (QA-069). */
export const OUTPOST_REFRESH_MS = 60_000;

/** A single Outpost read settles within this bound or counts as failed (QA-084). */
export const OUTPOST_READ_TIMEOUT_MS = 10_000;

/** Reject when `work` has not settled within `ms`, so a hung read cannot pin the loading state. */
export function withReadTimeout<T>(work: Promise<T>, ms: number = OUTPOST_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`outpost read timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** "19m ago" from an absolute ISO time. Empty when unreadable. */
export function agoLabel(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "in 33m" from an absolute ISO time. "due" once it has passed. */
export function untilLabel(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return "due";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export function nextRunLabel(job: OutpostJob, now: number): string {
  if (job.paused) return "paused";
  return untilLabel(job.nextRunAt, now) || job.nextRun;
}

export function lastResultLabel(job: OutpostJob, now: number): string {
  const age = agoLabel(job.lastRunAt, now);
  if (!age) return job.lastResult;
  return [job.status, age, job.lastResultNote].filter(Boolean).join(" · ");
}

export function runWhenLabel(run: OutpostRun, now: number): string {
  return agoLabel(run.at, now) || run.when;
}

/** Header freshness line: "Updated 2m ago", or the stale state after a failed refresh. */
export function freshnessLabel(fetchedAt: string | null, refreshFailed: boolean, now: number): string {
  const age = agoLabel(fetchedAt ?? undefined, now);
  if (refreshFailed) return age ? `Couldn't refresh · showing data from ${age}` : "Couldn't refresh · showing saved data";
  return age ? `Updated ${age}` : "Refreshing…";
}

const caches = new Map<string, OutpostCache>();

export function readOutpostCache(owner: string): OutpostCache | null {
  return caches.get(owner) ?? null;
}

export function writeOutpostCache(owner: string, value: OutpostCache): void {
  if (owner) caches.set(owner, value);
}

export function clearOutpostCache(owner: string): void {
  caches.delete(owner);
}

/**
 * An empty job for the New job sheet (QA-053): fresh id, blank name and
 * prompt, the default hourly cadence, and DM alerts on failure.
 */
export function blankJob(id = `job-${Date.now().toString(36)}`): OutpostJob {
  return {
    id,
    name: "",
    detail: "",
    runtime: "Claude",
    cadence: "hourly",
    cadenceLabel: "hourly",
    cron: presetCron("hourly"),
    timezone: "",
    nextRun: "",
    lastResult: "",
    status: "ok",
    paused: false,
    alert: "dm",
    alertWhen: "on fail",
    mode: "prompt",
    prompt: "",
    skill: "",
    args: "",
    secretNames: [],
  };
}

export function alertLabel(alert: JobAlert, when: OutpostJob["alertWhen"]): string {
  return alert === "none" ? "none" : `dm · ${when}`;
}

export function filterJobs(jobs: readonly OutpostJob[], tab: "all" | "active" | "paused" | "failing"): OutpostJob[] {
  if (tab === "paused") return jobs.filter((j) => j.paused);
  if (tab === "active") return jobs.filter((j) => !j.paused);
  if (tab === "failing") return jobs.filter((j) => j.status === "failed");
  return [...jobs];
}

export function filterRuns(runs: readonly OutpostRun[], tab: "all" | "ok" | "failed" | "running"): OutpostRun[] {
  if (tab === "all") return [...runs];
  return runs.filter((r) => r.status === tab);
}

/** Append only lines whose id is not already in the tail. */
export function appendLogTail(existing: readonly LogLine[], incoming: readonly LogLine[]): LogLine[] {
  const seen = new Set(existing.map((line) => line.id));
  const added = incoming.filter((line) => !seen.has(line.id));
  return added.length === 0 ? [...existing] : [...existing, ...added];
}

export interface LogWindow {
  start: number;
  end: number;
  offsetPx: number;
  heightPx: number;
}

/** Paint only the rows that intersect the viewport, plus a small overscan. */
export function visibleLogWindow(
  count: number,
  scrollTop: number,
  viewportPx: number,
  rowPx = 22,
  overscan = 4,
): LogWindow {
  const heightPx = Math.max(0, count) * rowPx;
  if (count <= 0) return { start: 0, end: 0, offsetPx: 0, heightPx: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowPx) - overscan);
  const visible = Math.ceil(viewportPx / rowPx) + overscan * 2;
  const end = Math.min(count, start + visible);
  return { start, end, offsetPx: start * rowPx, heightPx };
}

export function formatRetry(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function offlineBanner(cache: OutpostCache): string {
  return `Host unreachable. No heartbeat since ${cache.host.lastHeartbeatAt}. Retrying in ${formatRetry(cache.retryInSec)} · attempt ${cache.retryAttempt}`;
}

type CronParts = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

function expandField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const stepSplit = part.split("/");
    if (stepSplit.length > 2) return null;
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    const base = stepSplit[0] === "" ? "*" : stepSplit[0];
    let from = min;
    let to = max;
    if (base !== "*") {
      const range = base.split("-");
      if (range.length > 2) return null;
      from = Number(range[0]);
      to = range.length === 2 ? Number(range[1]) : stepSplit.length === 2 ? max : from;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return null;
    }
    for (let n = from; n <= to; n += step) out.add(n);
    if (out.size === 0) return null;
  }
  return out;
}

export function parseCron(expr: string): CronParts | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const parts: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const set = expandField(fields[i], ranges[i][0], ranges[i][1]);
    if (!set) return null;
    parts.push(set);
  }
  return parts as CronParts;
}

export interface CronPreview {
  ok: boolean;
  error: string;
  next: Date[];
}

/** Next `count` UTC instants at or after `from`. Weekday is JS getUTCDay (0 = Sunday). */
export function previewCron(expr: string, from: Date, count = 5): CronPreview {
  const parts = parseCron(expr);
  if (!parts) return { ok: false, error: "Cron needs five fields: minute hour day month weekday.", next: [] };
  const [minutes, hours, doms, months, dows] = parts;
  const next: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = cursor.getTime() + 370 * 24 * 60 * 60 * 1000;
  while (next.length < count && cursor.getTime() < limit) {
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    const hour = cursor.getUTCHours();
    const minute = cursor.getUTCMinutes();
    if (months.has(month) && doms.has(day) && dows.has(dow) && hours.has(hour) && minutes.has(minute)) {
      next.push(new Date(cursor.getTime()));
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  if (next.length < count) return { ok: false, error: "This cron never matches in the next year.", next };
  return { ok: true, error: "", next };
}

export function presetCron(cadence: Exclude<JobCadence, "custom">): string {
  if (cadence === "hourly") return "0 * * * *";
  if (cadence === "daily") return "0 2 * * *";
  if (cadence === "weekdays") return "0 9 * * 1-5";
  return "0 7 * * 1";
}
