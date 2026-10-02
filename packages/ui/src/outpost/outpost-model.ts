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
  lastResult: string;
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
  host: OutpostHost;
  jobs: OutpostJob[];
  runs: OutpostRun[];
  logs: LogLine[];
  unreachable: boolean;
  retryInSec: number;
  retryAttempt: number;
}

const caches = new Map<string, OutpostCache>();

export function readOutpostCache(owner: string): OutpostCache | null {
  return caches.get(owner) ?? null;
}

export function writeOutpostCache(owner: string, value: OutpostCache): void {
  if (owner) caches.set(owner, value);
}

export function fixtureOutpost(): OutpostCache {
  return {
    host: {
      name: "corey-outpost",
      hostname: "corey-outpost.hq-outpost.net",
      region: "us-east-1",
      instance: "t3.large · 2 vCPU · 8 GB · 80 GB auto-grow",
      online: true,
      heartbeatAgo: "12 s ago",
      lastHeartbeatAt: "10:52",
      uptime: "41 d 6 h",
      cpuPct: 18,
      memUsed: "4.3",
      memTotal: "8 GB",
      diskUsed: "29",
      diskTotal: "80 GB",
      version: "0.10.287",
      identity: "corey-outpost",
    },
    jobs: [
      {
        id: "standup-brief",
        name: "standup-brief",
        detail: "Claude · skill indigo:standup-brief · posts to #dev-standup",
        runtime: "Claude",
        cadence: "weekdays",
        cadenceLabel: "weekdays 09:00 PT",
        cron: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
        nextRun: "tomorrow 09:00",
        lastResult: "ok · today 09:00 · 38s",
        status: "ok",
        paused: false,
        alert: "dm",
        alertWhen: "always",
        mode: "skill",
        prompt: "",
        skill: "indigo:standup-brief",
        args: "",
        secretNames: [],
      },
      {
        id: "attio-call-sync",
        name: "attio-call-sync",
        detail: "Codex · prompt · call notes into Attio · secret missing on Outpost",
        runtime: "Codex",
        cadence: "hourly",
        cadenceLabel: "hourly",
        cron: "0 * * * *",
        timezone: "America/Los_Angeles",
        nextRun: "in 33m",
        lastResult: "failed · 19m ago · 3 in a row",
        status: "failed",
        paused: false,
        alert: "dm",
        alertWhen: "on fail",
        mode: "prompt",
        prompt: "Sync today's call notes into Attio and DM Corey a one-line summary.",
        skill: "indigo:attio-call-sync",
        args: "--since today --dm corey",
        secretNames: ["ATTIO_API_KEY"],
      },
      {
        id: "knowledge-pulse",
        name: "knowledge-pulse",
        detail: "Claude · skill knowledge-pulse · paused Sep 20",
        runtime: "Claude",
        cadence: "weekly",
        cadenceLabel: "weekly Mon 07:00 PT",
        cron: "0 7 * * 1",
        timezone: "America/Los_Angeles",
        nextRun: "paused",
        lastResult: "ok · 11d ago · 2m 02s",
        status: "ok",
        paused: true,
        alert: "none",
        alertWhen: "on fail",
        mode: "skill",
        prompt: "",
        skill: "knowledge-pulse",
        args: "",
        secretNames: [],
      },
    ],
    runs: [
      { id: "r1", jobId: "standup-brief", job: "standup-brief", when: "2h ago", detail: "38s · posted to #dev-standup", status: "ok" },
      { id: "r2", jobId: "attio-call-sync", job: "attio-call-sync", when: "19m ago", detail: "0.8s · secret ATTIO_API_KEY not readable on Outpost", status: "failed" },
      { id: "r3", jobId: "attio-call-sync", job: "attio-call-sync", when: "1h ago", detail: "0.8s · same error", status: "failed" },
    ],
    logs: [
      { id: "l1", t: "09:00:01.012", level: "info", job: "standup-brief", message: "job start · claude · skill indigo:standup-brief" },
      { id: "l2", t: "09:15:02.790", level: "err", job: "attio-call-sync", message: "secret ATTIO_API_KEY · not readable by corey-outpost" },
      { id: "l3", t: "09:41:17.558", level: "info", job: "outpost", message: "heartbeat ok · cpu 14%" },
    ],
    unreachable: false,
    retryInSec: 22,
    retryAttempt: 6,
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
