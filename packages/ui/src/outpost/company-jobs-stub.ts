/**
 * In-memory company jobs route. Two actors share one store so a test can
 * show admin A creating a job and admin B updating it. This models the
 * desktop contract. It does not prove box reconcile, DM delivery, or that
 * a job keeps running after its registrant is removed.
 */
import { companyJobsHttpClient, type CompanyJobsClient, type JobsHttpResult } from "./company-jobs-client.js";
import {
  JOBS_COLLECTION_PATH,
  JOBS_STATUS_PATH,
  scheduleError,
  type JobHealth,
} from "./company-jobs-model.js";

export interface CompanyJobActor {
  uid: string;
  role: "owner" | "admin" | "member";
}

function canManageRole(role: CompanyJobActor["role"]): boolean {
  return role === "owner" || role === "admin";
}

export interface StoredCompanyJob {
  jobId: string;
  companyUid: string;
  outpostId: string;
  name: string;
  prompt: string;
  /** A vault edit that the server has not accepted. Never the execution prompt. */
  shadowPrompt: string | null;
  skill: string | null;
  /** The whole context object as sent. Update replaces it. */
  context: Record<string, unknown>;
  script: string | null;
  scheduleKind: "recurring" | "once";
  cron: string;
  at: string | null;
  timezone: string;
  paused: boolean;
  deleted: boolean;
  accepted: boolean;
  revision: string | null;
  registeredBy: string;
  latestEditor: string;
  health: JobHealth;
  lastRunAt: string | null;
  nextRunAt: string | null;
  message: string;
}

export interface CompanyJobAudit {
  actor: string;
  action: string;
  jobId: string;
  at: string;
}

export interface CompanyJobStore {
  jobs: StoredCompanyJob[];
  audit: CompanyJobAudit[];
  runs: { runId: string; jobId: string; actor: string; at: string }[];
  requests: { method: string; path: string; body: Record<string, unknown> | null; actor: string }[];
  failStatus: boolean;
  failList: boolean;
  /**
   * When set, every read and write refuses with this code (503). The live
   * jobs routes only send feature_disabled, company_jobs_unavailable and
   * company_job_freshness_unavailable. Billing is reported on the box list.
   */
  failCode: string | null;
  signedIn: boolean;
  /** One raw request, recorded like a client call. For tests that send their own body. */
  request(actor: CompanyJobActor, method: "GET" | "POST", path: string, body?: Record<string, unknown>): JobsHttpResult;
  client(actor: CompanyJobActor, options?: { writesAllowed?: boolean; memberRead?: boolean }): CompanyJobsClient;
  vaultEdit(jobId: string, prompt: string): void;
  setHealth(jobId: string, patch: Partial<Pick<StoredCompanyJob, "health" | "lastRunAt" | "nextRunAt" | "message">>): void;
  /** Accepted, active, not deleted. The prompt is the accepted one, never the shadow. */
  runnablePrompts(): string[];
}

