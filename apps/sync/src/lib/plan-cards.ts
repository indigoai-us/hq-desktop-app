/**
 * Copy for the first-run "Choose how your HQ runs." step (CompanyStep's plan
 * phase). The single source of truth for that copy in the desktop app.
 *
 * New companies get one card: usage pricing, as hq-pro publishes it at
 * `GET /v1/pricing` (`usage` and `signup` blocks, usage-only-pricing landing
 * 2026-10-16). The card's primary action is the feed's `free` signup option
 * ("Sign up free"); under it sit the enterprise demo link (the feed's
 * `enterprise` option) and the self-hosted guide link (`signup.selfHosted`).
 *
 * The picker reads the feed when it opens (`loadUsageCard`). Until then, or
 * when the feed is unreadable or lacks a block, the bundled copy of the
 * contract (`PRICING_FALLBACK` in @hq/ui) fills in. Starter, Workforce and
 * Individual are closed to new signups; existing companies keep their plans
 * and never see this step. Marketing copy only: billing is hq-pro's.
 */
import {
  PRICING_FALLBACK,
  PRICING_PATH,
  boxLadder,
  boxRange,
  formatCardUsd,
  freeList,
  meterRate,
  pricingFromFeed,
  vaultMeter,
  type PricingFeed,
} from '@hq/ui';
import type { FirstRunPlan, InvokeFn } from './first-run-company';

/** What a row's mark means: included, not included, or included up to a limit. */
export type PlanRowState = 'on' | 'off' | 'capped';

export interface PlanRow {
  /** The band the row answers (read by screen readers before the value). */
  label: string;
  value: string;
  /** Fine print, run on after the value. */
  detail?: string;
  state: PlanRowState;
  /** Spans the card's full width (rows with fine print). */
  wide?: boolean;
}

export interface PlanLink {
  label: string;
  url: string;
}

export interface UsageCardCopy {
  plan: FirstRunPlan;
  name: string;
  price: string;
  suffix: string;
  blurb: string;
  rows: readonly PlanRow[];
  cta: string;
  ctaNote: string;
  /** "Book a setup call", next to the card's own action. */
  enterprise: PlanLink | null;
  /** "Use HQ free, self-hosted or on-prem", under the card. */
  selfHosted: PlanLink;
}

/**
 * Where the enterprise demo link goes: the website's booking section, the same
 * target the picker's "Book a call" link used before the usage card.
 */
export const ENTERPRISE_DEMO_URL = 'https://hqforwork.com/call#book';

export const PLAN_PICKER_COPY = {
  heading: 'Choose how your HQ runs.',
  subtitle: 'Pay for what your team uses. Everything you set up stays yours.',
  selfHostedLead: 'For advanced, enterprise and government teams:',
} as const;

export { PRICING_PATH };

function money(amount: number): string {
  return formatCardUsd(amount);
}

/** The single usage card, built from a parsed feed. */
export function usageCardFor(feed: PricingFeed): UsageCardCopy {
  const { usage, signup } = feed;
  const free = signup.options.find((option) => option.id === 'free');
  const enterprise = signup.options.find((option) => option.id === 'enterprise');
  const vault = vaultMeter(usage);
  const rates = usage.meters.filter((meter) => meter.id !== 'vault');
  const rows: PlanRow[] = rates.map((meter) => ({ label: meter.label, value: meterRate(meter), state: 'on' }));
  if (vault) {
    rows.push({
      label: vault.label,
      value: `${money(vault.unitUsd)} per vault a month`,
      detail: vault.waivedInTrial ? 'Company and personal vaults. Waived during the trial' : 'Company and personal vaults',
      state: 'on',
      wide: true,
    });
  }
  if (usage.boxes.length > 0) {
    rows.push({
      label: 'Cloud bot boxes',
      value: boxRange(usage.boxes),
      detail: boxLadder(usage.boxes),
      state: 'on',
      wide: true,
    });
  }
  const freeWords = freeList(usage.free);
  if (freeWords) rows.push({ label: 'Free', value: freeWords, state: 'on', wide: true });
  return {
    plan: 'free',
    name: 'Usage',
    price: money(usage.includedUsd),
    suffix: 'included every month',
    blurb: `Pay only for usage past the ${money(usage.includedUsd)} each month.`,
    rows,
    cta: free?.label ?? 'Sign up free',
    ctaNote: `${usage.trial.days}-day trial, usage capped at ${money(usage.trial.capUsd)}`,
    enterprise: enterprise ? { label: enterprise.label, url: ENTERPRISE_DEMO_URL } : null,
    selfHosted: { label: signup.selfHosted.label, url: signup.selfHosted.url },
  };
}

/** The card from the bundled contract copy, shown until the feed answers. */
export const USAGE_CARD: UsageCardCopy = usageCardFor(PRICING_FALLBACK);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the price list from hq-pro and build the card. Any failure (offline,
 * non-200, not JSON) returns the card from the bundled contract copy.
 */
export async function loadUsageCard(invoke: InvokeFn): Promise<UsageCardCopy> {
  try {
    const response = await invoke<unknown>('hq_pro_fetch', { url: PRICING_PATH, method: 'GET', body: null });
    if (!isRecord(response) || response.status !== 200 || typeof response.body !== 'string') return USAGE_CARD;
    return usageCardFor(pricingFromFeed(JSON.parse(response.body)));
  } catch (error) {
    console.warn('onboarding: pricing read failed', error);
    return USAGE_CARD;
  }
}
