/**
 * Company pull for a returning account on a new Mac (US-023).
 *
 * After sign-in, setup brings every active company folder onto this Mac, one
 * company at a time, through the same scoped sync the desktop auto-pull uses
 * (`start_sync` with a company slug). A company whose bucket is missing is
 * provisioned once (`activate-cloud`, the first-folder self-heal) and pulled
 * again. Every company ends `done` or `failed`; a failure is never dropped, so
 * the Ready screen cannot claim the pull finished while one failed.
 */
import { companyUidFromMissingBucket, isMissingBucketMessage, type ProvisioningState } from './onboarding-company-route';

export type CompanyPullStatus = 'queued' | 'pulling' | 'done' | 'failed';

/** Bounded failure reason for telemetry. Never shown to the person. */
export type CompanyPullErrorKind = 'start_failed' | 'busy' | 'sync_error' | 'aborted' | 'timeout' | 'provisioning';

export interface CompanyPullRow {
  companyUid: string;
  slug: string;
  name: string;
  status: CompanyPullStatus;
  /** Pull attempts started for this company (Try again adds one). */
  attempts: number;
  errorKind: CompanyPullErrorKind | null;
}

export interface CompanyPullCompany {
  companyUid: string;
  slug: string;
  name: string;
}

/** What one scoped sync run reported (`sync:all-complete`, plus an aborted `sync:complete`). */
export interface CompanyPullRunResult {
  errors: Array<{ company?: string; message: string }>;
  aborted: boolean;
  timedOut?: boolean;
  /**
   * The sync process could not be spawned (a `(spawn)` error naming no
   * company). No pull can progress, so every company still waiting fails too.
   */
  spawnFailed?: boolean;
}

export interface CompanyPullOutcome {
  companyUid: string;
  outcome: 'done' | 'failed';
  attempt: number;
  errorKind: CompanyPullErrorKind | null;
  selfHealed: boolean;
}

export interface CompanyPullDeps {
  /**
   * Start a scoped sync for one company and resolve with what it reported.
   * Rejects when the sync could not start (the message is the native error).
   */
  runSync: (slug: string) => Promise<CompanyPullRunResult>;
  /** Provision a company whose bucket is missing; resolves when ready or failed. */
  provision: (companyUid: string) => Promise<ProvisioningState>;
  sleep?: (ms: number) => Promise<void>;
  /** Stop early (the wizard was torn down). */
  cancelled?: () => boolean;
  busyRetryMs?: number;
  busyRetryLimit?: number;
}

export const COMPANY_PULL_BUSY_RETRY_MS = 3_000;
/** About ten minutes of waiting for another sync (the runner's own hard timeout). */
export const COMPANY_PULL_BUSY_RETRY_LIMIT = 200;

export function initialPullRows(companies: readonly CompanyPullCompany[]): CompanyPullRow[] {
  const seen = new Set<string>();
  const rows: CompanyPullRow[] = [];
  for (const company of companies) {
    if (!company.slug || seen.has(company.companyUid)) continue;
    seen.add(company.companyUid);
    rows.push({ ...company, status: 'queued', attempts: 0, errorKind: null });
  }
  return rows;
}

/** No company is waiting or pulling. */
export function pullSettled(rows: readonly CompanyPullRow[]): boolean {
  return rows.every((row) => row.status === 'done' || row.status === 'failed');
}

/** Every company is on this Mac. */
export function pullSucceeded(rows: readonly CompanyPullRow[]): boolean {
  return rows.every((row) => row.status === 'done');
}

export function pullFailures(rows: readonly CompanyPullRow[]): CompanyPullRow[] {
  return rows.filter((row) => row.status === 'failed');
}

export function withRowStatus(
  rows: readonly CompanyPullRow[],
  companyUid: string,
  patch: Partial<Pick<CompanyPullRow, 'status' | 'attempts' | 'errorKind'>>,
): CompanyPullRow[] {
  return rows.map((row) => (row.companyUid === companyUid ? { ...row, ...patch } : row));
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /already running/i.test(message);
}

/** Run one scoped sync, waiting while another sync holds the runner. */
async function runWhenFree(
  slug: string,
  deps: CompanyPullDeps,
): Promise<{ ok: true; result: CompanyPullRunResult } | { ok: false; errorKind: CompanyPullErrorKind }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const limit = deps.busyRetryLimit ?? COMPANY_PULL_BUSY_RETRY_LIMIT;
  for (let attempt = 0; ; attempt += 1) {
    if (deps.cancelled?.()) return { ok: false, errorKind: 'aborted' };
    try {
      return { ok: true, result: await deps.runSync(slug) };
    } catch (error) {
      if (!isBusyError(error)) {
        console.warn('onboarding: company pull could not start', error);
        return { ok: false, errorKind: 'start_failed' };
      }
      if (attempt >= limit) return { ok: false, errorKind: 'busy' };
      await sleep(deps.busyRetryMs ?? COMPANY_PULL_BUSY_RETRY_MS);
    }
  }
}