export function createCompanyJobStore(options?: {
  now?: () => string;
  ids?: () => string;
  autoAccept?: boolean;
}): CompanyJobStore {
  const now = options?.now ?? (() => "2026-10-18T15:00:00.000Z");
  let seq = 0;
  const ids = options?.ids ?? (() => `job_${++seq}`);
  const autoAccept = options?.autoAccept !== false;
  const jobs: StoredCompanyJob[] = [];
  const audit: CompanyJobAudit[] = [];
  const runs: CompanyJobStore["runs"] = [];
  const requests: CompanyJobStore["requests"] = [];
  const store: CompanyJobStore = {
    jobs,
    audit,
    runs,
    requests,
    failStatus: false,
    failList: false,
    failCode: null,
    signedIn: true,
    request(actor, method, path, body) {
      requests.push({ method, path, body: body ?? null, actor: actor.uid });
      return handle(method, path, body, actor, { memberRead: true, autoAccept, now, ids, jobs, audit, runs, store });
    },
    client(actor, clientOptions) {
      const memberRead = clientOptions?.memberRead !== false;
      const writesAllowed = clientOptions?.writesAllowed ?? canManageRole(actor.role);
      return companyJobsHttpClient(
        {
          request(method, path, body) {
            requests.push({ method, path, body: body ?? null, actor: actor.uid });
            return Promise.resolve(handle(method, path, body, actor, { memberRead, autoAccept, now, ids, jobs, audit, runs, store }));
          },
        },
        { writesAllowed },
      );
    },
    vaultEdit(jobId, prompt) {
      const job = jobs.find((row) => row.jobId === jobId);
      if (job) job.shadowPrompt = prompt;
    },
    setHealth(jobId, patch) {
      const job = jobs.find((row) => row.jobId === jobId);
      if (!job) return;
      if (patch.health) job.health = patch.health;
      if (patch.lastRunAt !== undefined) job.lastRunAt = patch.lastRunAt;
      if (patch.nextRunAt !== undefined) job.nextRunAt = patch.nextRunAt;
      if (patch.message !== undefined) job.message = patch.message;
    },
    runnablePrompts() {
      return jobs.filter((job) => job.accepted && !job.paused && !job.deleted).map((job) => job.prompt);
    },
  };
  return store;
}

function handle(
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | undefined,
  actor: CompanyJobActor,
  ctx: {
    memberRead: boolean;
    autoAccept: boolean;
    now: () => string;
    ids: () => string;
    jobs: StoredCompanyJob[];
    audit: CompanyJobAudit[];
    runs: CompanyJobStore["runs"];
    store: CompanyJobStore;
  },
): JobsHttpResult {
  const readDenied = !canManageRole(actor.role) && !ctx.memberRead;
  if (ctx.store.failCode) return fail(503, ctx.store.failCode);
  if (method === "GET" && path.startsWith(JOBS_STATUS_PATH)) {
    if (readDenied) return fail(403, "admin_required");
    if (ctx.store.failStatus) return fail(500, "company_job_freshness_unavailable");
    const url = new URL(path, "https://hq.local");
    const companyUid = url.searchParams.get("companyUid") ?? "";
    const outpostId = boxOrLegacy(url.searchParams.get("outpostId"), companyUid);
    const includePending = url.searchParams.get("include") === "pending";
    const rows = ctx.jobs.filter((job) => job.companyUid === companyUid && job.outpostId === outpostId && !job.deleted);
    return ok(200, { companyUid, jobs: rows.map((job) => freshnessRow(job, includePending)) });
  }
  if (method !== "POST" || path !== JOBS_COLLECTION_PATH) return fail(404, "not_found");
  const action = typeof body?.action === "string" ? body.action : "";
  const companyUid = typeof body?.companyUid === "string" ? body.companyUid : "";
  if (action === "list") {
    if (ctx.store.failList) return fail(503, "company_jobs_unavailable");
    // List is owner and admin on the live route. memberRead models the
    // missing member read path so the screen can show a read-only list.
    if (!canManageRole(actor.role) && !ctx.memberRead) return fail(403, "admin_required");
    return ok(200, { jobs: wireJobs(ctx.jobs, companyUid, body) });
  }
  if (!canManageRole(actor.role)) return fail(403, "admin_required");
  if (action === "create") return createJob(body, actor, companyUid, ctx);
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  const job = ctx.jobs.find((row) => row.jobId === jobId && row.companyUid === companyUid);
  if (!job || job.deleted) return fail(404, "job_not_found");
  const revision = typeof body?.revision === "string" ? body.revision : "";
  if (!job.accepted || !job.revision) return fail(409, "revision_not_accepted");
  if (revision !== job.revision) return fail(409, "revision_required");
  if ((action === "create" || action === "update" || action === "enable" || action === "run-now") && !ctx.store.signedIn) {
    return fail(409, "box_not_signed_in");
  }
  if (action === "update") return updateJob(job, body, actor, ctx);
  if (action === "disable") return mutate(job, actor, "disable", ctx, () => { job.paused = true; });
  if (action === "enable") return mutate(job, actor, "enable", ctx, () => { job.paused = false; });
  if (action === "delete") return mutate(job, actor, "delete", ctx, () => { job.deleted = true; job.paused = true; });
  if (action === "run-now") {
    if (job.paused) return fail(409, "revision_not_runnable");
    const runId = `run_${ctx.ids()}`;
    ctx.runs.push({ runId, jobId: job.jobId, actor: actor.uid, at: ctx.now() });
    ctx.audit.push({ actor: actor.uid, action: "run-now", jobId: job.jobId, at: ctx.now() });
    return ok(202, { runId, jobId: job.jobId, revision: job.revision, requestedBy: actor.uid, requestedAt: ctx.now() });
  }
  return fail(400, "invalid_definition");
}

