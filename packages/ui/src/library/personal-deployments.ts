/**
 * Personal deployments across scopes (US-031). Cache-first. Status colors
 * stay on the existing live/error tokens. A deploying row keeps its previous
 * build serving until swap.
 */

import { deployProgress, type DeployProgress } from "../company/deploy-progress.js";

export type PersonalDeployStatus =
  | "active"
  | "building"
  | "deploying"
  | "failed"
  | "sleeping"
  | "deactivated";

export type PersonalDeployFilter =
  | "all"
  | "active"
  | "sleeping"
  | "deactivated"
  | "scope-personal"
  | "scope-company"
  | "by-you"
  | "by-bots";

export interface PersonalDeployment {
  id: string;
  name: string;
  /** Full https URL the Visit button opens. */
  url: string;
  host: string;
  project: string;
  detail: string;
  scope: "personal" | "company";
  scopeLabel: string;
  scopeMark: string;
  status: PersonalDeployStatus;
  access: string;
  /** null = analytics unavailable for this app. Never shown as 0. */
  views30d: number | null;
  lastVisit: string;
  /** Absolute last visit (ISO). The page re-renders `lastVisit` from it every 30 s (QA-069). */
  lastVisitAt?: string;
  /** 1-based deploy step when status is deploying or building. */
  step: number | null;
  liveVersion: string;
  nextVersion: string;
  byYou: boolean;
  byBot: boolean;
  log: string[];
}

export interface PersonalDeploymentsCache {
  rows: PersonalDeployment[];
}

/** One deploy scope the page reads: a company, or the caller's personal scope. */
export interface DeployScope {
  /** Company slug, or "personal". */
  id: string;
  label: string;
}

/** Raw `/api/apps` scope page as returned by the `list_deploy_apps` command. */
export interface DeployAppsPage {
  callerSub?: string | null;
  apps?: unknown[];
}

export type ListDeployApps = (scope: string) => Promise<DeployAppsPage>;

const memory = new Map<string, PersonalDeploymentsCache>();
const STORAGE_PREFIX = "hq.personal-deployments.v2:";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch (err) {
    console.warn("[deployments] localStorage unavailable", err);
    return null;
  }
}

export function readPersonalDeploymentsCache(accountId: string): PersonalDeploymentsCache | null {
  const warm = memory.get(accountId);
  if (warm) return warm;
  const raw = storage()?.getItem(STORAGE_PREFIX + accountId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersonalDeploymentsCache;
    if (!Array.isArray(parsed?.rows)) return null;
    memory.set(accountId, parsed);
    return parsed;
  } catch (err) {
    console.warn("[deployments] dropping unreadable cache", err);
    return null;
  }
}

