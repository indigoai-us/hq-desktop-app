/**
 * "Usage this month" panel in the Core menu.
 *
 * Every number comes from hq-pro, never from this file:
 * - `GET /v1/billing/summary?companyUid=` (owner-gated) says whether the
 *   company is usage-priced (`pricingPlan: "usage-only"`), its coarse plan,
 *   and whether a card is on file.
 * - `GET /v1/billing/usage?companyUid=&window=month` (owner-gated) is the
 *   month-to-date statement hq-pro prices from the daily usage rollup: usage
 *   so far, the included allowance, the period, and one line per meter.
 *
 * This module only groups the statement's meter lines under plain labels and
 * turns the reads into a view. A meter hq-pro could not measure
 * (`costCents: null`) is "not reported", never $0. A failed read is
 * "unavailable", never zero usage.
 */

import type { AdapterResult, Json } from "@hq/platform";
import { isUsageOnlySummary } from "../company/usage-billing.js";

export const COMPARE_PLANS_URL = "https://hqforwork.com/pricing";

export interface UsageGroupDef {
  id: "assistant" | "meetings" | "storage";
  label: string;
  /** Rate-card meter keys (`UsageMeterKey` in hq-pro usage-rate-card.ts). */
  keys: readonly string[];
  /** Matches meter keys the card adds later (e.g. a `meeting-*` meter). */
  prefix?: string;
}

/**
 * Plain labels for the rate card's meters, in display order. The card has no
 * meeting meter today, so "Meeting notes" shows only once hq-pro reports one.
 */
export const USAGE_GROUPS: readonly UsageGroupDef[] = [
  { id: "assistant", label: "Assistant and bots", keys: ["agent-run", "hq-mcp-call", "integration-call"] },
  { id: "meetings", label: "Meeting notes", keys: [], prefix: "meeting" },
  { id: "storage", label: "Storage and sync", keys: ["member-sync", "storage", "secret", "vault"] },
];

/** Label for meter keys no group claims, so new meters are never dropped. */
export const OTHER_USAGE_LABEL = "Other usage";

export type UsageLineStatus = "measured" | "partial" | "unavailable" | "not-billed-yet";

export interface UsageLine {
  key: string;
  status: UsageLineStatus | null;
  billed: boolean;
  costCents: number | null;
}

export interface MonthStatement {
  periodStart: string;
  periodEnd: string | null;
  complete: boolean;
  allowanceCents: number;
  usageCents: number;
  lines: UsageLine[];
}

export type UsageAmount =
  | { kind: "amount"; cents: number; partial: boolean }
  | { kind: "not-reported" };

export interface UsageGroupRow {
  id: string;
  label: string;
  amount: UsageAmount;
}

export interface UsageMeterView {
  /** 0..1 share of the included usage used, for the bar's `--fill`. */
  fill: number;
  over: boolean;
  usedLine: string;
  resetLine: string | null;
  partial: boolean;
  rows: UsageGroupRow[];
}