function createJob(
  body: Record<string, unknown> | undefined,
  actor: CompanyJobActor,
  companyUid: string,
  ctx: { autoAccept: boolean; now: () => string; ids: () => string; jobs: StoredCompanyJob[]; audit: CompanyJobAudit[]; store: CompanyJobStore },
): JobsHttpResult {
  if (!ctx.store.signedIn) return fail(409, "box_not_signed_in");
  const definition = asRecord(body?.definition);
  const prompt = typeof definition?.prompt === "string" ? definition.prompt : "";
  const schedule = asRecord(definition?.schedule);
  const once = schedule?.kind === "once";
  const cron = typeof schedule?.cron === "string" ? schedule.cron : "";
  const at = once && typeof schedule?.at === "string" ? schedule.at : null;
  const timezone = typeof schedule?.timezone === "string" ? schedule.timezone : "UTC";
  const context = asRecord(definition?.context);
  const name = context && typeof context.name === "string" ? context.name : "";
  if (!prompt.trim() || !name.trim()) return fail(400, "invalid_definition");
  if (once ? !at : scheduleError(cron)) return fail(400, "unsupported_schedule");
  const outpostId = typeof body?.outpostId === "string" ? body.outpostId : "";
  if (!outpostId) return fail(400, "invalid_outpost");
  const accepted = ctx.autoAccept;
  const job: StoredCompanyJob = {
    jobId: ctx.ids(),
    companyUid,
    outpostId,
    name,
    prompt,
    shadowPrompt: null,
    skill: context && typeof context.skill === "string" ? context.skill : null,
    context: { ...context },
    script: typeof definition?.script === "string" ? definition.script : null,
    scheduleKind: once ? "once" : "recurring",
    cron: once ? "" : cron,
    at,
    timezone,
    paused: false,
    deleted: false,
    accepted,
    revision: accepted ? "1" : null,
    registeredBy: actor.uid,
    latestEditor: actor.uid,
    health: "pending",
    lastRunAt: null,
    nextRunAt: null,
    message: "",
  };
  ctx.jobs.push(job);
  ctx.audit.push({ actor: actor.uid, action: "create", jobId: job.jobId, at: ctx.now() });
  return ok(201, { job: wire(job) });
}

