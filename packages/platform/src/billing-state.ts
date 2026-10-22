/**
 * The shared plan status from hq-pro (usage-only-pricing US-024).
 *
 * hq-pro #5088 adds `billingState` to the billing summary, the usage-limits
 * read and each membership row. It is the one server answer to "how is this
 * account billed":
 *
 *   { version: 1, scope: "company" | "person",
 *     kind: "usage" | "usage-trial" | "legacy-payer" | "legacy-free" | "enterprise" | "comped",
 *     view: "full" | "member",
 *     trial: { daysLeft, endsAt, capCents, usedCents } | null,
 *     spendLimit: { cents } | null, cardOnFile, cardPrompt,
 *     paused: { reason, resumesOn } | null,
 *     actions: { addCard, raiseLimit, switchToUsage, manageBilling } }
 *
 * When `billingState` is present it wins over the older `pricingPlan` field.
 * Servers without it keep the `pricingPlan` fallback (see
 * {@link isUsagePricedRecord}).
 *
 * A usage pause (trial cap, card required, spend limit) also reaches clients
 * on a refused request as `usagePause: { code: "usage_paused", reason,
 * message, actionUrl }` beside the legacy plan-limit fields. The server
 * message is shown as is, with an action that depends on the reader's role:
 * owners and admins get the Billing link, members are asked to contact an
 * owner ({@link usagePauseAction}).
 */

import { approvedPlanUpgradeUrl } from "./plan-limit.js";

export const BILLING_STATE_VERSION = 1;

export type BillingKind =
  | "usage"
  | "usage-trial"
  | "legacy-payer"
  | "legacy-free"
  | "enterprise"
  | "comped";

const BILLING_KINDS: ReadonlySet<string> = new Set<BillingKind>([
  "usage",
  "usage-trial",
  "legacy-payer",
  "legacy-free",
  "enterprise",
  "comped",
]);

export type UsagePauseReason = "usage_trial_cap" | "usage_card_required" | "usage_spend_limit";

const USAGE_PAUSE_REASONS: ReadonlySet<string> = new Set<UsagePauseReason>([
  "usage_trial_cap",
  "usage_card_required",
  "usage_spend_limit",
]);

export function isUsagePauseReason(value: unknown): value is UsagePauseReason {
  return typeof value === "string" && USAGE_PAUSE_REASONS.has(value);
}

export interface BillingStateTrial {
  daysLeft: number | null;
  endsAt: string | null;
  capCents: number | null;
  usedCents: number | null;
}

export interface BillingStatePause {
  reason: UsagePauseReason;
  resumesOn: string | null;
}

export interface BillingStateActions {
  addCard: boolean;
  raiseLimit: boolean;
  switchToUsage: boolean;
  manageBilling: boolean;
}

