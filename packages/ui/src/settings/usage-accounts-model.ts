/**
 * Settings > Usage as one line per account (owner direction, Corey,
 * 2026-10-19: "1 line for each company, that can accordian expand to see
 * detail"). Personal first, then every company the caller owns or
 * administers. Every number is hq-pro's:
 *
 * - Line (read when the screen opens): `GET /v1/billing/summary?companyUid=`
 *   or `GET /v1/billing/person/summary` for the plan and card, and the month
 *   statement (`GET /v1/billing/usage`) for this month's total and groups.
 * - Detail (read when a line opens): the spend limit for a usage account, or
 *   the switch status (`GET /v1/billing/usage-switch`, hq-pro US-014 and
 *   #5081) for an account still on its old plan; `GET /v1/pricing` once for
 *   meter labels and rates.
 * - "Switch to usage pricing": `POST /v1/billing/usage-switch` with
 *   `{ companyUid }` or `{ scope: "person" }`. A card is required and there is
 *   no trial (#5081). When the route can't offer it (not deployed, kill switch
 *   off, or a free account before #5081), the action says it isn't available.
 */

import type { AdapterResult, Json } from "@hq/platform";
import { isUsageOnlySummary } from "../company/usage-billing.js";
import { formatCardUsd, usagePricingFromFeed, type UsagePricing } from "../company/usage-pricing.js";
import {
  OTHER_USAGE_LABEL,
  PERSONAL_ACCOUNT_KEY,
  USAGE_GROUPS,
  canReadBilling,
  formatUsd,
  isForbidden,
  personalNoticeFromSummary,
  runningTrialFromSummary,
  trialPlanLabel,
  usageAccountKey,
  usageNoticeFromSummary,
  type RunningTrial,
  type UsageAccount,
  type UsageNotice,
} from "../home/core-usage-model.js";
import { spendLimitFromBody, type SpendLimitDetail } from "./usage-settings-model.js";

/** Where an account stands. `legacy`: an older paid plan; `starter`: the older free plan. */
export type AccountPlan = "trial" | "usage" | "legacy" | "starter";

export const PLAN_LABELS: Readonly<Record<Exclude<AccountPlan, "trial">, string>> = {
  usage: "Usage plan",
  legacy: "Legacy plan",
  starter: "Starter (free)",
};

export interface AccountMeter {
  key: string;
  label: string;
  /** "$0.10 per sync"; "" when neither the feed nor the line has a rate. */
  rate: string;
  costCents: number | null;
  waived: boolean;
}

export interface AccountGroup {
  id: string;
  label: string;
  /** Sum of the measured meters; null when none is measured. */
  cents: number | null;
  /** True when some meter in the group is not measured yet. */
  partial: boolean;
  meters: AccountMeter[];
}

export interface AccountUsage {
  periodStart: string;
  periodEnd: string | null;
  complete: boolean;
  usageCents: number;
  allowanceCents: number;
  allowanceLeftCents: number;
  projectedBillCents: number | null;
  groups: AccountGroup[];
  /** Raw statement lines, kept so labels can be redone once the price list arrives. */
  lines: readonly Record<string, unknown>[];
}

export interface AccountRowReady {
  kind: "ready";
  plan: AccountPlan;
  planLabel: string;
  /** Null when hq-pro didn't say. */
  cardOnFile: boolean | null;
  trial: RunningTrial | null;
  /** Null on the old plans, and when the statement could not be read. */
  usage: AccountUsage | null;
  /** On usage pricing, but the statement read failed. */
  usageUnavailable: boolean;
  notice: UsageNotice | null;
}

export type AccountRowView =
  | { kind: "loading" }
  /** Usage reads are owner-only on hq-pro; an admin's company shows this. */
  | { kind: "owner-only" }
  | { kind: "unavailable" }
  | AccountRowReady;

