/**
 * Copy for the first-run "Choose how your HQ runs." step (CompanyStep's plan
 * phase). The single source of truth for that copy in the desktop app.
 *
 * It mirrors the website's /welcome plan cards, so a person who saw the plans
 * there sees the same words here:
 * - indigoai-us/indigo-marketing `app/welcome/steps/ChoosePlan.tsx`
 *   (`TIERS`, rendered by `PlanCard`): names, prices, pitch, rows, CTAs and
 *   footnotes;
 * - `app/welcome/steps/PlanPicker.tsx`: the heading and the line under it;
 * - the Custom Implementation card's CTA links to `/call#book`.
 * Copied from indigo-marketing 328831025 (2026-10-03). Change the website
 * first, then this file; `plan-cards.test.ts` pins the key strings so drift
 * is a deliberate edit.
 *
 * The Starter numbers are hq-pro's PLAN_LIMITS.free ceilings. hq-pro
 * publishes them at GET /v1/pricing (plan id "free"), and the picker reads
 * that statement when it opens (`loadStarterAllowances`), so the card shows
 * the live ceilings. `STARTER_FALLBACK` is only used when the read fails.
 * Marketing copy only: enforcement is hq-pro's.
 */
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
}

export interface PlanCardCopy {
  plan: FirstRunPlan;
  name: string;
  price: string;
  suffix: string;
  blurb: string;
  rows: readonly PlanRow[];
  cta: string;
  ctaNote: string;
  /** Shown on the card the website features. */
  badge?: string;
  featured?: boolean;
}

export const PLAN_PICKER_COPY = {
  heading: 'Choose how your HQ runs.',
  subtitle: 'Start free and upgrade whenever. Everything you set up stays yours on any plan.',
  /** Workforce's CTA while checkout is being opened (the website's busy label). */
  checkoutBusy: 'Opening secure checkout…',
  /** The website's third card (Custom Implementation), as one link. */
  customSetupLead: 'Need a custom setup?',
  customSetupCta: 'Book a call',
  customSetupUrl: 'https://hqforwork.com/call#book',
} as const;

/** Starter's ceilings, as hq-pro's pricing statement states them. */
export interface StarterAllowances {
  users: number;
  secrets: number;
  storageBytes: number;
  integrations: number;
  deployments: number;
}

/**
 * hq-pro PLAN_LIMITS.free at the time of writing (integrations raised from 1
 * to 3 on 2026-10-08). Shown only when GET /v1/pricing cannot be read.
 */
export const STARTER_FALLBACK: StarterAllowances = {
  users: 5,
  secrets: 10,
  storageBytes: 10 * 1024 ** 3,
  integrations: 3,
  deployments: 500,
};

export const PRICING_PATH = '/v1/pricing';

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function gigabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

function starterCard(limits: StarterAllowances): PlanCardCopy {
  return {
    plan: 'starter',
    name: 'Starter',
    price: '$0',
    suffix: '/ mo',
    blurb: 'The shared brain for your team.',
    rows: [
      {
        label: 'People',
        value: `Up to ${limits.users} members, no seat fees`,
        detail: `Over ${limits.users}, HQ keeps working and reminds you`,
        state: 'capped',
      },
      { label: 'AI bots', value: 'None. They start on Workforce', state: 'off' },
      { label: 'Company brain', value: 'Vault, sync, secrets & deploy', state: 'on' },
      {
        label: 'Limits',
        value: `${count(limits.secrets, 'secret', 'secrets')} · ${gigabytes(limits.storageBytes)} · ${count(limits.integrations, 'integration', 'integrations')}, no MCP or Atlas`,
        detail: `${limits.deployments} lifetime deploys. Over a limit, new files and new secrets stop until you are back under`,
        state: 'capped',
      },
    ],
    cta: 'Get started free',
    ctaNote: 'No card required to start',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Starter's ceilings from a GET /v1/pricing body, or null when the body does
 * not carry a complete, finite Starter ("free") plan.
 */
export function starterAllowancesFromPricing(body: unknown): StarterAllowances | null {
  if (!isRecord(body) || !Array.isArray(body.plans)) return null;
  const plan = body.plans.find((entry) => isRecord(entry) && entry.id === 'free');
  if (!isRecord(plan) || !isRecord(plan.included)) return null;
  const included = plan.included;
  const users = positiveInt(included.users);
  const secrets = positiveInt(included.secrets);
  const storageBytes = positiveInt(included.storageBytes);
  const integrations = positiveInt(included.integrations);
  const deployments = positiveInt(included.deployments);
  if (!users || !secrets || !storageBytes || !integrations || !deployments) return null;
  return { users, secrets, storageBytes, integrations, deployments };
}

/** Read Starter's ceilings from hq-pro. Null on any failure; the caller keeps the fallback. */
export async function loadStarterAllowances(invoke: InvokeFn): Promise<StarterAllowances | null> {
  try {
    const response = await invoke<unknown>('hq_pro_fetch', { url: PRICING_PATH, method: 'GET', body: null });
    if (!isRecord(response) || response.status !== 200 || typeof response.body !== 'string') return null;
    return starterAllowancesFromPricing(JSON.parse(response.body));
  } catch (error) {
    console.warn('onboarding: pricing read failed', error);
    return null;
  }
}

/** The picker's cards with Starter built from the given ceilings. */
export function planCardsFor(starter: StarterAllowances): readonly PlanCardCopy[] {
  return [starterCard(starter), WORKFORCE_CARD];
}

const WORKFORCE_CARD: PlanCardCopy = {
  plan: 'workforce',
  name: 'Workforce',
  price: '$500',
  suffix: '/ mo flat',
  blurb: 'No seat fees, no Starter ceilings.',
  rows: [
    {
      label: 'AI bots',
      value: 'Hosted teammates with Slack, email, and your company context',
      detail: 'From $100/mo per box · self-run bots free',
      state: 'on',
    },
    { label: 'Company brain', value: '+ hosted MCP, meetings, ontology & signals', state: 'on' },
    { label: 'Limits', value: 'Unlimited secrets, storage & deploys', state: 'on' },
    { label: 'Launch & support', value: 'One onboarding session + private Slack', state: 'on' },
  ],
  cta: 'Get started',
  ctaNote: 'Month to month · cancel anytime',
  badge: 'Most popular',
  featured: true,
};

export const PLAN_CARDS: readonly PlanCardCopy[] = planCardsFor(STARTER_FALLBACK);
