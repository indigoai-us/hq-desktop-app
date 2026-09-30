/**
 * Plan-limit refusals from hq-pro (hard-stop-readiness US-018).
 *
 * hq-pro refuses a create that would take a Starter company past a limit with
 * HTTP 402 and one body shape:
 *
 *   { error: "plan_limit_reached", code: "PLAN_LIMIT_EXCEEDED", status: 402,
 *     blocked, resources: [{ resource, used, limit }], message, fixOptions,
 *     freeMonth?, upgradeUrl }
 *
 * Two older shapes are still in the field and must keep working:
 *   - membership `{ code: "PLAN_LIMIT_EXCEEDED", resource, used, limit,
 *     requiredPlan, upgradeUrl, message? }`
 *   - personal presign item `{ error: "<sentence>", code: "PLAN_LIMIT_REACHED",
 *     upgradeUrl }` inside a 200 `results[]`
 *
 * Both desktop adapters and the web adapter map every non-2xx hq-pro body
 * through {@link parseHqProErrorBody}, so a refusal reaches the UI as a
 * readable sentence plus the server's upgrade link instead of the machine
 * token `plan_limit_reached`. A refusal is an expected product state, not a
 * defect: nothing here reports to Sentry, and callers must not either.
 */

import type { AdapterFailure } from "./adapter.js";

/** Current hard-stop code (and the legacy membership code). */
export const PLAN_LIMIT_EXCEEDED = "PLAN_LIMIT_EXCEEDED";
/** Legacy personal-scope presign skip code. */
export const PLAN_LIMIT_REACHED = "PLAN_LIMIT_REACHED";
/** `error` token of the current hard-stop body. */
export const PLAN_LIMIT_REACHED_ERROR = "plan_limit_reached";

/**
 * Hosts hq-pro puts in `upgradeUrl`.
 *
 * Every builder on hq-pro main (`resolvePlanLockUpgradeUrl`,
 * `buildPlanLimitUpgradeUrl`, `personalPlanUpgradeUrl`) derives the link from
 * `CONSOLE_BASE_URL`, which every deployed stage leaves at its default
 * `https://hq.computer`. The retired `app.indigo-hq.com/billing/upgrade` link
 * 404s and is deliberately not allowed; marketing hosts are not upgrade
 * destinations. Widen this only when hq-pro starts returning another host.
 */
export const PLAN_UPGRADE_HOSTS: readonly string[] = Object.freeze([
  "hq.computer",
]);

/**
 * Return the normalized upgrade URL when it is a credential-free HTTPS link on
 * a host hq-pro returns, otherwise null. The link is server-selected, but it
 * is still external input to a shell `open`, so it is checked before any
 * surface renders an action for it.
 */
export function approvedPlanUpgradeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  if (!PLAN_UPGRADE_HOSTS.includes(url.hostname.toLowerCase())) return null;
  return url.toString();
}

/** True for every code or error token hq-pro uses for a plan-limit refusal. */
export function isPlanLimitCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const token = value.trim();
  return (
    token === PLAN_LIMIT_EXCEEDED ||
    token === PLAN_LIMIT_REACHED ||
    token === PLAN_LIMIT_REACHED_ERROR
  );
}

/** True when an adapter failure is a plan-limit refusal. */
export function isPlanLimitFailure(
  result: { ok: boolean; code?: string } | null | undefined,
): boolean {
  return Boolean(result && result.ok === false && isPlanLimitCode(result.code));
}