export function writePersonalDeploymentsCache(
  accountId: string,
  value: PersonalDeploymentsCache,
): void {
  if (!accountId) return;
  memory.set(accountId, value);
  try {
    storage()?.setItem(STORAGE_PREFIX + accountId, JSON.stringify(value));
  } catch (err) {
    console.warn("[deployments] cache write failed", err);
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function initials(label: string): string {
  const letters = label.replace(/[^A-Za-z0-9]/g, "");
  return letters.slice(0, 2).toUpperCase();
}

/** "3m ago" style age. Empty when the timestamp is missing or unreadable. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!iso || Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

function accessLabel(app: Record<string, unknown>): string {
  switch (str(app.accessMode)) {
    case "company":
      return "Company";
    case "selected":
      return "Selected people";
    case "password":
      return "Password";
    case "private":
      return "Invited only";
    case "public":
      return "Public";
  }
  if (app.privateMode === true) return "Invited only";
  if (app.passwordProtected === true) return "Password";
  return "Public";
}

function statusOf(app: Record<string, unknown>): PersonalDeployStatus {
  if (app.active === false) return "deactivated";
  const status = str(app.status).toLowerCase();
  // OWNER-R34: hq-deploy records an idle SSR app's sleep on computeStatus
  // ("sleeping" / "waking"); status stays "active". Reading status alone
  // counted every sleeping app as active.
  const compute = str(app.computeStatus).toLowerCase();
  if (status !== "failed" && status !== "deploying" && status !== "inactive" && (compute === "sleeping" || compute === "waking")) return "sleeping";
  if (status === "sleeping" || status === "paused") return "sleeping";
  if (status === "failed" || status === "error") return "failed";
  if (status === "building") return "building";
  if (status === "deploying") return "deploying";
  if (status === "deactivated" || status === "inactive" || status === "deleted") return "deactivated";
  return "active";
}

/** Map one raw hq-deploy app into a page row. Null when it has no name. */
export function deploymentFromApp(
  raw: unknown,
  scope: DeployScope,
  callerSub: string | null | undefined,
  now: number = Date.now(),
): PersonalDeployment | null {
  if (!raw || typeof raw !== "object") return null;
  const app = raw as Record<string, unknown>;
  const sub = str(app.subdomain);
  const name = str(app.name) || sub;
  if (!name) return null;
  const url = str(app.url).startsWith("https://") ? str(app.url) : "";
  let host = "";
  if (url) {
    try {
      const hostname = new URL(url).hostname;
      host = sub && hostname.startsWith(`${sub}.`) ? hostname.slice(sub.length) : hostname;
    } catch (err) {
      console.warn("[deployments] unreadable app url", err);
    }
  }
  const deployedAt = str(app.deployedAt) || str(app.updatedAt) || str(app.createdAt);
  const deployedBy = str(app.deployedBy);
  const ownerId = str(app.ownerId);
  const byYou = Boolean(callerSub && ownerId && ownerId === callerSub);
  const age = relativeAge(deployedAt, now);
  const who = deployedBy || (byYou ? "you" : "");
  const detail = [age && `deployed ${age}`, who && `by ${who}`].filter(Boolean).join(" ");
  const views = app.views30d;
  const scopeLabel = scope.id === "personal" ? "Personal" : scope.label;
  const version = str(app.version) || str(app.liveVersion);
  return {
    id: `${scope.id}:${str(app.id) || sub || name}`,
    name,
    url,
    host,
    project: str(app.project) || str(app.projectSlug),
    detail,
    scope: scope.id === "personal" ? "personal" : "company",
    scopeLabel,
    scopeMark: initials(scopeLabel),
    status: statusOf(app),
    access: accessLabel(app),
    views30d: typeof views === "number" && Number.isFinite(views) ? views : null,
    lastVisit: relativeAge(str(app.lastVisitAt), now),
    lastVisitAt: str(app.lastVisitAt) || undefined,
    step: null,
    liveVersion: version,
    nextVersion: version,
    byYou,
    byBot: app.deployedByKind === "agent" || app.ownerKind === "agent",
    log: [],
  };
}

export interface DeploymentsLoad {
  cache: PersonalDeploymentsCache;
  /** Scopes that failed to load. Their rows are absent, not zeroed. */
  failed: string[];
}

/**
 * Read every scope in parallel and merge. One failing scope does not blank
 * the others. Rows sort by scope, then name.
 */
export async function loadDeployments(
  list: ListDeployApps,
  scopes: readonly DeployScope[],
  now: number = Date.now(),
): Promise<DeploymentsLoad> {
  const results = await Promise.allSettled(scopes.map((scope) => list(scope.id)));
  const rows: PersonalDeployment[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  results.forEach((result, index) => {
    const scope = scopes[index]!;
    if (result.status === "rejected") {
      console.warn(`[deployments] scope ${scope.id} failed`, result.reason);
      failed.push(scope.id);
      return;
    }
    for (const raw of result.value.apps ?? []) {
      const row = deploymentFromApp(raw, scope, result.value.callerSub, now);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  });
  rows.sort((a, b) => a.scopeLabel.localeCompare(b.scopeLabel) || a.name.localeCompare(b.name));
  return { cache: { rows }, failed };
}

export function formatViews(views: number | null): string {
  return views === null ? "—" : views.toLocaleString();
}

export function filterDeployments(
  rows: readonly PersonalDeployment[],
  filter: PersonalDeployFilter,
  query: string,
): PersonalDeployment[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === "active" && row.status !== "active" && row.status !== "deploying" && row.status !== "building") {
      return false;
    }
    if (filter === "sleeping" && row.status !== "sleeping") return false;
    if (filter === "deactivated" && row.status !== "deactivated") return false;
    if (filter === "scope-personal" && row.scope !== "personal") return false;
    if (filter === "scope-company" && row.scope !== "company") return false;
    if (filter === "by-you" && !row.byYou) return false;
    if (filter === "by-bots" && !row.byBot) return false;
    if (!q) return true;
    return `${row.name} ${row.host} ${row.project} ${row.scopeLabel}`.toLowerCase().includes(q);
  });
}

/** OWNER-R34: the header pills. Status and scope combine; the toggles narrow further. */
export type DeployStatusPill = "all" | "active" | "sleeping" | "deactivated";
export type DeployScopePill = "all" | "personal" | "company";
export interface DeployFilterPills {
  status: DeployStatusPill;
  scope: DeployScopePill;
  byYou: boolean;
  byBots: boolean;
}
export const DEFAULT_DEPLOY_PILLS: DeployFilterPills = { status: "all", scope: "all", byYou: false, byBots: false };

export function filterDeploymentsBy(
  rows: readonly PersonalDeployment[],
  pills: DeployFilterPills,
  query: string,
): PersonalDeployment[] {
  let out = filterDeployments(rows, pills.status, query);
  if (pills.scope !== "all") out = filterDeployments(out, pills.scope === "personal" ? "scope-personal" : "scope-company", "");
  if (pills.byYou) out = filterDeployments(out, "by-you", "");
  if (pills.byBots) out = filterDeployments(out, "by-bots", "");
  return out;
}

export function pillsAreDefault(pills: DeployFilterPills): boolean {
  return pills.status === "all" && pills.scope === "all" && !pills.byYou && !pills.byBots;
}

export function progressFor(row: PersonalDeployment): DeployProgress {
  return deployProgress({
    step: row.step,
    liveVersion: row.liveVersion,
    nextVersion: row.nextVersion,
  });
}

export function statusLabel(row: PersonalDeployment): string {
  if (row.status === "deploying") {
    const step = progressFor(row).step;
    return `Deploying · ${step}/5`;
  }
  if (row.status === "building") return "Building";
  if (row.status === "failed") return "Failed";
  if (row.status === "sleeping") return "Sleeping";
  if (row.status === "deactivated") return "Deactivated";
  return "Active";
}