export interface UsageAccountsSource {
  getBillingSummary?(companyUid: string): Promise<AdapterResult<Json>>;
  getUsageStatement?(companyUid: string): Promise<AdapterResult<Json>>;
  getPricing?(): Promise<AdapterResult<Json>>;
  getSpendLimit?(companyUid: string): Promise<AdapterResult<Json>>;
  getPersonalBillingSummary?(): Promise<AdapterResult<Json>>;
  getPersonalUsageStatement?(): Promise<AdapterResult<Json>>;
  getPersonalSpendLimit?(): Promise<AdapterResult<Json>>;
  getUsageSwitch?(companyUid: string): Promise<AdapterResult<Json>>;
  switchToUsagePricing?(companyUid: string): Promise<AdapterResult<Json>>;
  getPersonalUsageSwitch?(): Promise<AdapterResult<Json>>;
  switchPersonalToUsagePricing?(): Promise<AdapterResult<Json>>;
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

async function settle<T>(work: (() => Promise<AdapterResult<T>>) | null, label: string): Promise<AdapterResult<T> | null> {
  if (!work) return null;
  try {
    return await work();
  } catch (err) {
    console.warn(`[usage-accounts] ${label} read threw`, err instanceof Error ? err.name : "unknown");
    return null;
  }
}

const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due", "unpaid"]);

/**
 * An account not on usage pricing is on an older paid plan when it has a live
 * flat plan (`plan: "team"`) or any live subscription, and on the older free
 * plan otherwise.
 */
export function oldPlanFromSummary(summary: Record<string, unknown>): "legacy" | "starter" {
  if (summary.plan === "team") return "legacy";
  const status = str(summary.subscriptionStatus);
  return status && LIVE_SUBSCRIPTION.has(status) ? "legacy" : "starter";
}

/** Card on file from a company or person summary; null when the summary doesn't say. */
export function cardOnFileFromSummary(summary: Record<string, unknown>): boolean | null {
  const trial = isRecord(summary.usageTrial) ? summary.usageTrial : null;
  const personal = isRecord(summary.personalUsage) ? summary.personalUsage : null;
  const pm = isRecord(summary.defaultPaymentMethod) ? summary.defaultPaymentMethod : null;
  if (trial?.cardOnFile === true || personal?.cardOnFile === true || summary.cardOnFile === true || pm?.present === true) {
    return true;
  }
  if (trial?.cardOnFile === false || personal?.cardOnFile === false || summary.cardOnFile === false || pm?.present === false) {
    return false;
  }
  return null;
}

function rateText(unitUsd: number, unit: string): string {
  return `${formatCardUsd(unitUsd)} per ${unit}`;
}

/** The three groups (plus "Other usage"), each with its meters, from statement lines. */
export function accountGroups(lines: readonly Record<string, unknown>[], pricing: UsagePricing | null): AccountGroup[] {
  const buckets = new Map<string, AccountMeter[]>();
  const statuses = new Map<string, boolean>();
  for (const raw of lines) {
    const key = str(raw.key);
    if (!key || raw.billed === false) continue;
    const feedMeter = pricing?.meters.find((m) => m.id === key) ?? null;
    const unit = feedMeter?.unit ?? str(raw.unit) ?? "";
    const unitCents = finite(raw.unitCents);
    const meter: AccountMeter = {
      key,
      label: feedMeter?.label ?? str(raw.displayName) ?? key,
      rate: feedMeter ? rateText(feedMeter.unitUsd, feedMeter.unit) : unitCents !== null && unit ? rateText(unitCents / 100, unit) : "",
      costCents: finite(raw.costCents),
      waived: raw.waived === true,
    };
    const group = USAGE_GROUPS.find((g) => g.keys.includes(key))?.id ?? "other";
    const bucket = buckets.get(group) ?? [];
    bucket.push(meter);
    buckets.set(group, bucket);
    if (raw.status === "partial") statuses.set(group, true);
  }
  const out: AccountGroup[] = [];
  const push = (id: string, label: string) => {
    const meters = buckets.get(id);
    if (!meters?.length) return;
    const measured = meters.filter((m) => m.costCents !== null);
    out.push({
      id,
      label,
      cents: measured.length ? measured.reduce((sum, m) => sum + (m.costCents ?? 0), 0) : null,
      partial: measured.length < meters.length || statuses.get(id) === true,
      meters,
    });
  };
  for (const g of USAGE_GROUPS) push(g.id, g.label);
  push("other", OTHER_USAGE_LABEL);
  return out;
}

function usageFromStatement(body: unknown, pricing: UsagePricing | null): AccountUsage | null {
  if (!isRecord(body)) return null;
  const usageCents = finite(body.usageCents);
  const allowanceCents = finite(body.allowanceCents);
  const allowanceLeftCents = finite(body.allowanceLeftCents);
  const periodStart = str(body.periodStart);
  if (usageCents === null || allowanceCents === null || allowanceLeftCents === null || !periodStart) return null;
  const lines = Array.isArray(body.lines) ? body.lines.filter(isRecord) : [];
  return {
    periodStart,
    periodEnd: str(body.periodEnd),
    complete: body.complete === true,
    usageCents,
    allowanceCents,
    allowanceLeftCents,
    projectedBillCents: finite(body.projectedBillCents),
    groups: accountGroups(lines, pricing),
    lines,
  };
}

/** Redo group labels and rates once the price list has been read. */
export function withPricing(view: AccountRowView, pricing: UsagePricing | null): AccountRowView {
  if (view.kind !== "ready" || !view.usage || !pricing) return view;
  return { ...view, usage: { ...view.usage, groups: accountGroups(view.usage.lines, pricing) } };
}

/**
 * Read one account's line. Never throws. A company the caller doesn't own is
 * "owner-only" without a request (the reads are owner-gated); a 403 is too.
 * A failed summary is "unavailable", never $0.
 */
export async function readAccountRow(
  source: UsageAccountsSource | null | undefined,
  account: UsageAccount,
  pricing: UsagePricing | null = null,
  now: () => Date = () => new Date(),
): Promise<AccountRowView> {
  if (account.kind === "company") {
    if (!account.uid) return { kind: "unavailable" };
    if (!canReadBilling(account.role)) return { kind: "owner-only" };
    const uid = account.uid;
    if (!source?.getBillingSummary) return { kind: "unavailable" };
    const summary = await settle(() => source.getBillingSummary!(uid), "billing summary");
    if (!summary) return { kind: "unavailable" };
    if (!summary.ok) return isForbidden(summary) ? { kind: "owner-only" } : { kind: "unavailable" };
    if (!isRecord(summary.value)) return { kind: "unavailable" };
    const body = summary.value;
    const cardOnFile = cardOnFileFromSummary(body);
    if (!isUsageOnlySummary(body)) {
      const plan = oldPlanFromSummary(body);
      return { kind: "ready", plan, planLabel: PLAN_LABELS[plan], cardOnFile, trial: null, usage: null, usageUnavailable: false, notice: null };
    }
    const trial = runningTrialFromSummary(body, now());
    const statement = await settle(source.getUsageStatement ? () => source.getUsageStatement!(uid) : null, "usage statement");
    const usage = statement?.ok ? usageFromStatement(statement.value, pricing) : null;
    return {
      kind: "ready",
      plan: trial ? "trial" : "usage",
      planLabel: trial ? trialPlanLabel(trial.daysLeft) : PLAN_LABELS.usage,
      cardOnFile,
      trial,
      usage,
      usageUnavailable: usage === null,
      notice: usageNoticeFromSummary(body),
    };
  }
  if (!source?.getPersonalBillingSummary) return { kind: "unavailable" };
  const summary = await settle(() => source.getPersonalBillingSummary!(), "personal summary");
  if (!summary?.ok || !isRecord(summary.value)) return { kind: "unavailable" };
  const body = summary.value;
  const cardOnFile = cardOnFileFromSummary(body);
  if (!isRecord(body.personalUsage)) {
    const plan = oldPlanFromSummary(body);
    return { kind: "ready", plan, planLabel: PLAN_LABELS[plan], cardOnFile, trial: null, usage: null, usageUnavailable: false, notice: null };
  }
  const statement = await settle(source.getPersonalUsageStatement ? () => source.getPersonalUsageStatement!() : null, "personal statement");
  const usage = statement?.ok ? usageFromStatement(statement.value, pricing) : null;
  return {
    kind: "ready",
    plan: "usage",
    planLabel: PLAN_LABELS.usage,
    cardOnFile,
    trial: null,
    usage,
    usageUnavailable: usage === null,
    notice: personalNoticeFromSummary(body),
  };
}

/** The line's right-hand total: "$8.00", "At least $4.20", "Owner only", "No usage bill". */
export function rowTotalText(view: AccountRowView | undefined): string {
  if (!view || view.kind === "loading") return "…";
  if (view.kind === "owner-only") return "Owner only";
  if (view.kind === "unavailable") return "Unavailable";
  if (view.plan === "legacy" || view.plan === "starter") return "No usage bill";
  if (view.trial && view.trial.usedCents !== null) {
    const text = formatUsd(view.trial.usedCents);
    return view.trial.unknownMeters?.length ? `At least ${text}` : text;
  }
  if (!view.usage) return "Unavailable";
  const text = formatUsd(view.usage.usageCents);
  return view.usage.complete ? text : `At least ${text}`;
}

export async function readPricing(source: UsageAccountsSource | null | undefined): Promise<UsagePricing | null> {
  const res = await settle(source?.getPricing ? () => source.getPricing!() : null, "pricing");
  return res?.ok ? usagePricingFromFeed(res.value) : null;
}

export async function readSpendLimit(
  source: UsageAccountsSource | null | undefined,
  account: UsageAccount,
): Promise<SpendLimitDetail | null> {
  const res =
    account.kind === "personal"
      ? await settle(source?.getPersonalSpendLimit ? () => source.getPersonalSpendLimit!() : null, "personal spend limit")
      : account.uid
        ? await settle(source?.getSpendLimit ? () => source.getSpendLimit!(account.uid!) : null, "spend limit")
        : null;
  return res?.ok ? spendLimitFromBody(res.value) : null;
}

// ---------------------------------------------------------------------------
// Switch to usage pricing (hq-pro US-014 / #5081)
// ---------------------------------------------------------------------------

export type SwitchState =
  | { kind: "loading" }
  /** Offered and a card is on file: the switch can go ahead. */
  | { kind: "offered" }
  /** Offered once a card is added. */
  | { kind: "card-required" }
  /** Refused for a reason the person can act on or should know. */
  | { kind: "refused"; reason: string; text: string }
  /** Already on usage pricing. */
  | { kind: "switched" }
  /** The route can't offer it: not deployed, kill switch off, or not readable. */
  | { kind: "not-available" };

export const SWITCH_NOT_AVAILABLE_TEXT = "Switching to usage pricing isn't available for this account yet.";

const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  comped: "This account's plan is set by HQ, so it can't switch here. Contact support to change it.",
  "reversed-by-operator": "HQ moved this account back to its old plan. Contact support to switch again.",
  "discounted-plan": "This plan has a discount that would be lost. Contact support to switch.",
  "box-items-on-plan": "Cloud bots are billed on this plan. Contact support to switch.",
  "estimate-incomplete": "Usage isn't fully measured yet, so switching isn't offered yet.",
  "estimate-not-lower": "Usage pricing wouldn't cost less for this account right now.",
  "on-individual-plan": "Your HQ Individual plan is still active. End it before switching.",
  sponsored: "A company pays for your personal plan, so it can't switch here.",
};

