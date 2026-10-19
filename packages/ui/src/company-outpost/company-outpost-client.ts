/**
 * Company Outpost client.
 *
 * Binds to the routes in DESKTOP-API-CONSTRAINTS until
 * design/desktop-api-contract.md lands. No new routes: list, rename, and
 * provision status are actions on POST /outpost/status. Provision is
 * POST /outpost/provision with ownerKind "company".
 * A failure does not become a list row.
 */
import type { AdapterResult, Json } from "@hq/platform";

import {
  COMPANY_OUTPOST_CAP,
  asString,
  countsFromJobs,
  emptyHealth,
  failureCopy,
  mapLifecycleState,
  nextOutpostName,
  publicMachine,
  type CompanyOutpostDetail,
  type CompanyOutpostJob,
  type CompanyOutpostListItem,
  type CompanyOutpostRun,
  type JobHealth,
  type JobHealthCounts,
  type ProvisionResult,
} from "./company-outpost-model.js";

export interface CompanyOutpostApi {
  listCompanyOutposts?(companyUid: string): Promise<AdapterResult<Json>>;
  getCompanyOutpost?(companyUid: string, outpostId: string): Promise<AdapterResult<Json>>;
  listCompanyOutpostJobs?(companyUid: string, outpostId: string): Promise<AdapterResult<Json>>;
  getCompanyOutpostJobHealth?(companyUid: string, outpostId: string): Promise<AdapterResult<Json>>;
  provisionCompanyOutpost?(companyUid: string): Promise<AdapterResult<Json>>;
  renameCompanyOutpost?(companyUid: string, outpostId: string, name: string): Promise<AdapterResult<Json>>;
  removeCompanyOutpost?(companyUid: string, outpostId: string): Promise<AdapterResult<Json>>;
  signInCompanyOutpostAgain?(companyUid: string, outpostId: string): Promise<AdapterResult<Json>>;
  pollCompanyOutpostProvision?(companyUid: string, attemptId: string): Promise<AdapterResult<Json>>;
}

export type ListResult =
  | { ok: true; items: CompanyOutpostListItem[]; cap: number }
  | { ok: false; code: string; message: string };

export interface ManageResult {
  ok: boolean;
  message: string;
}

export interface CompanyOutpostClient {
  list(): Promise<ListResult>;
  detail(outpostId: string): Promise<{ ok: true; outpost: CompanyOutpostDetail } | { ok: false; message: string }>;
  previewAdd(existingNames: readonly string[]): { name: string; cap: number };
  provision(): Promise<ProvisionResult>;
  pollProvision(attemptId: string): Promise<ProvisionResult>;
  rename(outpostId: string, name: string): Promise<ManageResult>;
  remove(outpostId: string): Promise<ManageResult>;
  signInAgain(outpostId: string): Promise<ManageResult>;
}

const MANAGE_REFUSAL = "Only company owners and admins can manage Outposts.";

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function healthName(value: unknown): JobHealth {
  const raw = asString(value).toLowerCase();
  if (raw === "ok" || raw === "missed" || raw === "blocked" || raw === "stale" || raw === "unknown") return raw;
  return "unknown";
}

function jobHealthField(body: Record<string, unknown>): JobHealth {
  if (body.health != null) return healthName(body.health);
  if (body.result != null) return healthName(body.result);
  return healthName(body.status);
}

function healthCounts(value: unknown, jobs: CompanyOutpostJob[]): JobHealthCounts {
  const body = rec(value);
  if (!body) return jobs.length ? countsFromJobs(jobs) : emptyHealth();
  return {
    ok: num(body.ok),
    missed: num(body.missed),
    blocked: num(body.blocked),
    stale: num(body.stale),
    unknown: num(body.unknown),
  };
}

function parseJob(value: unknown): CompanyOutpostJob | null {
  const body = rec(value);
  if (!body) return null;
  const id = asString(body.jobId) || asString(body.id) || asString(body.name);
  if (!id) return null;
  return {
    id,
    name: asString(body.name) || id,
    health: jobHealthField(body),
    lastRunAt: asString(body.lastRunAt) || asString(body.last_run_at) || null,
    nextRunAt: asString(body.nextRunAt) || asString(body.next_run_at) || null,
    summary: asString(body.summary) || asString(body.runs) || asString(body.detail),
  };
}

