/**
 * Billing pane data for usage-priced companies (usage-only-pricing US-014).
 *
 * Sources, all hq-pro and all owner-gated except the price list:
 * - `GET /v1/billing/summary?companyUid=` → `billingState` (hq-pro #5088,
 *   US-024) is the plan status: kind `usage` or `usage-trial` marks a
 *   usage-priced company, `trial` carries the trial dates and cap, `paused`
 *   a usage pause. When it is present it wins over `pricingPlan`. Servers
 *   without it fall back to `pricingPlan: "usage-only"` and `usageTrial`.
 *   Any other answer, a 403 or a failed read keep the payment-only view.
 * - `GET /v1/billing/usage?companyUid=&window=month` → month-to-date usage,
 *   allowance left and one line per meter.
 * - `GET /v1/pricing` `usage` block → the vault rate and box ladder, with the
 *   bundled contract copy when the feed lacks it (see usage-pricing.ts).
 */

import {
  LEGACY_USAGE_PRICING_PLAN,
  isUsagePricedRecord,
  parseBillingState,
  type AdapterResult,
  type BillingState,
  type BillingStatePause,
  type Json,
} from "@hq/platform";
import {
  PRICING_FALLBACK,
  pricingFromFeed,
  type UsagePricing,
} from "./usage-pricing.js";

/** The legacy `pricingPlan` value; read only when `billingState` is absent. */
export const USAGE_ONLY_PRICING_PLAN = LEGACY_USAGE_PRICING_PLAN;

export interface UsageTrialStanding {
  status: "none" | "active" | "ended" | "owner-trial-used";
  endsAt: string | null;
  capCents: number | null;
}

export interface UsageStatementLine {
  key: string;
  displayName: string;
  costCents: number | null;
}

export interface UsageStatementView {
  periodStart: string;
  asOf: string | null;
  complete: boolean;
  allowanceCents: number;
  usageCents: number;
  allowanceLeftCents: number;
  billCents: number;
  lines: UsageStatementLine[];
}

export interface UsageBillingView {
  trial: UsageTrialStanding | null;
  /** Null when the statement could not be read; the pane says so. */
  statement: UsageStatementView | null;
  pricing: UsagePricing;
  /** The server plan status, when it sent one (US-024). */
  billingState: BillingState | null;
  /** A usage pause in force now, from `billingState.paused`. */
  paused: BillingStatePause | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * True when the summary marks a usage-priced company: `billingState.kind` is
 * `usage` or `usage-trial`. `billingState` wins over a conflicting
 * `pricingPlan`; only a summary without it reads `pricingPlan: "usage-only"`.
 */
export function isUsageOnlySummary(summary: unknown): boolean {
  return isUsagePricedRecord(summary);
}

/** The summary's plan status, or null when absent or not a known version. */
export function billingStateFromSummary(summary: unknown): BillingState | null {
  return isRecord(summary) ? parseBillingState(summary.billingState) : null;
}

export function trialFromSummary(summary: unknown): UsageTrialStanding | null {
  // billingState wins: a running trial is kind `usage-trial` with its dates.
  // Without a running trial, the legacy record may still say how a past
  // trial ended, but never that one is active.
  const state = billingStateFromSummary(summary);
  if (state?.kind === "usage-trial" && state.trial) {
    return { status: "active", endsAt: state.trial.endsAt, capCents: state.trial.capCents };
  }
  const legacy = legacyTrialFromSummary(summary);
  if (state && legacy?.status === "active") return null;
  return legacy;
}

function legacyTrialFromSummary(summary: unknown): UsageTrialStanding | null {
  if (!isRecord(summary) || !isRecord(summary.usageTrial)) return null;
  const trial = summary.usageTrial;
  const status = trial.status;
  if (status !== "none" && status !== "active" && status !== "ended" && status !== "owner-trial-used") return null;
  return { status, endsAt: str(trial.endsAt), capCents: finite(trial.capCents) };
}

/** A month statement, or null when the body is not one. */
export function statementFromBody(body: unknown): UsageStatementView | null {
  if (!isRecord(body)) return null;
  const allowanceCents = finite(body.allowanceCents);
  const usageCents = finite(body.usageCents);
  const allowanceLeftCents = finite(body.allowanceLeftCents);
  const billCents = finite(body.billCents);
  const periodStart = str(body.periodStart);
  if (allowanceCents === null || usageCents === null || allowanceLeftCents === null || billCents === null || !periodStart) {
    return null;
  }
  const lines = Array.isArray(body.lines)
    ? body.lines.filter(isRecord).flatMap((line): UsageStatementLine[] => {
        const key = str(line.key);
        if (!key) return [];
        return [{ key, displayName: str(line.displayName) ?? key, costCents: finite(line.costCents) }];
      })
    : [];
  return {
    periodStart,
    asOf: str(body.asOf),
    complete: body.complete === true,
    allowanceCents,
    usageCents,
    allowanceLeftCents,
    billCents,
    lines,
  };
}

export interface UsageBillingSource {
  getBillingSummary?(companyUid: string): Promise<AdapterResult<Json>>;
  getUsageStatement?(companyUid: string): Promise<AdapterResult<Json>>;
  getPricing?(): Promise<AdapterResult<Json>>;
}

/**
 * Read the usage view for one company. Null when the company is not
 * usage-priced, or when the summary cannot be read (non-owner, offline, older
 * host): the pane then shows payment only.
 */
export async function readUsageBilling(
  source: UsageBillingSource | null | undefined,
  companyUid: string | null | undefined,
): Promise<UsageBillingView | null> {
  if (!source?.getBillingSummary || !companyUid) return null;
  let summary: AdapterResult<Json>;
  try {
    summary = await source.getBillingSummary(companyUid);
  } catch (err) {
    console.warn("[settings] billing summary read failed", err);
    return null;
  }
  if (!summary.ok || !isUsageOnlySummary(summary.value)) return null;
  const [statement, pricing] = await Promise.all([
    source.getUsageStatement
      ? source
          .getUsageStatement(companyUid)
          .then((res) => (res.ok ? statementFromBody(res.value) : null))
          .catch((err: unknown) => {
            console.warn("[settings] usage statement read failed", err);
            return null;
          })
      : Promise.resolve(null),
    source.getPricing
      ? source
          .getPricing()
          .then((res) => (res.ok ? pricingFromFeed(res.value).usage : PRICING_FALLBACK.usage))
          .catch(() => PRICING_FALLBACK.usage)
      : Promise.resolve(PRICING_FALLBACK.usage),
  ]);
  const billingState = billingStateFromSummary(summary.value);
  return {
    trial: trialFromSummary(summary.value),
    statement,
    pricing,
    billingState,
    paused: billingState?.paused ?? null,
  };
}

/** The vault line's cost so far, when the statement carries one. */
export function vaultCostCents(statement: UsageStatementView | null): number | null {
  return statement?.lines.find((line) => line.key === "vault")?.costCents ?? null;
}