export type CoreUsageView =
  | { kind: "loading"; companyName: string }
  | { kind: "owner-only"; companyName: string }
  | { kind: "unavailable"; companyName: string }
  | {
      kind: "ready";
      companyName: string;
      planLabel: string | null;
      /** Card on file (or a paid plan): Manage billing instead of Set up billing. */
      paid: boolean;
      /** Null for a company not on usage pricing: no meter is shown. */
      usage: UsageMeterView | null;
      /** True when the company is usage-priced but the statement read failed. */
      usageUnavailable: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

const LINE_STATUSES: ReadonlySet<string> = new Set(["measured", "partial", "unavailable", "not-billed-yet"]);

/** A month statement from `GET /v1/billing/usage`, or null when the body is not one. */
export function monthStatementFromBody(body: unknown): MonthStatement | null {
  if (!isRecord(body)) return null;
  const allowanceCents = finite(body.allowanceCents);
  const usageCents = finite(body.usageCents);
  const periodStart = str(body.periodStart);
  if (allowanceCents === null || usageCents === null || !periodStart) return null;
  const lines = Array.isArray(body.lines)
    ? body.lines.filter(isRecord).flatMap((line): UsageLine[] => {
        const key = str(line.key);
        if (!key) return [];
        const status = typeof line.status === "string" && LINE_STATUSES.has(line.status)
          ? (line.status as UsageLineStatus)
          : null;
        return [{ key, status, billed: line.billed !== false, costCents: finite(line.costCents) }];
      })
    : [];
  return {
    periodStart,
    periodEnd: str(body.periodEnd),
    complete: body.complete === true,
    allowanceCents,
    usageCents,
    lines,
  };
}

function groupFor(key: string): UsageGroupDef | null {
  return USAGE_GROUPS.find((g) => g.keys.includes(key) || (g.prefix ? key.startsWith(g.prefix) : false)) ?? null;
}

/**
 * Sum one group's lines. All unmeasured → not reported. Some unmeasured →
 * the measured sum, flagged partial. Unbilled lines never add to a bill.
 */
export function groupAmount(lines: readonly UsageLine[]): UsageAmount {
  const billed = lines.filter((l) => l.billed);
  const measured = billed.filter((l) => l.costCents !== null);
  if (measured.length === 0) return { kind: "not-reported" };
  const cents = measured.reduce((sum, l) => sum + (l.costCents ?? 0), 0);
  const partial = measured.length < billed.length || measured.some((l) => l.status === "partial");
  return { kind: "amount", cents, partial };
}

/** One row per group that has at least one billed meter, plus "Other usage". */
export function groupUsageLines(lines: readonly UsageLine[]): UsageGroupRow[] {
  const byGroup = new Map<string, UsageLine[]>();
  for (const line of lines) {
    if (!line.billed) continue;
    const id = groupFor(line.key)?.id ?? "other";
    const bucket = byGroup.get(id) ?? [];
    bucket.push(line);
    byGroup.set(id, bucket);
  }
  const rows: UsageGroupRow[] = [];
  for (const group of USAGE_GROUPS) {
    const bucket = byGroup.get(group.id);
    if (bucket?.length) rows.push({ id: group.id, label: group.label, amount: groupAmount(bucket) });
  }
  const other = byGroup.get("other");
  if (other?.length) rows.push({ id: "other", label: OTHER_USAGE_LABEL, amount: groupAmount(other) });
  return rows;
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "Resets Nov 1": the UTC day after the period ends. */
export function resetLine(statement: Pick<MonthStatement, "periodStart" | "periodEnd">): string | null {
  let next: Date | null = null;
  if (statement.periodEnd && /^\d{4}-\d{2}-\d{2}$/.test(statement.periodEnd)) {
    next = new Date(`${statement.periodEnd}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (/^\d{4}-\d{2}/.test(statement.periodStart)) {
    const [y, m] = statement.periodStart.split("-").map(Number);
    next = new Date(Date.UTC(y!, m!, 1));
  }
  if (!next || Number.isNaN(next.getTime())) return null;
  const label = next.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Resets ${label}`;
}

export function meterView(statement: MonthStatement): UsageMeterView {
  const { allowanceCents, usageCents } = statement;
  const over = usageCents > allowanceCents;
  const fill = allowanceCents > 0 ? Math.min(1, Math.max(0, usageCents / allowanceCents)) : usageCents > 0 ? 1 : 0;
  const usedLine = allowanceCents > 0
    ? over
      ? `${formatUsd(usageCents)} used · ${formatUsd(allowanceCents)} free`
      : `${formatUsd(usageCents)} of ${formatUsd(allowanceCents)} free`
    : `${formatUsd(usageCents)} used`;
  const rows = groupUsageLines(statement.lines);
  return {
    fill,
    over,
    usedLine,
    resetLine: resetLine(statement),
    partial: !statement.complete || rows.some((r) => r.amount.kind !== "amount" || r.amount.partial),
    rows,
  };
}

/** Customer-facing plan name. Usage-priced companies are on the Free plan. */
export function planLabelFromSummary(summary: unknown): string | null {
  if (!isRecord(summary)) return null;
  if (isUsageOnlySummary(summary)) return "Free plan";
  if (summary.plan === "team") return "Workforce plan";
  return null;
}

/** A card on file, or a paid flat plan, means billing is already set up. */
export function billingIsSetUp(summary: unknown): boolean {
  if (!isRecord(summary)) return false;
  if (summary.plan === "team") return true;
  const trial = isRecord(summary.usageTrial) ? summary.usageTrial : null;
  if (trial?.cardOnFile === true) return true;
  const pm = isRecord(summary.defaultPaymentMethod) ? summary.defaultPaymentMethod : null;
  return pm?.present === true;
}

export function isForbidden(result: AdapterResult<unknown>): boolean {
  return !result.ok && (result.code === "FORBIDDEN" || result.code === "http-403");
}

export interface CoreUsageSource {
  getBillingSummary?(companyUid: string): Promise<AdapterResult<Json>>;
  getUsageStatement?(companyUid: string): Promise<AdapterResult<Json>>;
}

/**
 * Read the panel for one company. Never throws. A summary the caller may not
 * read (403) is "owner-only"; any other failure is "unavailable". The
 * statement is read only for a usage-priced company.
 */
export async function readCoreUsage(
  source: CoreUsageSource | null | undefined,
  companyUid: string,
  companyName: string,
): Promise<CoreUsageView> {
  if (!source?.getBillingSummary) return { kind: "unavailable", companyName };
  let summary: AdapterResult<Json>;
  try {
    summary = await source.getBillingSummary(companyUid);
  } catch (err) {
    console.warn("[core-usage] billing summary read failed", err instanceof Error ? err.name : "unknown");
    return { kind: "unavailable", companyName };
  }
  if (!summary.ok) {
    return isForbidden(summary) ? { kind: "owner-only", companyName } : { kind: "unavailable", companyName };
  }
  const base = {
    kind: "ready" as const,
    companyName,
    planLabel: planLabelFromSummary(summary.value),
    paid: billingIsSetUp(summary.value),
  };
  if (!isUsageOnlySummary(summary.value)) return { ...base, usage: null, usageUnavailable: false };
  let statement: MonthStatement | null = null;
  if (source.getUsageStatement) {
    try {
      const res = await source.getUsageStatement(companyUid);
      statement = res.ok ? monthStatementFromBody(res.value) : null;
      if (!res.ok) console.warn("[core-usage] usage statement read failed", res.code ?? "unknown");
    } catch (err) {
      console.warn("[core-usage] usage statement read threw", err instanceof Error ? err.name : "unknown");
    }
  }
  return statement
    ? { ...base, usage: meterView(statement), usageUnavailable: false }
    : { ...base, usage: null, usageUnavailable: true };
}

/** Last good view per company, so a reopened menu paints at once. */
const lastGood = new Map<string, CoreUsageView>();

export function cachedCoreUsage(companyUid: string): CoreUsageView | null {
  return lastGood.get(companyUid) ?? null;
}

export function rememberCoreUsage(companyUid: string, view: CoreUsageView): void {
  if (view.kind === "ready") lastGood.set(companyUid, view);
}

export function __resetCoreUsageCacheForTests(): void {
  lastGood.clear();
}