/** Map a `GET /v1/billing/usage-switch` body to what the line can offer. */
export function switchStateFromBody(body: unknown): SwitchState {
  if (!isRecord(body) || !isRecord(body.offer)) return { kind: "not-available" };
  const offer = body.offer;
  if (body.enabled === false) return { kind: "not-available" };
  if (offer.eligible === true) return body.cardOnFile === false ? { kind: "card-required" } : { kind: "offered" };
  const reason = str(offer.reason) ?? "";
  if (reason === "card-required") return { kind: "card-required" };
  if (reason === "already-on-usage") return { kind: "switched" };
  // Before hq-pro #5081 a free account is refused as "not-paying": the free
  // opt-in isn't live yet. A live Workforce stamp with no flat plan is
  // refused the same way and support has to fix it either way.
  if (reason === "flag-off" || reason === "not-paying" || !reason) return { kind: "not-available" };
  return { kind: "refused", reason, text: REFUSAL_TEXT[reason] ?? "This account can't switch to usage pricing right now." };
}

export async function readSwitchState(
  source: UsageAccountsSource | null | undefined,
  account: UsageAccount,
): Promise<SwitchState> {
  const res =
    account.kind === "personal"
      ? await settle(source?.getPersonalUsageSwitch ? () => source.getPersonalUsageSwitch!() : null, "personal usage switch")
      : account.uid
        ? await settle(source?.getUsageSwitch ? () => source.getUsageSwitch!(account.uid!) : null, "usage switch")
        : null;
  if (!res?.ok) return { kind: "not-available" };
  return switchStateFromBody(res.value);
}