function parseRun(value: unknown, jobs: readonly CompanyOutpostJob[]): CompanyOutpostRun | null {
  const body = rec(value);
  if (!body) return null;
  const jobId = asString(body.jobId) || asString(body.job_id);
  const jobName = asString(body.jobName) || jobs.find((job) => job.id === jobId)?.name || jobId;
  const at = asString(body.at) || asString(body.lastRunAt) || null;
  const id = asString(body.id) || (jobId && at ? `${jobId}@${at}` : "");
  if (!id) return null;
  return { id, jobId, jobName, at, health: healthName(body.health ?? body.result) };
}

export function parseListItem(value: unknown): CompanyOutpostListItem | null {
  const body = rec(value);
  if (!body) return null;
  const id = asString(body.outpostId) || asString(body.id);
  const name = asString(body.name) || (id ? "main" : "");
  if (!id || !name) return null;
  const jobs = Array.isArray(body.jobs) ? body.jobs.map(parseJob).filter((job): job is CompanyOutpostJob => job !== null) : [];
  const jobsCount = typeof body.jobsCount === "number" ? body.jobsCount : jobs.length;
  const signIn = rec(body.signIn);
  const lifecycle = asString(body.lifecycle) || asString(body.state);
  return {
    id,
    name,
    state: mapLifecycleState({
      state: lifecycle,
      stopped: body.stopped === true,
      blocked: body.blocked === true || asString(body.blockedReason) === "outcome_unknown",
      signedIn: signIn ? signIn.signedIn === true : undefined,
    }),
    lastSeenAt: asString(body.lastSeenAt) || asString(body.last_seen_at) || asString(body.updatedAt) || null,
    jobsCount,
    jobHealth: healthCounts(body.jobHealth, jobs),
  };
}

export function parseCompanyOutpostList(value: unknown): { items: CompanyOutpostListItem[]; cap: number } | null {
  const body = rec(value);
  if (!body) return null;
  const rows = Array.isArray(body.outposts) ? body.outposts : Array.isArray(body.items) ? body.items : null;
  if (!rows) {
    const one = parseListItem(body);
    if (!one) return null;
    return { items: [one], cap: num(body.cap) || COMPANY_OUTPOST_CAP };
  }
  return {
    items: rows.map(parseListItem).filter((item): item is CompanyOutpostListItem => item !== null),
    cap: num(body.cap) || COMPANY_OUTPOST_CAP,
  };
}

export function parseCompanyOutpostDetail(value: unknown, jobsValue?: unknown): CompanyOutpostDetail | null {
  const body = rec(value);
  if (!body) return null;
  const item = parseListItem(body.outpost ?? body);
  if (!item) return null;
  const jobsBody = rec(jobsValue);
  const jobRows = Array.isArray(body.jobs)
    ? body.jobs
    : Array.isArray(jobsBody?.jobs)
      ? jobsBody.jobs
      : Array.isArray(jobsBody?.statuses)
        ? jobsBody.statuses
        : [];
  const jobs = jobRows.map(parseJob).filter((job): job is CompanyOutpostJob => job !== null);
  const runRows = Array.isArray(body.runs) ? body.runs : Array.isArray(jobsBody?.runs) ? jobsBody.runs : [];
  const runs = runRows.map((row) => parseRun(row, jobs)).filter((run): run is CompanyOutpostRun => run !== null);
  const derived = runs.length > 0
    ? runs
    : jobs
      .filter((job) => job.lastRunAt)
      .map((job) => ({ id: `${job.id}@${job.lastRunAt}`, jobId: job.id, jobName: job.name, at: job.lastRunAt, health: job.health }));
  const machine = publicMachine(rec(body.machine));
  if (!machine.createdAt) machine.createdAt = asString(body.createdAt);
  return {
    ...item,
    jobsCount: item.jobsCount || jobs.length,
    jobHealth: item.jobHealth.ok + item.jobHealth.missed + item.jobHealth.blocked + item.jobHealth.stale + item.jobHealth.unknown > 0
      ? item.jobHealth
      : countsFromJobs(jobs),
    machine,
    jobs,
    runs: derived,
    stopped: body.stopped === true || rec(body.outpost)?.stopped === true,
  };
}

