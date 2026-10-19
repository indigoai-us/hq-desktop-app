/**
 * Company Outpost list, detail, and provision (desktop lane A).
 *
 * States on the list are running, preparing, needs attention, and blocked.
 * Manage actions are owners and admins only. A failed provision never adds a
 * row. Customer copy follows the approved desktop prototype, sentence case,
 * with no exclamation marks.
 */

import type { NavigationDestination } from "../shell/navigation-history.js";

export const OUTPOST_JOBS_ROUTE = "outpost-jobs";

/** The outpost-jobs screen for one company Outpost. Same shape as the jobs lane. */
export function outpostJobsDestination(companyUid: string, outpostId?: string | null): NavigationDestination {
  const params = new URLSearchParams();
  if (outpostId) params.set("outpostId", outpostId);
  if (companyUid) params.set("company", companyUid);
  const param = params.toString();
  return {
    kind: "extra",
    page: OUTPOST_JOBS_ROUTE,
    companyUid,
    ...(param ? { param } : {}),
  };
}

export const COMPANY_OUTPOST_CAP = 5;

export const PREP_STEPS = [
  "Checking that the company can add an Outpost.",
  "Starting the machine.",
  "Applying the company setup.",
  "Confirming the Outpost is ready for Claude sign-in.",
] as const;

/** A new Outpost takes about seven minutes to build. */
export const PREP_BUILD_MS = 7 * 60_000;

/** Step shown after the build has run for now - startedAt, spread over the build time. */
export function prepStepAt(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt) || startedAt <= 0 || now <= startedAt) return 0;
  const slot = PREP_BUILD_MS / PREP_STEPS.length;
  return Math.min(PREP_STEPS.length - 1, Math.floor((now - startedAt) / slot));
}

/** Longest wait between automatic checks after an unexpected answer. */
export const POLL_BACKOFF_MAX_MS = 2 * 60_000;

/** Automatic checks stop after this long of unexpected answers. Check now still works. */
export const POLL_ERROR_LIMIT_MS = 10 * 60_000;

export function nextPollDelay(pollMs: number, previous: number): number {
  return Math.min(POLL_BACKOFF_MAX_MS, Math.max(pollMs, previous) * 2);
}

/** Blocked reasons that mean the company cannot use Outposts yet. Same list as the jobs page. */
export const NOT_AVAILABLE_CODES: readonly string[] = [
  "billing_required",
  "payment_not_set_up",
  "payment_required",
  "payment_method_required",
];

export function isNotAvailableCode(code: string): boolean {
  return NOT_AVAILABLE_CODES.includes(code.trim().toLowerCase());
}

export type CompanyOutpostRole = "owner" | "admin" | "member" | "guest";

export type CompanyOutpostState = "running" | "preparing" | "needs_attention" | "blocked";

export type JobHealth = "ok" | "missed" | "blocked" | "stale" | "unknown";

export interface JobHealthCounts {
  ok: number;
  missed: number;
  blocked: number;
  stale: number;
  unknown: number;
}

export interface CompanyOutpostListItem {
  id: string;
  name: string;
  state: CompanyOutpostState;
  lastSeenAt: string | null;
  jobsCount: number;
  jobHealth: JobHealthCounts;
  /** Blocked because the company cannot use Outposts yet. */
  unavailable?: boolean;
}

export interface CompanyOutpostMachine {
  region: string;
  instanceId: string;
  createdAt: string;
}

export interface CompanyOutpostJob {
  id: string;
  name: string;
  health: JobHealth;
  lastRunAt: string | null;
  nextRunAt: string | null;
  summary: string;
}

export interface CompanyOutpostRun {
  id: string;
  jobId: string;
  jobName: string;
  at: string | null;
  health: JobHealth;
}

export interface CompanyOutpostDetail extends CompanyOutpostListItem {
  machine: CompanyOutpostMachine;
  jobs: CompanyOutpostJob[];
  runs: CompanyOutpostRun[];
  stopped: boolean;
}

export type ProvisionResult =
  | { status: "pending"; attemptId: string }
  | { status: "success"; outpost: CompanyOutpostListItem }
  | { status: "already_exists"; outpostId?: string }
  | { status: "unavailable" }
  | { status: "failure"; message: string }
  | { status: "forbidden" }
  // A status read failed. The add may still be in progress, so the screen
  // keeps checking. signIn is set when the HQ sign-in expired. backoff is set
  // on an unexpected 400, 409, or 429 so the screen waits longer each time.
  | { status: "checking"; signIn: boolean; backoff?: true };

export function canManageRole(role: CompanyOutpostRole): boolean {
  return role === "owner" || role === "admin";
}

export function emptyHealth(): JobHealthCounts {
  return { ok: 0, missed: 0, blocked: 0, stale: 0, unknown: 0 };
}

export function stateLabel(state: CompanyOutpostState): string {
  if (state === "running") return "Running";
  if (state === "preparing") return "Preparing";
  if (state === "blocked") return "Blocked";
  return "Needs attention";
}

