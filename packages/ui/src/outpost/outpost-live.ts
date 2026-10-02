/**
 * Live personal Outpost read (QA-069).
 *
 * The page reads the signed-in user's own Outpost from hq-pro through the
 * desktop's hq-pro client: `POST /outpost/status` for the box and
 * `GET /outpost/jobs/status` for scheduled-job status rows. A 404 from status
 * means the user has no Outpost. hq-pro keeps one status row per job (latest
 * probe and latest run), so the runs list is each job's latest run; there is
 * no run-history or log endpoint yet.
 */

import type { AdapterResult, Json } from "@hq/platform";
import type { OutpostCache, OutpostJob, OutpostRun, RunStatus } from "./outpost-model.js";

export interface OutpostReadApi {
  getMyOutpostStatus?(): Promise<AdapterResult<Json>>;
  listMyOutpostJobs?(): Promise<AdapterResult<Json>>;
}

/** Where the "Set one up" empty state sends the user. */
export const OUTPOST_SETUP_URL = "https://hq.computer/personal/outpost";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function latestIso(...values: unknown[]): string {
  let best = "";
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (!Number.isNaN(at) && at > bestAt) {
      best = value as string;
      bestAt = at;
    }
  }
  return best;
}

function clockLabel(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "unknown";
  const d = new Date(at);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/** No Outpost on this account: every list empty, `provisioned` false. */
export function noOutpost(fetchedAt: string | null): OutpostCache {
  return {
    provisioned: false,
    host: {
      name: "",
      hostname: "",
      region: "",
      instance: "",
      online: false,
      heartbeatAgo: "",
      lastHeartbeatAt: "",
      uptime: "",
      cpuPct: 0,
      memUsed: "",
      memTotal: "",
      diskUsed: "",
      diskTotal: "",
      version: "",
      identity: "",
    },
    jobs: [],
    runs: [],
    logs: [],
    unreachable: false,
    retryInSec: 0,
    retryAttempt: 0,
    fetchedAt,
  };
}

function jobStatus(row: Rec): RunStatus {
  const exit = row.last_exit;
  if (row.last_run_at && typeof exit === "number") return exit === 0 ? "ok" : "failed";
  if (row.failure_class) return "failed";
  if (row.readiness === "pending_probe") return "pending_probe";
  return "ok";
}

function jobDetail(row: Rec): string {
  const parts = [`readiness ${str(row.readiness) || "unknown"}`];
  if (row.failure_class) parts.push(`failure ${str(row.failure_class)}`);
  const next = Array.isArray(row.next_actions) ? row.next_actions.filter((a) => typeof a === "string") : [];
  if (next.length > 0) parts.push(next[0] as string);
  return parts.join(" · ");
}

function toJob(row: Rec): OutpostJob | null {
  const id = str(row.job_id);
  if (!id) return null;
  const lastRunAt = str(row.last_run_at) || undefined;
  const status = jobStatus(row);
  return {
    id,
    name: id,
    detail: jobDetail(row),
    runtime: "Claude",
    cadence: "custom",
    cadenceLabel: "—",
    cron: "",
    timezone: "",
    nextRun: "—",
    lastResult: lastRunAt ? status : "no runs yet",
    lastRunAt,
    lastResultNote: typeof row.last_exit === "number" ? `exit ${row.last_exit}` : undefined,
    status,
    paused: false,
    alert: "none",
    alertWhen: "on fail",
    mode: "prompt",
    prompt: "",
    skill: "",
    args: "",
    secretNames: [],
  };
}

function toRun(row: Rec): OutpostRun | null {
  const jobId = str(row.job_id);
  const at = str(row.last_run_at);
  if (!jobId || !at) return null;
  const exit = row.last_exit;
  const detail = [
    typeof exit === "number" ? `exit ${exit}` : "",
    row.failure_class ? `failure ${str(row.failure_class)}` : "",
  ].filter(Boolean).join(" · ");
  return { id: `${jobId}@${at}`, jobId, job: jobId, when: "", at, detail, status: jobStatus(row) };
}

/** Map hq-pro's status + jobs payloads into the page cache. */
export function outpostFromHqPro(status: Json, jobsBody: Json | null, fetchedAt: string): OutpostCache {
  const s = rec(status) ?? {};
  const rows = (rec(jobsBody)?.statuses as unknown[] | undefined) ?? [];
  const jobRows = Array.isArray(rows) ? rows.map(rec).filter((r): r is Rec => r !== null) : [];
  const state = str(s.state);
  const instanceState = str(s.instanceState);
  const online = state === "ready" && instanceState === "running";
  const lastReport = latestIso(s.codexRelayUpdatedAt, s.diskTelemetryUpdatedAt, s.slackAnsweringUpdatedAt, s.updatedAt);
  const size = [
    str(s.platform) === "ec2" ? "EC2" : "Lightsail",
    instanceState || state,
    typeof s.rootVolumeSizeGb === "number" ? `${s.rootVolumeSizeGb} GB disk` : "",
    s.storageAutoGrowEnabled === true ? "auto-grow" : "",
  ].filter(Boolean).join(" · ");
  const base = noOutpost(fetchedAt);
  const jobs = jobRows.map(toJob).filter((j): j is OutpostJob => j !== null);
  const runs = jobRows
    .map(toRun)
    .filter((r): r is OutpostRun => r !== null)
    .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
  return {
    ...base,
    provisioned: true,
    host: {
      ...base.host,
      name: str(s.instanceName) || "Outpost",
      hostname: str(s.staticIp),
      region: str(s.region),
      instance: size,
      online,
      lastHeartbeatAt: lastReport ? clockLabel(lastReport) : "unknown",
      lastHeartbeatIso: lastReport || undefined,
      diskUsed: typeof s.diskUsedPercent === "number" ? `${s.diskUsedPercent}%` : "",
      diskTotal: typeof s.rootVolumeSizeGb === "number" ? `${s.rootVolumeSizeGb} GB` : "",
      version: str(s.managedCodexVersion),
      identity: str(s.instanceName),
    },
    jobs,
    runs,
    unreachable: !online,
  };
}

/**
 * Build the page's refresher from the hq-pro client. Rejects when the client
 * is missing or a read fails, so the page keeps its cache and shows the stale
 * state instead of inventing data.
 */
export function createOutpostRefresher(api: OutpostReadApi | null | undefined) {
  return async (): Promise<OutpostCache> => {
    if (!api?.getMyOutpostStatus || !api.listMyOutpostJobs) {
      throw new Error("no Outpost API is connected in this build");
    }
    const fetchedAt = new Date().toISOString();
    const status = await api.getMyOutpostStatus();
    if (!status.ok) {
      if (status.code === "http-404") return noOutpost(fetchedAt);
      throw new Error(`outpost status: ${status.code ?? status.reason} ${status.message ?? ""}`.trim());
    }
    const jobs = await api.listMyOutpostJobs();
    if (!jobs.ok) {
      throw new Error(`outpost jobs: ${jobs.code ?? jobs.reason} ${jobs.message ?? ""}`.trim());
    }
    return outpostFromHqPro(status.value, jobs.value ?? null, fetchedAt);
  };
}