/**
 * Pull one company: a scoped sync, then at most one provisioning self-heal
 * and a second sync when the bucket was missing.
 */
export async function pullCompany(
  row: Pick<CompanyPullRow, 'companyUid' | 'slug'>,
  deps: CompanyPullDeps,
): Promise<{ ok: boolean; errorKind: CompanyPullErrorKind | null; selfHealed: boolean; spawnFailed?: boolean }> {
  let selfHealed = false;
  for (;;) {
    const run = await runWhenFree(row.slug, deps);
    if (!run.ok) return { ok: false, errorKind: run.errorKind, selfHealed };
    const { result } = run;
    if (result.spawnFailed) return { ok: false, errorKind: 'start_failed', selfHealed, spawnFailed: true };
    if (result.timedOut) return { ok: false, errorKind: 'timeout', selfHealed };
    if (result.aborted) return { ok: false, errorKind: 'aborted', selfHealed };
    const missingBucket = result.errors.filter((entry) => isMissingBucketMessage(entry.message));
    if (missingBucket.length < result.errors.length) return { ok: false, errorKind: 'sync_error', selfHealed };
    if (missingBucket.length === 0) return { ok: true, errorKind: null, selfHealed };
    if (selfHealed) return { ok: false, errorKind: 'provisioning', selfHealed };
    selfHealed = true;
    const uid = companyUidFromMissingBucket(missingBucket[0]!.message) ?? row.companyUid;
    const state = await deps.provision(uid);
    if (deps.cancelled?.()) return { ok: false, errorKind: 'aborted', selfHealed };
    if (state.status !== 'ready') return { ok: false, errorKind: 'provisioning', selfHealed };
  }
}

/**
 * Pull the given companies in order. `onRows` gets every state change so the
 * Ready screen can show per-company progress; `onOutcome` gets one record per
 * finished attempt for telemetry. Only companies that are queued or failed are
 * pulled, so the same call serves the first run and Try again. When the sync
 * process cannot be spawned, every company still waiting fails at once.
 */
export async function runCompanyPull(options: {
  rows: readonly CompanyPullRow[];
  only?: readonly string[];
  deps: CompanyPullDeps;
  onRows: (rows: CompanyPullRow[]) => void;
  onOutcome?: (outcome: CompanyPullOutcome) => void;
}): Promise<CompanyPullRow[]> {
  const targets = options.rows
    .filter((row) => row.status === 'queued' || row.status === 'failed')
    .filter((row) => !options.only || options.only.includes(row.companyUid))
    .map((row) => row.companyUid);
  let rows = options.rows.map((row) =>
    targets.includes(row.companyUid) ? { ...row, status: 'queued' as const, errorKind: null } : row,
  );
  options.onRows(rows);
  for (const [index, companyUid] of targets.entries()) {
    if (options.deps.cancelled?.()) break;
    const row = rows.find((candidate) => candidate.companyUid === companyUid)!;
    const attempt = row.attempts + 1;
    rows = withRowStatus(rows, companyUid, { status: 'pulling', attempts: attempt, errorKind: null });
    options.onRows(rows);
    const result = await pullCompany(row, options.deps);
    rows = withRowStatus(rows, companyUid, {
      status: result.ok ? 'done' : 'failed',
      errorKind: result.errorKind,
    });
    options.onRows(rows);
    options.onOutcome?.({
      companyUid,
      outcome: result.ok ? 'done' : 'failed',
      attempt,
      errorKind: result.errorKind,
      selfHealed: result.selfHealed,
    });
    if (result.spawnFailed) {
      const rest = targets.slice(index + 1);
      if (rest.length === 0) break;
      rows = rows.map((candidate) =>
        rest.includes(candidate.companyUid)
          ? { ...candidate, status: 'failed' as const, attempts: candidate.attempts + 1, errorKind: 'start_failed' as const }
          : candidate,
      );
      options.onRows(rows);
      for (const restUid of rest) {
        options.onOutcome?.({
          companyUid: restUid,
          outcome: 'failed',
          attempt: rows.find((candidate) => candidate.companyUid === restUid)!.attempts,
          errorKind: 'start_failed',
          selfHealed: false,
        });
      }
      break;
    }
  }
  return rows;
}
