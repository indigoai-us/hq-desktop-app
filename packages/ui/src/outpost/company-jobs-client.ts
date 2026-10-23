/**
 * Company jobs HTTP client. The transport is the only external boundary.
 * Writes are refused here when the caller cannot manage jobs, before any
 * request. registered_by and alert fields are stripped from the body.
 */
import type { AdapterResult, Json } from "@hq/platform";
import {
  JOBS_COLLECTION_PATH,
  JOBS_STATUS_PATH,
  classifyAcceptance,
  parseCompanyJob,
  parseJobHealth,
  sanitizeJobBody,
  type Acceptance,
  type ParsedCompanyJob,
  type ParsedJobHealth,
} from "./company-jobs-model.js";

export interface JobsHttpResult {
  ok: boolean;
  status: number;
  code: string;
  body: unknown;
}

export interface JobsTransport {
  request(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<JobsHttpResult>;
}

export type JobsListResult =
  | { ok: true; jobs: ParsedCompanyJob[] }
  | { ok: false; code: string };

export type JobsStatusResult =
  | { ok: true; jobs: ParsedJobHealth[] }
  | { ok: false; code: string };

export type JobsWriteResult =
  | { ok: true; acceptance: Acceptance; job: ParsedCompanyJob | null; runId: string | null; requestedAt: string | null }
  | { ok: false; code: string };

export interface CompanyJobsClient {
  list(companyUid: string, outpostId?: string | null): Promise<JobsListResult>;
  status(companyUid: string, outpostId?: string | null): Promise<JobsStatusResult>;
  submit(input: CompanyJobSubmit): Promise<JobsWriteResult>;
}

export interface CompanyJobSubmit {
  companyUid: string;
  action: "create" | "update" | "enable" | "disable" | "delete" | "run-now";
  outpostId?: string | null;
  jobId?: string | null;
  revision?: string | null;
  definition?: Record<string, unknown>;
}

const WRITE_ACTIONS = new Set<CompanyJobSubmit["action"]>([
  "create",
  "update",
  "enable",
  "disable",
  "delete",
  "run-now",
]);

export function companyJobsStatusPath(companyUid: string, outpostId?: string | null): string {
  const company = `companyUid=${encodeURIComponent(companyUid)}`;
  const box = outpostId ? `&outpostId=${encodeURIComponent(outpostId)}` : "";
  // include=pending makes the server report a never-run job as pending, not ok.
  return `${JOBS_STATUS_PATH}?${company}${box}&include=pending`;
}

export function companyJobsHttpClient(
  transport: JobsTransport,
  options: { writesAllowed: boolean },
): CompanyJobsClient {
  return {
    async list(companyUid, outpostId) {
      const result = await transport.request("POST", JOBS_COLLECTION_PATH, sanitizeJobBody({
        companyUid,
        action: "list",
        ...(outpostId ? { outpostId } : {}),
      }));
      if (!result.ok) return { ok: false, code: failureCode(result) };
      const jobs = Array.isArray(asRecord(result.body)?.jobs)
        ? (asRecord(result.body)?.jobs as unknown[]).map(parseCompanyJob).filter((job): job is ParsedCompanyJob => job !== null)
        : [];
      return { ok: true, jobs };
    },
    async status(companyUid, outpostId) {
      const result = await transport.request("GET", companyJobsStatusPath(companyUid, outpostId));
      if (!result.ok) return { ok: false, code: failureCode(result) };
      const jobs = Array.isArray(asRecord(result.body)?.jobs)
        ? (asRecord(result.body)?.jobs as unknown[]).map(parseJobHealth).filter((job): job is ParsedJobHealth => job !== null)
        : [];
      return { ok: true, jobs };
    },
    async submit(input) {
      if (WRITE_ACTIONS.has(input.action) && !options.writesAllowed) {
        return { ok: false, code: "admin_required" };
      }
      const body: Record<string, unknown> = {
        companyUid: input.companyUid,
        action: input.action,
      };
      if (input.outpostId) body.outpostId = input.outpostId;
      if (input.jobId) body.jobId = input.jobId;
      if (input.revision) body.revision = input.revision;
      if (input.definition) body.definition = input.definition;
      const result = await transport.request("POST", JOBS_COLLECTION_PATH, sanitizeJobBody(body));
      if (!result.ok) return { ok: false, code: failureCode(result) };
      if (input.action === "run-now") {
        const record = asRecord(result.body);
        const runId = record?.runId;
        const requestedAt = record?.requestedAt;
        return {
          ok: true,
          acceptance: "accepted",
          job: null,
          runId: typeof runId === "string" ? runId : null,
          requestedAt: typeof requestedAt === "string" ? requestedAt : null,
        };
      }
      const job = parseCompanyJob(asRecord(result.body)?.job ?? null);
      return { ok: true, acceptance: classifyAcceptance(result.body), job, runId: null, requestedAt: null };
    },
  };
}

export interface CompanyJobsApi {
  postCompanyJobs?: (body: Json) => Promise<AdapterResult<Json>>;
  getCompanyJobsStatus?: (companyUid: string, outpostId?: string | null) => Promise<AdapterResult<Json>>;
  /** GET /outpost/status list, with the legacy single-row fallback inside the adapter. */
  listCompanyOutposts?: (companyUid: string) => Promise<AdapterResult<Json>>;
}

/** Heal path for the not-available-yet state: tells HQ this company asked. */
export type CompanyJobsContact = (companyUid: string) => Promise<AdapterResult<unknown>>;

export function companyJobsClientFromApi(
  api: CompanyJobsApi | null,
  options: { writesAllowed: boolean },
): CompanyJobsClient {
  const transport: JobsTransport = {
    async request(method, path, body) {
      if (method === "GET") {
        if (!api?.getCompanyJobsStatus) return { ok: false, status: 0, code: "unavailable", body: null };
        const url = new URL(path, "https://hq.local");
        const companyUid = url.searchParams.get("companyUid") ?? "";
        const outpostId = url.searchParams.get("outpostId");
        return fromAdapter(await api.getCompanyJobsStatus(companyUid, outpostId));
      }
      if (!api?.postCompanyJobs) return { ok: false, status: 0, code: "unavailable", body: null };
      return fromAdapter(await api.postCompanyJobs((body ?? {}) as Json));
    },
  };
  return companyJobsHttpClient(transport, options);
}

function fromAdapter(result: AdapterResult<Json>): JobsHttpResult {
  if (result.ok) return { ok: true, status: 200, code: "", body: result.value };
  const code = result.code && !result.code.startsWith("http-") ? result.code : result.code ?? "unavailable";
  return { ok: false, status: result.status ?? 0, code, body: null };
}

function failureCode(result: JobsHttpResult): string {
  if (result.code && !result.code.startsWith("http-")) return result.code;
  const rec = asRecord(result.body);
  if (rec && typeof rec.code === "string" && rec.code) return rec.code;
  if (result.status === 403) return "admin_required";
  return result.code || `http-${result.status || 0}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