export type SwitchOutcome =
  | { kind: "switched" }
  /** hq-pro refused (409 USAGE_SWITCH_NOT_OFFERED); `state` is re-read so the line shows why. */
  | { kind: "refused"; state: SwitchState }
  | { kind: "conflict" }
  | { kind: "not-available" }
  | { kind: "failed" };

/** Press "Switch now". Never throws. */
export async function switchAccountToUsage(
  source: UsageAccountsSource | null | undefined,
  account: UsageAccount,
): Promise<SwitchOutcome> {
  const work =
    account.kind === "personal"
      ? source?.switchPersonalToUsagePricing
        ? () => source.switchPersonalToUsagePricing!()
        : null
      : account.uid && source?.switchToUsagePricing
        ? () => source.switchToUsagePricing!(account.uid!)
        : null;
  if (!work) return { kind: "not-available" };
  const res = await settle(work, "usage switch");
  if (!res) return { kind: "failed" };
  if (res.ok) return isRecord(res.value) && res.value.outcome === "switched" ? { kind: "switched" } : { kind: "failed" };
  if (res.code === "USAGE_SWITCH_NOT_OFFERED") return { kind: "refused", state: await readSwitchState(source, account) };
  if (res.code === "USAGE_SWITCH_CONFLICT") return { kind: "conflict" };
  if (res.code === "http-404" || res.code === "NOT_FOUND" || res.code === "MISSING_COMPANY_UID" || res.code === "PERSON_NOT_FOUND") {
    return { kind: "not-available" };
  }
  console.warn("[usage-accounts] usage switch failed", res.code ?? "unknown");
  return { kind: "failed" };
}

export function switchOutcomeText(outcome: SwitchOutcome): string {
  switch (outcome.kind) {
    case "switched":
      return "Switched to usage pricing.";
    case "refused":
      return outcome.state.kind === "refused"
        ? outcome.state.text
        : outcome.state.kind === "card-required"
          ? "Add a card first, then switch."
          : outcome.state.kind === "switched"
            ? "This account is already on usage pricing."
            : SWITCH_NOT_AVAILABLE_TEXT;
    case "conflict":
      return "Something changed while switching. Try again.";
    case "not-available":
      return SWITCH_NOT_AVAILABLE_TEXT;
    default:
      return "Couldn't switch. Try again.";
  }
}

/** Accounts in screen order: Personal first, then companies by name. */
export function orderedAccounts(accounts: readonly UsageAccount[]): UsageAccount[] {
  const personal = accounts.filter((a) => a.kind === "personal");
  const companies = accounts
    .filter((a) => a.kind === "company")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...personal, ...companies];
}

export function accountKey(account: UsageAccount): string {
  return account.kind === "personal" ? PERSONAL_ACCOUNT_KEY : usageAccountKey(account);
}