function codeOf(result: AdapterResult<Json>): string {
  if (result.ok) return "";
  return `${result.code ?? ""} ${result.message ?? ""}`.toLowerCase();
}

const NOT_AVAILABLE_YET = new Set(["payment_not_set_up", "billing_required"]);

const BUSY_LIFECYCLE = new Set(["provisioning", "confirming", "starting", "stopping", "destroying", "pending"]);

export function parseProvision(result: AdapterResult<Json>): ProvisionResult {
  if (!result.ok) {
    const code = codeOf(result);
    if (code.includes("already_exists") || code.includes("already-exists")) return { status: "already_exists" };
    if (code.includes("payment") || code.includes("billing") || code.includes("402")) return { status: "unavailable" };
    if (code.includes("403") || code.includes("forbidden") || code.includes("admin_required")) return { status: "forbidden" };
    if (code.includes("unavailable") || code.includes("dependencies_unavailable")) {
      return { status: "failure", message: failureCopy() };
    }
    if (
      code.includes("outcome_unknown") ||
      code.includes("network") ||
      code.includes("timeout") ||
      code.includes("503") ||
      code.includes("500") ||
      code.includes("504")
    ) {
      return { status: "pending", attemptId: "" };
    }
    return { status: "failure", message: failureCopy() };
  }
  const body = rec(result.value) ?? {};
  const status = asString(body.status).toLowerCase().replace(/-/g, "_");
  const code = asString(body.code).toLowerCase();
  if (status === "already_exists" || code === "already_exists") {
    return { status: "already_exists", outpostId: asString(body.outpostId) || undefined };
  }
  if (NOT_AVAILABLE_YET.has(status) || NOT_AVAILABLE_YET.has(code)) return { status: "unavailable" };
  if (status === "failure" || status === "error" || body.error === true) {
    return { status: "failure", message: failureCopy() };
  }
  const outpostRec = rec(body.outpost);
  const lifecycle = (asString(outpostRec?.lifecycle) || asString(body.lifecycle) || status).toLowerCase().replace(/-/g, "_");
  const attemptId =
    asString(outpostRec?.outpostId) || asString(body.outpostId) || asString(body.operationId) || asString(body.attemptId) || "pending";
  if (status === "pending" && !outpostRec) return { status: "pending", attemptId: asString(body.attemptId) || "pending" };
  if (BUSY_LIFECYCLE.has(lifecycle) && status !== "success" && status !== "failure") return { status: "pending", attemptId };
  if (lifecycle === "ready" && asString(outpostRec?.runtimeConfirmation) === "pending") return { status: "pending", attemptId };
  const outpost = parseListItem(body.outpost ?? body);
  if (outpost && (status === "success" || status === "ready" || status === "running" || status === "preparing" || lifecycle === "ready" || lifecycle === "running" || status === "")) {
    return { status: "success", outpost };
  }
  if (asString(body.attemptId) || asString(body.operationId)) return { status: "pending", attemptId };
  return { status: "failure", message: failureCopy() };
}

function loadError(result: AdapterResult<Json>): Extract<ListResult, { ok: false }> {
  const code = result.ok ? "" : `${result.code ?? ""} ${result.message ?? ""}`;
  const folded = code.toLowerCase();
  if (folded.includes("401") || folded.includes("unauthorized")) {
    return { ok: false, code, message: "Sign in to HQ again to continue." };
  }
  if (folded.includes("403") || folded.includes("forbidden") || folded.includes("admin_required") || folded.includes("no_access")) {
    return { ok: false, code, message: "You do not have access to this company's Outposts." };
  }
  if (folded.includes("feature_disabled")) {
    return { ok: false, code, message: "Company Outposts are paused right now. Try again later." };
  }
  if (folded.includes("not_found")) return { ok: false, code, message: "This Outpost was removed." };
  return { ok: false, code: code || "error", message: "Could not load. Retry." };
}

function jobsFromHealth(value: unknown): CompanyOutpostJob[] {
  const body = rec(value);
  const rows = Array.isArray(body?.jobs) ? body.jobs : Array.isArray(value) ? value : [];
  return rows.map(parseJob).filter((job): job is CompanyOutpostJob => job !== null);
}