export interface PlanLimitResourceRow {
  resource: string;
  used: number | null;
  limit: number | null;
}

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  users: "Members",
  secrets: "Secrets",
  deployments: "Deployments",
  storageBytes: "Storage",
  integrations: "Integrations",
  agents: "Agents",
};

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function formatStorage(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) {
    const rounded = Math.round(gb * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} GB`;
  }
  const mb = bytes / 1024 ** 2;
  return `${Math.max(0, Math.round(mb))} MB`;
}

function formatAmount(resource: string, value: number): string {
  return resource === "storageBytes"
    ? formatStorage(value)
    : Math.floor(value).toLocaleString("en-US");
}

/** "Storage: 10.2 GB of 10 GB used." — one sentence per over-limit resource. */
export function describePlanLimitResource(row: PlanLimitResourceRow): string {
  const label = RESOURCE_LABELS[row.resource] ?? row.resource;
  if (row.used === null || row.limit === null) {
    return `${label}: limit reached.`;
  }
  return `${label}: ${formatAmount(row.resource, row.used)} of ${formatAmount(row.resource, row.limit)} used.`;
}

function resourceRows(rec: Record<string, unknown>): PlanLimitResourceRow[] {
  const rows: PlanLimitResourceRow[] = [];
  if (Array.isArray(rec.resources)) {
    for (const entry of rec.resources) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.resource !== "string" || !row.resource.trim()) continue;
      rows.push({
        resource: row.resource.trim(),
        used: finiteCount(row.used),
        limit: finiteCount(row.limit),
      });
    }
    return rows;
  }
  if (typeof rec.resource === "string" && rec.resource.trim()) {
    rows.push({
      resource: rec.resource.trim(),
      used: finiteCount(rec.used),
      limit: finiteCount(rec.limit),
    });
  }
  return rows;
}

const DEFAULT_PLAN_LIMIT_MESSAGE = "Your plan limit is reached.";

/**
 * The readable sentence for a plan-limit body: the server's `message` (or a
 * legacy human `error`), followed by the resource usage it carries.
 */
export function planLimitMessageFromBody(rec: Record<string, unknown>): string {
  const message =
    typeof rec.message === "string" && rec.message.trim()
      ? rec.message.trim()
      : typeof rec.error === "string" &&
          rec.error.trim() &&
          !isPlanLimitCode(rec.error)
        ? rec.error.trim()
        : DEFAULT_PLAN_LIMIT_MESSAGE;
  const usage = resourceRows(rec).map(describePlanLimitResource);
  return usage.length > 0 ? `${message} ${usage.join(" ")}` : message;
}

export interface HqProErrorDetails {
  code: string;
  message: string;
  /** Present only when the body carried an approved upgrade link. */
  upgradeUrl?: string;
  planLimit: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Classify one hq-pro error record (an HTTP error body, or one per-item
 * refusal inside a 200 presign batch).
 */
export function hqProErrorFromRecord(
  rec: Record<string, unknown>,
  defaults: { code: string; message: string },
): HqProErrorDetails {
  // Other 402s (a plan-required feature gate such as MEETING_PLAN_REQUIRED)
  // keep their own code and text; they still keep an approved upgrade link.
  const upgradeUrl = approvedPlanUpgradeUrl(rec.upgradeUrl);
  const planLimit = isPlanLimitCode(rec.code) || isPlanLimitCode(rec.error);
  const code =
    typeof rec.code === "string" && rec.code.trim()
      ? rec.code.trim()
      : planLimit
        ? PLAN_LIMIT_EXCEEDED
        : defaults.code;
  // Only a plan-limit body is read by its `message`. Other bodies keep the
  // historical `error` mapping: API Gateway's generic `{ message: "Not Found" }`
  // must stay the status default so callers can recognise a missing route.
  let message = defaults.message;
  if (planLimit) {
    message = planLimitMessageFromBody(rec);
  } else if (typeof rec.error === "string" && rec.error.trim()) {
    message = rec.error.trim();
  }
  return {
    code,
    message,
    planLimit,
    ...(upgradeUrl ? { upgradeUrl } : {}),
  };
}

/**
 * Map a non-2xx hq-pro response body to the failure code, readable message and
 * upgrade link the UI shows. Non-JSON bodies keep the status defaults.
 */
export function parseHqProErrorBody(
  status: number | null,
  text: string,
  fallbackMessage: string,
): HqProErrorDetails {
  const defaults = {
    code: status === null ? "http-error" : `http-${status}`,
    message: fallbackMessage,
  };
  let rec: Record<string, unknown> | null = null;
  try {
    rec = asRecord(text ? JSON.parse(text) : null);
  } catch {
    rec = null;
  }
  if (!rec) {
    return { code: defaults.code, message: defaults.message, planLimit: false };
  }
  return hqProErrorFromRecord(rec, defaults);
}

/** Adapter failure for a parsed hq-pro error; keeps the upgrade link. */
export function hqProFailure(details: HqProErrorDetails): AdapterFailure {
  return {
    ok: false,
    reason: "error",
    code: details.code,
    message: details.message,
    ...(details.upgradeUrl ? { upgradeUrl: details.upgradeUrl } : {}),
  };
}