export interface BillingState {
  version: typeof BILLING_STATE_VERSION;
  scope: "company" | "person";
  kind: BillingKind;
  view: "full" | "member";
  trial: BillingStateTrial | null;
  spendLimit: { cents: number | null } | null;
  cardOnFile: boolean | null;
  cardPrompt: boolean;
  paused: BillingStatePause | null;
  actions: BillingStateActions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read a `billingState` block. Null unless it is version 1 with a known kind,
 * so a future breaking version or a malformed block falls back to the older
 * fields instead of being guessed at. Missing optional parts get safe
 * defaults (no trial, no pause, no actions).
 */
export function parseBillingState(value: unknown): BillingState | null {
  if (!isRecord(value) || value.version !== BILLING_STATE_VERSION) return null;
  const kind = value.kind;
  if (typeof kind !== "string" || !BILLING_KINDS.has(kind)) return null;
  const scope = value.scope === "person" ? "person" : "company";
  const view = value.view === "member" ? "member" : "full";
  const trialRaw = isRecord(value.trial) ? value.trial : null;
  const trial: BillingStateTrial | null = trialRaw
    ? {
        daysLeft: finite(trialRaw.daysLeft),
        endsAt: text(trialRaw.endsAt),
        capCents: finite(trialRaw.capCents),
        usedCents: finite(trialRaw.usedCents),
      }
    : null;
  const pausedRaw = isRecord(value.paused) ? value.paused : null;
  const paused: BillingStatePause | null =
    pausedRaw && isUsagePauseReason(pausedRaw.reason)
      ? { reason: pausedRaw.reason, resumesOn: text(pausedRaw.resumesOn) }
      : null;
  const spendRaw = isRecord(value.spendLimit) ? value.spendLimit : null;
  const actionsRaw = isRecord(value.actions) ? value.actions : {};
  return {
    version: BILLING_STATE_VERSION,
    scope,
    kind: kind as BillingKind,
    view,
    trial,
    spendLimit: spendRaw ? { cents: finite(spendRaw.cents) } : null,
    cardOnFile: typeof value.cardOnFile === "boolean" ? value.cardOnFile : null,
    cardPrompt: value.cardPrompt === true,
    paused,
    actions: {
      addCard: actionsRaw.addCard === true,
      raiseLimit: actionsRaw.raiseLimit === true,
      switchToUsage: actionsRaw.switchToUsage === true,
      manageBilling: actionsRaw.manageBilling === true,
    },
  };
}

export function isUsageBillingKind(kind: BillingKind): boolean {
  return kind === "usage" || kind === "usage-trial";
}

/** The `pricingPlan` value older servers send for a usage-priced company. */
export const LEGACY_USAGE_PRICING_PLAN = "usage-only";

/**
 * True when a summary, membership row or usage-limits body says the account
 * is on usage pricing. `billingState` wins when present and valid; only a
 * server without it falls back to `pricingPlan: "usage-only"`.
 */
export function isUsagePricedRecord(record: unknown): boolean {
  if (!isRecord(record)) return false;
  const state = parseBillingState(record.billingState);
  if (state) return isUsageBillingKind(state.kind);
  return record.pricingPlan === LEGACY_USAGE_PRICING_PLAN;
}

// ---------------------------------------------------------------------------
// Usage pause on a refused request
// ---------------------------------------------------------------------------

export const USAGE_PAUSE_CODE = "usage_paused";

export interface UsagePause {
  code: typeof USAGE_PAUSE_CODE;
  reason: UsagePauseReason;
  /** One plain-language paragraph from the server. Shown as is. */
  message: string;
  /** The Billing page to act on, approved like any server billing link. */
  actionUrl: string;
}

/**
 * Read a `usagePause` block. Null unless it has the `usage_paused` code, a
 * known reason, a message and an approved https action link. An unknown
 * future reason is not guessed at: the body then keeps its legacy handling.
 */
export function parseUsagePause(value: unknown): UsagePause | null {
  if (!isRecord(value) || value.code !== USAGE_PAUSE_CODE) return null;
  if (!isUsagePauseReason(value.reason)) return null;
  const message = text(value.message);
  const actionUrl = approvedPlanUpgradeUrl(value.actionUrl);
  if (!message || !actionUrl) return null;
  return { code: USAGE_PAUSE_CODE, reason: value.reason, message, actionUrl };
}

/** Owners and admins manage billing; a member asks one of them. Unknown counts as able. */
export function roleCanManageBilling(role: string | null | undefined): boolean {
  const value = (role ?? "").trim().toLowerCase();
  return value !== "member" && value !== "guest" && value !== "viewer";
}

export const USAGE_PAUSE_BILLING_LABEL = "Open Billing";

export type UsagePauseAction =
  | { kind: "billing"; label: string; url: string }
  | { kind: "ask-owner"; hint: string };

/** What a member is asked to do, by pause reason. */
export function askOwnerHint(reason: UsagePauseReason | null | undefined): string {
  if (reason === "usage_spend_limit") {
    return "Ask a company owner or admin to raise the spend limit.";
  }
  return "Ask a company owner or admin to add a card on the Billing page.";
}

/**
 * What to offer under a usage pause: the Billing link for an owner or admin
 * (or an unknown role, since the Billing page checks access itself), and a
 * request to ask an owner for a member.
 */
export function usagePauseAction(
  pause: Pick<UsagePause, "reason" | "actionUrl">,
  role: string | null | undefined,
): UsagePauseAction {
  if (!roleCanManageBilling(role)) return { kind: "ask-owner", hint: askOwnerHint(pause.reason) };
  return { kind: "billing", label: USAGE_PAUSE_BILLING_LABEL, url: pause.actionUrl };
}

/**
 * A plain sentence for a pause known only from `billingState.paused`, when no
 * server message came with it.
 */
export function billingPauseMessage(reason: UsagePauseReason, company?: string | null): string {
  const who = company?.trim() || "This company";
  if (reason === "usage_spend_limit") {
    return `Cloud sync is paused. ${who} reached its monthly spend limit. Raise the limit on the Billing page to resume. Files on this computer are not affected.`;
  }
  if (reason === "usage_trial_cap") {
    return `Cloud sync is paused. ${who} used the usage included in its trial. Add a card on the Billing page to resume. Files on this computer are not affected.`;
  }
  return `Cloud sync is paused. ${who} used its monthly allowance. Add a card on the Billing page to resume. Files on this computer are not affected.`;
}