function updateJob(
  job: StoredCompanyJob,
  body: Record<string, unknown> | undefined,
  actor: CompanyJobActor,
  ctx: { now: () => string; audit: CompanyJobAudit[] },
): JobsHttpResult {
  const definition = asRecord(body?.definition);
  const prompt = typeof definition?.prompt === "string" ? definition.prompt : "";
  const schedule = asRecord(definition?.schedule);
  const context = asRecord(definition?.context);
  const name = context && typeof context.name === "string" ? context.name.trim() : "";
  // The live update replaces prompt, schedule, context and script, so a
  // missing field is lost, not kept.
  if (!prompt.trim() || !schedule || !name) return fail(400, "invalid_definition");
  const once = schedule.kind === "once";
  const cron = typeof schedule.cron === "string" ? schedule.cron : "";
  const at = once && typeof schedule.at === "string" ? schedule.at : null;
  if (once ? !at : scheduleError(cron)) return fail(400, "unsupported_schedule");
  job.prompt = prompt;
  job.scheduleKind = once ? "once" : "recurring";
  job.cron = once ? "" : cron;
  job.at = at;
  job.timezone = typeof schedule.timezone === "string" ? schedule.timezone : "UTC";
  job.context = { ...context };
  job.name = name;
  job.skill = typeof context?.skill === "string" ? context.skill : null;
  job.script = typeof definition?.script === "string" ? definition.script : null;
  job.latestEditor = actor.uid;
  job.revision = String(Number(job.revision ?? "0") + 1);
  ctx.audit.push({ actor: actor.uid, action: "update", jobId: job.jobId, at: ctx.now() });
  return ok(200, { job: wire(job) });
}

function mutate(
  job: StoredCompanyJob,
  actor: CompanyJobActor,
  action: string,
  ctx: { now: () => string; audit: CompanyJobAudit[] },
  apply: () => void,
): JobsHttpResult {
  apply();
  job.latestEditor = actor.uid;
  job.revision = String(Number(job.revision ?? "0") + 1);
  ctx.audit.push({ actor: actor.uid, action, jobId: job.jobId, at: ctx.now() });
  return ok(200, { job: wire(job) });
}

function wireJobs(jobs: StoredCompanyJob[], companyUid: string, body: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const outpostId = boxOrLegacy(typeof body?.outpostId === "string" ? body.outpostId : null, companyUid);
  return jobs
    .filter((job) => job.companyUid === companyUid && job.outpostId === outpostId)
    .map(wire);
}

/** The live route reads only the legacy company box when outpostId is missing. */
function boxOrLegacy(outpostId: string | null, companyUid: string): string {
  return outpostId || `outpost_${companyUid}`;
}

/**
 * One row in the shape hq-pro-agents returns. A never-run job is ok/not_due
 * unless the caller asks for include=pending. Paused is ok/paused. The
 * server sends no message text.
 */
function freshnessRow(job: StoredCompanyJob, includePending: boolean): Record<string, unknown> {
  let status: string = job.health;
  let reason: string = job.health === "ok" ? "succeeded" : job.health;
  if (job.health === "pending") {
    status = includePending ? "pending" : "ok";
    reason = includePending ? "awaiting_first_run" : "not_due";
  }
  if (job.paused) {
    status = "ok";
    reason = "paused";
  }
  return {
    jobId: job.jobId,
    status,
    occurrence: job.lastRunAt,
    lastSuccessAt: job.health === "ok" ? job.lastRunAt : null,
    heartbeatAt: null,
    reason,
    lastRunAt: job.lastRunAt,
    nextRunAt: job.paused ? null : job.nextRunAt,
  };
}

function wire(job: StoredCompanyJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    agentUid: job.outpostId,
    companyUid: job.companyUid,
    ownerKind: "company-outpost",
    prompt: job.prompt,
    schedule: job.scheduleKind === "once"
      ? { kind: "once", at: job.at, timezone: job.timezone }
      : { kind: "recurring", cron: job.cron, timezone: job.timezone },
    context: { ...job.context, name: job.name, ...(job.skill ? { skill: job.skill } : {}) },
    ...(job.script !== null ? { script: job.script } : {}),
    status: job.paused ? "paused" : "active",
    registeredBy: job.registeredBy,
    latestEditor: job.latestEditor,
    ...(job.revision ? { acceptedRevision: job.revision } : {}),
    ...(job.deleted ? { deleted: true } : {}),
    target: { outpostId: job.outpostId },
  };
}

function ok(status: number, body: unknown): JobsHttpResult {
  return { ok: true, status, code: "", body };
}

function fail(status: number, code: string): JobsHttpResult {
  return { ok: false, status, code, body: { code } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
