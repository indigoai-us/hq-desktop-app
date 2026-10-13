import { describe, expect, it, vi } from 'vitest';
import {
  PLAN_CARDS,
  PLAN_PICKER_COPY,
  STARTER_FALLBACK,
  loadStarterAllowances,
  planCardsFor,
  starterAllowancesFromPricing,
} from './plan-cards';
import { CHECKOUT_DISABLED_REASON, CHECKOUT_FAILED_REASON, type InvokeFn } from './first-run-company';

// Pins the plan copy the app shares with the website's /welcome cards
// (indigo-marketing app/welcome/steps/ChoosePlan.tsx and PlanPicker.tsx).
// A failure here means the copy changed: update it on purpose, from the
// website source, and update these strings with it.
describe('plan card copy', () => {
  it('uses the website heading and line under it', () => {
    expect(PLAN_PICKER_COPY.heading).toBe('Choose how your HQ runs.');
    expect(PLAN_PICKER_COPY.subtitle).toBe(
      'Start free and upgrade whenever. Everything you set up stays yours on any plan.',
    );
    expect(PLAN_PICKER_COPY.customSetupUrl).toBe('https://hqforwork.com/call#book');
  });

  it('offers Starter then Workforce, with the website prices, pitches and CTAs', () => {
    expect(PLAN_CARDS.map((card) => card.plan)).toEqual(['starter', 'workforce']);
    const [starter, workforce] = PLAN_CARDS;
    expect([starter!.name, starter!.price, starter!.suffix, starter!.blurb]).toEqual([
      'Starter',
      '$0',
      '/ mo',
      'The shared brain for your team.',
    ]);
    expect([starter!.cta, starter!.ctaNote]).toEqual(['Get started free', 'No card required to start']);
    expect([workforce!.name, workforce!.price, workforce!.suffix, workforce!.blurb, workforce!.badge]).toEqual([
      'Workforce',
      '$500',
      '/ mo flat',
      'No seat fees, no Starter ceilings.',
      'Most popular',
    ]);
    expect([workforce!.cta, workforce!.ctaNote]).toEqual(['Get started', 'Month to month · cancel anytime']);
  });

  it('keeps the rows and what each mark means', () => {
    const rows = (index: number) => PLAN_CARDS[index]!.rows.map((row) => [row.state, row.value, row.detail ?? null]);
    expect(rows(0)).toEqual([
      ['capped', 'Up to 5 members, no seat fees', 'Over 5, HQ keeps working and reminds you'],
      ['off', 'None. They start on Workforce', null],
      ['on', 'Vault, sync, secrets & deploy', null],
      [
        'capped',
        '10 secrets · 10 GB · 3 integrations',
        '500 lifetime deploys. Over a limit, new files and new secrets stop until you are back under',
      ],
    ]);
    expect(rows(1)).toEqual([
      ['on', 'Hosted teammates with Slack, email, and your company context', 'From $100/mo per box · self-run bots free'],
      ['on', '+ meeting notes, a company knowledge map and an AI tool connection', null],
      ['on', 'Unlimited secrets, storage & deploys', null],
      ['on', 'One onboarding session + private Slack', null],
    ]);
  });
});

// The shape hq-pro's GET /v1/pricing answers with (src/billing/pricing-statement.ts).
const PRICING = {
  version: 1,
  plans: [
    {
      id: 'free',
      displayName: 'Starter',
      included: { users: 5, secrets: 10, deployments: 500, storageBytes: 10737418240, integrations: 3, agents: 0 },
    },
    {
      id: 'paid-500',
      displayName: 'Workforce',
      included: { users: null, secrets: null, deployments: null, storageBytes: null, integrations: null, agents: null },
    },
  ],
};

describe('Starter ceilings from GET /v1/pricing', () => {
  it('reads the free plan, and the fallback matches it', () => {
    expect(starterAllowancesFromPricing(PRICING)).toEqual({
      users: 5,
      secrets: 10,
      storageBytes: 10737418240,
      integrations: 3,
      deployments: 500,
    });
    expect(STARTER_FALLBACK).toEqual(starterAllowancesFromPricing(PRICING));
  });

  it('rejects a body without a complete, finite Starter plan', () => {
    expect(starterAllowancesFromPricing(null)).toBeNull();
    expect(starterAllowancesFromPricing({ plans: [] })).toBeNull();
    const unlimited = structuredClone(PRICING);
    unlimited.plans[0]!.included.integrations = null as unknown as number;
    expect(starterAllowancesFromPricing(unlimited)).toBeNull();
  });

  it('builds the Starter card from whatever the server says', () => {
    const [starter, workforce] = planCardsFor({ ...STARTER_FALLBACK, users: 8, integrations: 1, deployments: 250 });
    expect(starter!.rows.map((row) => row.value)).toEqual([
      'Up to 8 members, no seat fees',
      'None. They start on Workforce',
      'Vault, sync, secrets & deploy',
      '10 secrets · 10 GB · 1 integration',
    ]);
    expect(starter!.rows[3]!.detail).toMatch(/^250 lifetime deploys\./);
    expect(workforce).toBe(PLAN_CARDS[1]);
  });

  it('loads through hq_pro_fetch and returns null on any failure', async () => {
    const answer = (status: number, body: string) => vi.fn(async () => ({ status, body })) as unknown as InvokeFn;
    const ok = answer(200, JSON.stringify(PRICING));
    expect(await loadStarterAllowances(ok)).toEqual(STARTER_FALLBACK);
    expect(ok).toHaveBeenCalledWith('hq_pro_fetch', { url: '/v1/pricing', method: 'GET', body: null });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadStarterAllowances(answer(503, '{}'))).toBeNull();
    expect(await loadStarterAllowances(answer(200, 'not json'))).toBeNull();
    const offline = vi.fn(async () => {
      throw new Error('Network error');
    }) as unknown as InvokeFn;
    expect(await loadStarterAllowances(offline)).toBeNull();
    warn.mockRestore();
  });
});

// Design review (2026-10-12): the app speaks plain words. No internal product
// names (MCP, Atlas, ontology), no pointer at a #setup channel the person has
// not seen yet, and no em dashes in what the plan screen says.
describe('plan copy stays in plain words', () => {
  function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
  }

  const FORBIDDEN = [/MCP/, /Atlas/i, /ontology/i, /#setup/, /\u2014/];

  it('has no MCP, Atlas, ontology, #setup or em dash in any card or picker string', () => {
    const copy = [
      ...strings(PLAN_PICKER_COPY),
      ...strings(PLAN_CARDS),
      // Cards built from other server ceilings too, singular and plural.
      ...strings(planCardsFor({ ...STARTER_FALLBACK, users: 1, integrations: 1, secrets: 1 })),
      ...strings(planCardsFor({ ...STARTER_FALLBACK, users: 8, integrations: 4, secrets: 12 })),
    ];
    expect(copy.length).toBeGreaterThan(20);
    for (const text of copy) {
      for (const pattern of FORBIDDEN) {
        expect(text, `"${text}" matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('points checkout trouble at HQ Desktop, never at #setup', () => {
    for (const reason of [CHECKOUT_DISABLED_REASON, CHECKOUT_FAILED_REASON]) {
      expect(reason).not.toContain('#setup');
      expect(reason).toContain('in HQ Desktop');
      expect(reason).not.toMatch(/\u2014/);
    }
  });
});
