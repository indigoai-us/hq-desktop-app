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
 * The Starter numbers are hq-pro's PLAN_LIMITS.free ceilings, the same
 * contract the website states. Marketing copy only: enforcement is hq-pro's.
 */
import type { FirstRunPlan } from './first-run-company';

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

export const PLAN_CARDS: readonly PlanCardCopy[] = [
  {
    plan: 'starter',
    name: 'Starter',
    price: '$0',
    suffix: '/ mo',
    blurb: 'The shared brain for your team.',
    rows: [
      {
        label: 'People',
        value: 'Up to 5 members, no seat fees',
        detail: 'Over 5, HQ keeps working and reminds you',
        state: 'capped',
      },
      { label: 'AI bots', value: 'None. They start on Workforce', state: 'off' },
      { label: 'Company brain', value: 'Vault, sync, secrets & deploy', state: 'on' },
      {
        label: 'Limits',
        value: '10 secrets · 10 GB · 3 integrations, no MCP or Atlas',
        detail: '500 lifetime deploys. Over a limit, new files and new secrets stop until you are back under',
        state: 'capped',
      },
    ],
    cta: 'Get started free',
    ctaNote: 'No card required to start',
  },
  {
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
  },
];