export function healthLabel(health: JobHealth): string {
  if (health === "ok") return "Ran on time";
  if (health === "missed") return "Missed";
  if (health === "blocked") return "Blocked";
  if (health === "stale") return "Out of date";
  return "Unknown";
}

export function jobHealthSummary(health: JobHealthCounts, jobsCount: number): string {
  if (jobsCount <= 0) return "No jobs";
  const parts: string[] = [];
  const add = (count: number, word: string) => {
    if (count > 0) parts.push(`${count} ${word}`);
  };
  add(health.ok, "ran on time");
  add(health.missed, "missed");
  add(health.blocked, "blocked");
  add(health.stale, "out of date");
  add(health.unknown, "unknown");
  return parts.length > 0 ? parts.join(", ") : "No job results yet";
}

export function lastSeenLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return "Last seen never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "Last seen never";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (minutes < 1) return "Last seen just now";
  if (minutes < 60) return `Last seen ${unit(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last seen ${unit(hours, "hour")} ago`;
  return `Last seen ${unit(Math.round(hours / 24), "day")} ago`;
}

export function whenLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return "Never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "Never";
  return lastSeenLabel(iso, now).replace(/^Last seen /, "");
}

/** Prototype blocked note. Admins and members get different sentences. */
export function blockedNote(role: CompanyOutpostRole): string {
  if (canManageRole(role)) {
    return "This Outpost needs attention. Scheduled jobs are paused. HQ has been notified and will follow up by email. You can also remove it and add a new one.";
  }
  return "This Outpost needs attention. Scheduled jobs are paused. An owner or admin has been notified.";
}

export function needsAttentionNote(stopped: boolean): string {
  if (stopped) return "This Outpost is stopped. Scheduled jobs are paused until it is started.";
  return "This Outpost needs attention. Scheduled jobs are paused until it is ready.";
}

const NAME_POOL = ["quiet-pine", "clear-brook", "bright-meadow", "gentle-cedar", "silver-birch"];

export function nextOutpostName(existing: readonly string[]): string {
  let n = 0;
  for (;;) {
    const base = NAME_POOL[n % NAME_POOL.length]!;
    const candidate = n < NAME_POOL.length ? base : `${base}-${Math.floor(n / NAME_POOL.length) + 1}`;
    if (!existing.includes(candidate)) return candidate;
    n += 1;
  }
}

export function renameError(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed) || trimmed.length > 40) {
    return "Use 1 to 40 lowercase letters, numbers, and single dashes between words.";
  }
  return "";
}

/**
 * Only a successful provision adds a row. Pending, already-exists, unavailable,
 * failure, and forbidden leave the list exactly as it was, including when a
 * failure body named an id.
 */
export function listAfterProvision(
  items: readonly CompanyOutpostListItem[],
  result: ProvisionResult,
): CompanyOutpostListItem[] {
  if (result.status !== "success") return items.map((item) => ({ ...item, jobHealth: { ...item.jobHealth } }));
  if (items.some((item) => item.id === result.outpost.id)) {
    return items.map((item) => ({ ...item, jobHealth: { ...item.jobHealth } }));
  }
  return [...items.map((item) => ({ ...item, jobHealth: { ...item.jobHealth } })), { ...result.outpost, jobHealth: { ...result.outpost.jobHealth } }];
}

export function mapLifecycleState(input: {
  state?: string;
  stopped?: boolean;
  blocked?: boolean;
  /** False only when the status payload says sign-in has not happened. */
  signedIn?: boolean;
}): CompanyOutpostState {
  const raw = (input.state ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (input.blocked || raw === "blocked" || raw === "outcome_unknown") return "blocked";
  if (
    raw === "provisioning" ||
    raw === "confirming" ||
    raw === "preparing" ||
    raw === "pending" ||
    raw === "starting" ||
    raw === "stopping" ||
    raw === "destroying"
  ) {
    return "preparing";
  }
  if (input.stopped || raw === "stopped" || raw === "needs_attention" || raw === "offline") return "needs_attention";
  if (raw === "ready" && input.signedIn === false) return "needs_attention";
  if (raw === "running" || raw === "ready" || raw === "signed") return "running";
  return "needs_attention";
}

export function countsFromJobs(jobs: readonly { health: JobHealth }[]): JobHealthCounts {
  const health = emptyHealth();
  for (const job of jobs) {
    if (job.health in health) health[job.health] += 1;
    else health.unknown += 1;
  }
  return health;
}

const SECRET_KEY = /secret|token|password|credential|private|refresh|session/i;

/** Drop secret-like keys. Region, instance id, and created date stay. */
export function publicMachine(raw: Record<string, unknown> | null | undefined): CompanyOutpostMachine {
  const source = raw ?? {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (SECRET_KEY.test(key)) continue;
    clean[key] = value;
  }
  return {
    region: asString(clean.region),
    instanceId: asString(clean.instanceId) || asString(clean.instance),
    createdAt: asString(clean.createdAt),
  };
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function failureCopy(): string {
  return "The Outpost was not added.";
}

/** Shown when the company cannot add Outposts yet. */
export const UNAVAILABLE_COPY = "Outposts are not available for this company yet.";
