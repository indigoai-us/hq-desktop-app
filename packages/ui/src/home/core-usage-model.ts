/**
 * "Usage this month" panel in the Core menu (usage-only-pricing US-018).
 *
 * Every number comes from hq-pro, never from this file:
 * - `GET /v1/billing/summary?companyUid=` (owner-gated) says whether the
 *   company is usage-priced (`pricingPlan: "usage-only"`), its coarse plan,
 *   whether a card is on file, and the trial (`usageTrial`: end date, the
 *   trial cap and trial usage so far).
 * - `GET /v1/billing/usage?companyUid=&window=month` (owner-gated) is the
 *   month-to-date statement hq-pro prices from the daily usage rollup: usage
 *   so far, the included allowance, the period, and one line per meter. The
 *   console usage view (US-006) reads the same endpoint.
 *
 * This module only groups the statement's meter lines under the three
 * owner-approved labels (2026-10-18) and turns the reads into a view. A meter
 * hq-pro could not measure (`costCents: null`) is "not reported", never $0. A
 * failed read is "unavailable", never zero usage. No price lives here.
 */

import type { AdapterResult, Json } from "@hq/platform";
import { isUsageOnlySummary } from "../company/usage-billing.js";

export interface UsageGroupDef {
  id: "agents" | "sync" | "storage";
  label: string;
  /** Rate-card meter keys (`UsageMeterKey` in hq-pro usage-rate-card.ts). */
  keys: readonly string[];
}

/**
 * The three meter groups, in display order (owner decision 2026-10-18). Each
 * rate-card meter belongs to exactly one group, so the groups add up to the
 * total. A meter the card adds later lands in "Other usage" until it is
 * given a group, so it is never dropped from the sum.
 */
export const USAGE_GROUPS: readonly UsageGroupDef[] = [
  { id: "agents", label: "Agents and AI", keys: ["agent-run", "hq-mcp-call", "integration-call"] },
  { id: "sync", label: "Sync", keys: ["member-sync"] },
  { id: "storage", label: "Storage and vaults", keys: ["storage", "secret", "vault"] },
];

/** Label for meter keys no group claims, so new meters are never dropped. */
export const OTHER_USAGE_LABEL = "Other usage";

/** Share of the limit at which the bar turns amber (US-009 warns at the same 80%). */
export const NEAR_LIMIT_RATIO = 0.8;

/** The panel re-reads at most this often while the menu stays open. */
export const USAGE_REFRESH_MS = 3 * 60_000;

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

/** `ok` under 80% of the limit, `near` from 80%, `at` once the limit is reached. */
export type UsageBarTone = "ok" | "near" | "at";

export interface UsageMeterView {
  /** `allowance`: this month against the included usage; `trial`: trial usage against the trial cap. */
  mode: "allowance" | "trial";
  /** 0..1 share of the limit used, for the bar's `--fill`. */
  fill: number;
  tone: UsageBarTone;
  /** Kept for callers that only need "past the limit". */
  over: boolean;
  usedLine: string;
  resetLine: string | null;
  partial: boolean;
  rows: UsageGroupRow[];
  /** Trial mode only: why the per-group rows are not shown. */
  rowsNote: string | null;
}

/** The trial as the summary reports it, when it is running. */
export interface RunningTrial {
  endsAt: string;
  daysLeft: number;
  capCents: number | null;
  usedCents: number | null;
  /**
   * Meters hq-pro could not read for `usedCents`; when any are listed the
   * figure is a minimum (`usageTrial.unknownMeters`).
   */
  unknownMeters?: readonly string[];
}

/** Caller's billing role: owners read usage; owners and admins add the card. */
export type BillingRole = "owner" | "admin" | "member" | "unknown";

export type CoreUsageView =
  | { kind: "loading"; companyName: string }
  /** The company on screen has no cloud account, so HQ meters nothing for it. */
  | { kind: "no-usage"; companyName: string }
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
      /** Why sync is paused or a card is needed, from the summary; null when neither. */
      notice: UsageNotice | null;
    };

/**
 * A pause or card prompt hq-pro reports on the billing summary
 * (`usageTrial.syncPaused`, `pauseReason`, `capReached`, `cardRequired`).
 * `paused-*`: cloud sync is paused now. `cap-reached` / `card-required`:
 * the rule is met but nothing is paused (enforcement off, or the trial's
 * card prompt that never pauses).
 */
export type UsageNoticeKind = "paused-trial-cap" | "paused-card-required" | "cap-reached" | "card-required";

