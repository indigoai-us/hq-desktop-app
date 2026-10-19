/**
 * Settings > Usage (usage-only-pricing US-018, owner-approved new screen
 * 2026-10-18).
 *
 * The same numbers as the console usage view (US-006), from the same hq-pro
 * reads. Nothing here is a price:
 * - `GET /v1/billing/summary?companyUid=` (owner-gated): usage-priced or not,
 *   the trial (end date, cap, trial usage so far) and whether a card is on file.
 * - `GET /v1/billing/usage?companyUid=&window=month` (owner-gated): this
 *   month's cost per meter, the included usage and how much is left, and the
 *   projected bill, priced by hq-pro from the daily usage rollup.
 * - `GET /v1/pricing` (public): meter labels and rates. When the feed can't be
 *   read, the label and rate printed on the statement line are used instead
 *   (hq-pro puts the rate card's own values on each line). The bundled
 *   contract copy in usage-pricing.ts is never used here.
 * - `GET /v1/billing/spend-limit?companyUid=` (owner-gated): the spend limit.
 */

import type { AdapterResult, Json } from "@hq/platform";
import { isUsageOnlySummary } from "../company/usage-billing.js";
import {
  formatCardUsd,
  usagePricingFromFeed,
  type UsagePricing,
} from "../company/usage-pricing.js";
import {
  formatUsd,
  isForbidden,
  planLabelFromSummary,
  runningTrialFromSummary,
  usageNoticeFromSummary,
  type RunningTrial,
  type UsageNotice,
} from "../home/core-usage-model.js";

export type UsageDetailLineStatus = "measured" | "partial" | "unavailable" | "not-billed-yet";

export interface UsageDetailLine {
  key: string;
  label: string;
  /** "$0.10 per sync", from GET /v1/pricing (or the statement line). */
  rate: string;
  /** "1,240 syncs", "0.42 GB-month"; null when hq-pro has no figure. */
  usage: string | null;
  costCents: number | null;
  projectedCostCents: number | null;
  status: UsageDetailLineStatus | null;
  /** True on the vault line while the trial waives the fee. */
  waived: boolean;
}

export type SpendLimitDetail =
  | {
      noLimit: false;
      limitCents: number;
      /** False when the default limit applies. */
      custom: boolean;
      paused: boolean;
    }
  | {
      /**
       * No monthly limit: an owner or admin removed it, or an existing paying
       * account switched to usage pricing without one (hq-pro #5069:
       * `limitCents: null`, `noLimit: true`). Nothing pauses for spend.
       */
      noLimit: true;
      limitCents: null;
      custom: boolean;
      paused: boolean;
    };

export interface UsageDetailsReady {
  kind: "ready";
  planLabel: string | null;
  trial: RunningTrial | null;
  periodStart: string;
  periodEnd: string | null;
  asOf: string | null;
  complete: boolean;
  allowanceCents: number;
  allowanceLeftCents: number;
  usageCents: number;
  billCents: number;
  projectedBillCents: number | null;
  lines: UsageDetailLine[];
  /** Null when the spend limit could not be read. */
  spendLimit: SpendLimitDetail | null;
  /** "Deploys, DMs and background AI are free." from the statement; null when absent. */
  freeText: string | null;
  /** Sync pause or card prompt from the summary, the same as the Core menu. */
  notice: UsageNotice | null;
}

export type UsageDetailsView =
  | { kind: "loading" }
  | { kind: "owner-only" }
  /** The company is not on usage pricing: there is no usage bill to show. */
  | { kind: "not-usage" }
  | { kind: "unavailable" }
  | UsageDetailsReady;