export function createCompanyOutpostClient(options: {
  companyUid: string;
  canManage: boolean;
  api: CompanyOutpostApi | null;
  cap?: number;
}): CompanyOutpostClient {
  const { companyUid, canManage, api } = options;
  let cap = options.cap ?? COMPANY_OUTPOST_CAP;

  function refuse(): ProvisionResult {
    return { status: "forbidden" };
  }

  async function fillHealth(item: CompanyOutpostListItem): Promise<CompanyOutpostListItem> {
    if (!api?.getCompanyOutpostJobHealth) return item;
    if (item.jobsCount > 0) return item;
    const health = await api.getCompanyOutpostJobHealth(companyUid, item.id);
    if (!health.ok) return item;
    const jobs = jobsFromHealth(health.value);
    if (jobs.length === 0) return item;
    return { ...item, jobsCount: jobs.length, jobHealth: countsFromJobs(jobs) };
  }

  return {
    async list() {
      if (!api?.listCompanyOutposts) return { ok: false, code: "unavailable", message: "Could not load. Retry." };
      const result = await api.listCompanyOutposts(companyUid);
      if (!result.ok) return loadError(result);
      const parsed = parseCompanyOutpostList(result.value);
      if (!parsed) return { ok: false, code: "unrecognized", message: "Could not load. Retry." };
      cap = parsed.cap;
      const items = await Promise.all(parsed.items.map((item) => fillHealth(item)));
      return { ok: true, items, cap: parsed.cap };
    },
    async detail(outpostId) {
      if (!api?.getCompanyOutpost) return { ok: false, message: "Could not load. Retry." };
      const status = await api.getCompanyOutpost(companyUid, outpostId);
      if (!status.ok) return { ok: false, message: loadError(status).message };
      const health = api.getCompanyOutpostJobHealth ? await api.getCompanyOutpostJobHealth(companyUid, outpostId) : null;
      const jobs = health?.ok
        ? health
        : api.listCompanyOutpostJobs
          ? await api.listCompanyOutpostJobs(companyUid, outpostId)
          : null;
      const parsed = parseCompanyOutpostDetail(status.value, jobs && jobs.ok ? jobs.value : null);
      if (!parsed) return { ok: false, message: "Could not load. Retry." };
      return { ok: true, outpost: parsed };
    },
    previewAdd(existingNames) {
      return { name: nextOutpostName(existingNames), cap };
    },
    async provision() {
      if (!canManage) return refuse();
      if (!api?.provisionCompanyOutpost) return { status: "failure", message: failureCopy() };
      return parseProvision(await api.provisionCompanyOutpost(companyUid));
    },
    async pollProvision(attemptId) {
      if (!canManage) return refuse();
      if (!api?.pollCompanyOutpostProvision) return { status: "failure", message: failureCopy() };
      return parseProvision(await api.pollCompanyOutpostProvision(companyUid, attemptId));
    },
    async rename(outpostId, name) {
      if (!canManage) return { ok: false, message: MANAGE_REFUSAL };
      if (!api?.renameCompanyOutpost) return { ok: false, message: "Could not rename this Outpost." };
      const result = await api.renameCompanyOutpost(companyUid, outpostId, name);
      if (!result.ok) return { ok: false, message: "Could not rename this Outpost." };
      return { ok: true, message: "Name saved." };
    },
    async remove(outpostId) {
      if (!canManage) return { ok: false, message: MANAGE_REFUSAL };
      if (!api?.removeCompanyOutpost) return { ok: false, message: "Could not remove this Outpost." };
      const result = await api.removeCompanyOutpost(companyUid, outpostId);
      if (!result.ok) return { ok: false, message: "Could not remove this Outpost." };
      return { ok: true, message: "Outpost removed." };
    },
    async signInAgain(outpostId) {
      if (!canManage) return { ok: false, message: MANAGE_REFUSAL };
      if (!api?.signInCompanyOutpostAgain) return { ok: false, message: "Could not start sign-in again." };
      const result = await api.signInCompanyOutpostAgain(companyUid, outpostId);
      if (!result.ok) return { ok: false, message: "Could not start sign-in again." };
      return { ok: true, message: "Sign-in again was requested for this Outpost. This screen does not open a sign-in page." };
    },
  };
}