export interface UsageNotice {
  kind: UsageNoticeKind;
  /** One plain sentence: what happened and what it means. */
  text: string;
  /** Label for the owner/admin billing button in this state. */
  actionLabel: string;
  /** What a member who can't add the card is told. */
  memberText: string;
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
  return USAGE_GROUPS.find((g) => g.keys.includes(key)) ?? null;
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

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
  return `Resets ${shortDate(next)}`;
}

/** Bar tone for `used` against `limit`: amber from 80%, red at the limit. */
export function barTone(usedCents: number, limitCents: number): UsageBarTone {
  if (limitCents <= 0) return usedCents > 0 ? "at" : "ok";
  if (usedCents >= limitCents) return "at";
  if (usedCents >= limitCents * NEAR_LIMIT_RATIO) return "near";
  return "ok";
}

function fillOf(usedCents: number, limitCents: number): number {
  if (limitCents > 0) return Math.min(1, Math.max(0, usedCents / limitCents));
  return usedCents > 0 ? 1 : 0;
}

/** The month against the included usage (no trial running). */
export function meterView(statement: MonthStatement): UsageMeterView {
  const { allowanceCents, usageCents } = statement;
  const over = usageCents > allowanceCents;
  const usedLine = allowanceCents > 0
    ? over
      ? `${formatUsd(usageCents)} used · ${formatUsd(allowanceCents)} free`
      : `${formatUsd(usageCents)} of ${formatUsd(allowanceCents)} free`
    : `${formatUsd(usageCents)} used`;
  const rows = groupUsageLines(statement.lines);
  const partial = !statement.complete || rows.some((r) => r.amount.kind !== "amount" || r.amount.partial);
  return {
    mode: "allowance",
    fill: fillOf(usageCents, allowanceCents),
    tone: barTone(usageCents, allowanceCents),
    over,
    // A partial total can only rise as missing days and meters arrive.
    usedLine: partial ? `At least ${usedLine}` : usedLine,
    resetLine: resetLine(statement),
    partial,
    rows,
    rowsNote: null,
  };
}

/** Days are free during the trial, so the statement has no per-meter costs yet. */
export const TRIAL_ROWS_NOTE = "Costs by meter start when the trial ends.";

/**
 * Trial usage against the trial cap. hq-pro reports trial usage as one total
 * (`usageTrial.usedCents`, from the same daily rollup); the month statement
 * leaves trial days out, so there are no per-group rows to show yet.
 */
export const TRIAL_MINIMUM_NOTE = "Some meters aren't counted yet, so trial usage can still go up.";

export function trialMeterView(trial: RunningTrial): UsageMeterView {
  const minimum = (trial.unknownMeters?.length ?? 0) > 0;
  const ends = new Date(trial.endsAt);
  const resetText = Number.isNaN(ends.getTime()) ? null : `Trial ends ${shortDate(ends)}`;
  if (trial.usedCents === null || trial.capCents === null) {
    return {
      mode: "trial",
      fill: 0,
      tone: "ok",
      over: false,
      usedLine: "Trial usage isn't measured yet",
      resetLine: resetText,
      partial: true,
      rows: [],
      rowsNote: TRIAL_ROWS_NOTE,
    };
  }
  const line = `${formatUsd(trial.usedCents)} of ${formatUsd(trial.capCents)} trial usage`;
  return {
    mode: "trial",
    fill: fillOf(trial.usedCents, trial.capCents),
    tone: barTone(trial.usedCents, trial.capCents),
    over: trial.usedCents >= trial.capCents,
    // With unread meters the figure is a floor, the same "At least" rule as the month view.
    usedLine: minimum ? `At least ${line}` : line,
    resetLine: resetText,
    partial: minimum,
    rows: [],
    rowsNote: TRIAL_ROWS_NOTE,
  };
}

const DAY_MS = 86_400_000;