export interface UsageDetailsSource {
  getBillingSummary?(companyUid: string): Promise<AdapterResult<Json>>;
  getUsageStatement?(companyUid: string): Promise<AdapterResult<Json>>;
  getPricing?(): Promise<AdapterResult<Json>>;
  getSpendLimit?(companyUid: string): Promise<AdapterResult<Json>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const LINE_STATUSES: ReadonlySet<string> = new Set(["measured", "partial", "unavailable", "not-billed-yet"]);

/** "1,240 syncs", "1 vault-month", "0.42 GB-months". */
export function formatUnits(units: number, unit: string): string {
  const rounded = Number.isInteger(units) ? units : Number(units.toFixed(2));
  const number = rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${number} ${rounded === 1 ? unit : `${unit}s`}`;
}

function rateText(unitUsd: number, unit: string): string {
  return `${formatCardUsd(unitUsd)} per ${unit}`;
}

/** One line per billed statement meter, labelled from the price feed when it lists the meter. */
export function detailLines(statementLines: readonly unknown[], pricing: UsagePricing | null): UsageDetailLine[] {
  const out: UsageDetailLine[] = [];
  for (const raw of statementLines) {
    if (!isRecord(raw)) continue;
    const key = str(raw.key);
    if (!key || raw.billed === false) continue;
    const meter = pricing?.meters.find((m) => m.id === key) ?? null;
    const unit = meter?.unit ?? str(raw.unit) ?? "";
    const label = meter?.label ?? str(raw.displayName) ?? key;
    const unitCents = finite(raw.unitCents);
    const rate = meter
      ? rateText(meter.unitUsd, meter.unit)
      : unitCents !== null && unit
        ? rateText(unitCents / 100, unit)
        : "";
    const units = finite(raw.units);
    const status = typeof raw.status === "string" && LINE_STATUSES.has(raw.status)
      ? (raw.status as UsageDetailLineStatus)
      : null;
    out.push({
      key,
      label,
      rate,
      usage: units !== null && unit ? formatUnits(units, unit) : null,
      costCents: finite(raw.costCents),
      projectedCostCents: finite(raw.projectedCostCents),
      status,
      waived: raw.waived === true,
    });
  }
  return out;
}

/**
 * The spend limit from `GET /v1/billing/spend-limit`. A body that says there
 * is no limit (`noLimit: true`, or `limitCents: null`) is a real state, not a
 * failed read. Null only for a body that is neither.
 */
export function spendLimitFromBody(body: unknown): SpendLimitDetail | null {
  if (!isRecord(body)) return null;
  const custom = body.custom === true;
  const paused = body.paused === true;
  if (body.noLimit === true || body.limitCents === null) {
    return { noLimit: true, limitCents: null, custom, paused };
  }
  const limitCents = finite(body.limitCents);
  if (limitCents === null) return null;
  return { noLimit: false, limitCents, custom, paused };
}

function freeTextFromStatement(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.free)) return null;
  const texts = body.free.filter(isRecord).map((item) => str(item.text)).filter((t): t is string => Boolean(t));
  return texts.length > 0 ? texts.join(" ") : null;
}

async function settle<T>(work: (() => Promise<AdapterResult<T>>) | null, label: string): Promise<AdapterResult<T> | null> {
  if (!work) return null;
  try {
    return await work();
  } catch (err) {
    console.warn(`[usage-settings] ${label} read threw`, err instanceof Error ? err.name : "unknown");
    return null;
  }
}

/**
 * Read the Usage screen for one company. Never throws. A summary the caller
 * may not read (403) is "owner-only"; a failed summary or statement read is
 * "unavailable" (never $0). The price list and spend limit degrade on their
 * own: rates fall back to the statement's printed rate, and the spend limit
 * row says it can't be shown.
 */
export async function readUsageDetails(
  source: UsageDetailsSource | null | undefined,
  companyUid: string,
  now: () => Date = () => new Date(),
): Promise<UsageDetailsView> {
  if (!source?.getBillingSummary) return { kind: "unavailable" };
  const summary = await settle(() => source.getBillingSummary!(companyUid), "billing summary");
  if (!summary) return { kind: "unavailable" };
  if (!summary.ok) {
    if (isForbidden(summary)) return { kind: "owner-only" };
    console.warn("[usage-settings] billing summary read failed", summary.code ?? "unknown");
    return { kind: "unavailable" };
  }
  if (!isUsageOnlySummary(summary.value)) return { kind: "not-usage" };

  const [statement, pricing, spend] = await Promise.all([
    settle(source.getUsageStatement ? () => source.getUsageStatement!(companyUid) : null, "usage statement"),
    settle(source.getPricing ? () => source.getPricing!() : null, "pricing"),
    settle(source.getSpendLimit ? () => source.getSpendLimit!(companyUid) : null, "spend limit"),
  ]);
  if (!statement?.ok || !isRecord(statement.value)) {
    if (statement && !statement.ok) console.warn("[usage-settings] usage statement read failed", statement.code ?? "unknown");
    return { kind: "unavailable" };
  }
  const body = statement.value;
  const allowanceCents = finite(body.allowanceCents);
  const allowanceLeftCents = finite(body.allowanceLeftCents);
  const usageCents = finite(body.usageCents);
  const billCents = finite(body.billCents);
  const periodStart = str(body.periodStart);
  if (allowanceCents === null || allowanceLeftCents === null || usageCents === null || billCents === null || !periodStart) {
    return { kind: "unavailable" };
  }
  const feed = pricing?.ok ? usagePricingFromFeed(pricing.value) : null;
  const at = now();
  return {
    kind: "ready",
    planLabel: planLabelFromSummary(summary.value, at),
    trial: runningTrialFromSummary(summary.value, at),
    periodStart,
    periodEnd: str(body.periodEnd),
    asOf: str(body.asOf),
    complete: body.complete === true,
    allowanceCents,
    allowanceLeftCents,
    usageCents,
    billCents,
    projectedBillCents: finite(body.projectedBillCents),
    lines: detailLines(Array.isArray(body.lines) ? body.lines : [], feed),
    spendLimit: spend?.ok ? spendLimitFromBody(spend.value) : null,
    freeText: freeTextFromStatement(body),
    notice: usageNoticeFromSummary(summary.value),
  };
}

/** "Oct 1 to Oct 31" for the statement period. */
export function periodLabel(periodStart: string, periodEnd: string | null): string {
  const fmt = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return periodEnd ? `${fmt(periodStart)} to ${fmt(periodEnd)}` : `Since ${fmt(periodStart)}`;
}

/** "Ends Nov 3": the trial end date; "" when the date can't be read. */
export function trialEndLabel(endsAt: string): string {
  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) return "";
  return `Ends ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/** "$100.00 a month (default)", or "No limit". */
export function spendLimitLine(limit: SpendLimitDetail): string {
  if (limit.noLimit) return "No limit";
  return `${formatUsd(limit.limitCents)} a month${limit.custom ? "" : " (default)"}`;
}

/** Cost cell text: "$1.20", "Waived during the trial", "Not reported". */
export function lineCostText(line: UsageDetailLine): string {
  if (line.waived) return "Waived during the trial";
  if (line.costCents === null) return "Not reported";
  return formatUsd(line.costCents);
}