/** Whole days left in the trial, rounded up; 0 once it has ended (the console's rule). */
export function trialDaysLeft(endsAt: string, now: Date = new Date()): number {
  const ms = Date.parse(endsAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

/** The running trial from a billing summary, or null when none is running. */
export function runningTrialFromSummary(summary: unknown, now: Date = new Date()): RunningTrial | null {
  if (!isRecord(summary) || !isRecord(summary.usageTrial)) return null;
  const trial = summary.usageTrial;
  const endsAt = str(trial.endsAt);
  if (trial.status !== "active" || !endsAt) return null;
  const daysLeft = trialDaysLeft(endsAt, now);
  if (daysLeft <= 0) return null;
  const unknownMeters = Array.isArray(trial.unknownMeters)
    ? trial.unknownMeters.filter((m): m is string => typeof m === "string" && m.length > 0)
    : [];
  return {
    endsAt,
    daysLeft,
    capCents: finite(trial.capCents),
    usedCents: finite(trial.usedCents),
    ...(unknownMeters.length > 0 ? { unknownMeters } : {}),
  };
}

function longDate(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The pause or card prompt on a billing summary, in plain words, with the
 * action for each state. A pause outranks a prompt; the trial cap outranks
 * the card rule. Amounts come from the summary (`capCents`,
 * `allowanceCents`); a missing amount drops it from the sentence rather
 * than guessing one.
 */
export function usageNoticeFromSummary(summary: unknown): UsageNotice | null {
  if (!isRecord(summary) || !isRecord(summary.usageTrial)) return null;
  const t = summary.usageTrial;
  const cap = finite(t.capCents);
  const allowance = finite(t.allowanceCents);
  const ends = str(t.endsAt) ? longDate(str(t.endsAt)!) : null;
  const capText = cap !== null ? `the trial's ${formatUsd(cap)} of usage` : "the trial's usage cap";
  const allowanceText = allowance !== null ? `the ${formatUsd(allowance)} of usage included this month` : "this month's included usage";
  const memberAsk = "Ask an owner or admin to add a card.";
  if (t.syncPaused === true && t.pauseReason === "usage_trial_cap") {
    return {
      kind: "paused-trial-cap",
      text: `Cloud sync is paused: ${capText} is used up.${ends ? ` It resumes when the trial ends on ${ends}, or` : " It resumes"} as soon as a card is added. Files on your computers are not affected.`,
      actionLabel: "Add a card to resume",
      memberText: `Cloud sync is paused: ${capText} is used up. ${memberAsk}`,
    };
  }
  if (t.syncPaused === true && t.pauseReason === "usage_card_required") {
    return {
      kind: "paused-card-required",
      text: `Cloud sync is paused: ${allowanceText} is used up. Add a card to resume. Files on your computers are not affected.`,
      actionLabel: "Add a card to resume",
      memberText: `Cloud sync is paused: ${allowanceText} is used up. ${memberAsk}`,
    };
  }
  if (t.capReached === true) {
    return {
      kind: "cap-reached",
      text: `${capText.charAt(0).toUpperCase()}${capText.slice(1)} is used up. Add a card to keep syncing.`,
      actionLabel: "Add a card",
      memberText: `${capText.charAt(0).toUpperCase()}${capText.slice(1)} is used up. ${memberAsk}`,
    };
  }
  if (t.cardRequired === true) {
    return {
      kind: "card-required",
      text: `Usage passed ${allowanceText}. Add a card to keep syncing.`,
      actionLabel: "Add a card",
      memberText: `Usage passed ${allowanceText}. ${memberAsk}`,
    };
  }
  return null;
}

/** "Trial, 1 day left" / "Trial, 12 days left". */
export function trialPlanLabel(daysLeft: number): string {
  return `Trial, ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
}

/**
 * Customer-facing plan name (owner decision 2026-10-18): a usage-priced
 * company is on the one "Usage plan", or "Trial, N days left" while its
 * trial runs. There are no plan tiers to compare.
 */
export function planLabelFromSummary(summary: unknown, now: Date = new Date()): string | null {
  if (!isRecord(summary)) return null;
  if (isUsageOnlySummary(summary)) {
    const trial = runningTrialFromSummary(summary, now);
    return trial ? trialPlanLabel(trial.daysLeft) : "Usage plan";
  }
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
 * statement is read only for a usage-priced company with no trial running
 * (during the trial the meter is the trial total from the summary).
 */
export async function readCoreUsage(
  source: CoreUsageSource | null | undefined,
  companyUid: string,
  companyName: string,
  now: () => Date = () => new Date(),
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
  const at = now();
  const base = {
    kind: "ready" as const,
    companyName,
    planLabel: planLabelFromSummary(summary.value, at),
    paid: billingIsSetUp(summary.value),
    notice: isUsageOnlySummary(summary.value) ? usageNoticeFromSummary(summary.value) : null,
  };
  if (!isUsageOnlySummary(summary.value)) return { ...base, usage: null, usageUnavailable: false };
  const trial = runningTrialFromSummary(summary.value, at);
  if (trial) return { ...base, usage: trialMeterView(trial), usageUnavailable: false };
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

/** Waits between automatic retries of a failed read (about three tries in all). */
export const USAGE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/**
 * {@link readCoreUsage} with quiet automatic retries: an "unavailable" answer
 * is tried again after each delay. Owner-only and ready answers return at once.
 */
export async function readCoreUsageWithRetry(
  source: CoreUsageSource | null | undefined,
  companyUid: string,
  companyName: string,
  opts: {
    delays?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    cancelled?: () => boolean;
    now?: () => Date;
  } = {},
): Promise<CoreUsageView> {
  const delays = opts.delays ?? USAGE_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let view = await readCoreUsage(source, companyUid, companyName, opts.now);
  for (const delay of delays) {
    if (view.kind !== "unavailable" || opts.cancelled?.()) break;
    await sleep(delay);
    if (opts.cancelled?.()) break;
    view = await readCoreUsage(source, companyUid, companyName, opts.now);
  }
  return view;
}

/** Last good view per company, so a reopened menu paints at once. */
const lastGood = new Map<string, { view: CoreUsageView; at: number }>();

export function cachedCoreUsage(companyUid: string): CoreUsageView | null {
  return lastGood.get(companyUid)?.view ?? null;
}

/** When the cached view for this company was read (epoch ms), or null. */
export function cachedCoreUsageAt(companyUid: string): number | null {
  return lastGood.get(companyUid)?.at ?? null;
}

/** Ready views and the owner-only answer are cached; failures never are. */
export function rememberCoreUsage(companyUid: string, view: CoreUsageView, at: number = Date.now()): void {
  if (view.kind === "ready" || view.kind === "owner-only") lastGood.set(companyUid, { view, at });
}

/** "Couldn't refresh. Showing usage from 3:12 PM." for numbers kept after a failed refresh. */
export function staleUsageLine(at: number | null): string {
  if (at === null) return "Couldn't refresh. These numbers may be out of date.";
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `Couldn't refresh. Showing usage from ${time}.`;
}

/** The company the Core menu's usage panel is about. A null uid means local only. */
export interface UsageCompany {
  uid: string | null;
  name: string;
  role: string | null;
}

export interface UsageCompanyRow {
  slug: string;
  displayName?: string | null;
  kind: string;
  cloudUid?: string | null;
  role?: string | null;
}

/**
 * Pick the panel's company. The company on screen wins, then the branded
 * company. When that company has no cloud account, the panel says it has no
 * usage: it never falls back to another company's spend. When neither slug
 * names a known company row (nothing on screen, or a slug with no company
 * row such as the personal space), the first cloud company stands in,
 * labelled with its own name.
 */
export function resolveUsageCompany(
  companies: readonly UsageCompanyRow[] | null | undefined,
  onScreenSlug: string | null | undefined,
  brandSlug: string | null | undefined,
): UsageCompany | null {
  const all = (companies ?? []).filter((c) => c.kind === "company");
  const toView = (c: UsageCompanyRow): UsageCompany => ({
    uid: (c.cloudUid ?? "").trim() || null,
    name: c.displayName || c.slug,
    role: c.role ?? null,
  });
  const slug = (onScreenSlug || brandSlug || "").trim();
  if (slug) {
    const row = all.find((c) => c.slug === slug);
    if (row) return toView(row);
  }
  const firstCloud = all.find((c) => (c.cloudUid ?? "").trim());
  return firstCloud ? toView(firstCloud) : null;
}

/** The caller's billing role from a roster or membership role string. */
export function billingRole(role: string | null | undefined): BillingRole {
  const r = (role ?? "").trim().toLowerCase();
  if (r === "owner") return "owner";
  if (r === "admin") return "admin";
  if (!r) return "unknown";
  return "member";
}

/** Roles the usage reads are owner-gated on: anything else gets a 403. */
export function canReadBilling(role: string | null | undefined): boolean {
  const r = billingRole(role);
  return r === "owner" || r === "unknown";
}

/**
 * Owners and admins may add the company's card (US-004). hq-pro's card
 * capture route admits admins once hq-pro #5063 lands; until then an admin's
 * click gets the plain owner-only hint, never a raw error.
 */
export function canSetUpBilling(role: string | null | undefined): boolean {
  const r = billingRole(role);
  return r === "owner" || r === "admin" || r === "unknown";
}

export function __resetCoreUsageCacheForTests(): void {
  lastGood.clear();
}
