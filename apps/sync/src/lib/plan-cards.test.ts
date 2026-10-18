import { describe, expect, it, vi } from 'vitest';
import { PRICING_FALLBACK, pricingFromFeed } from '@hq/ui';
import { ENTERPRISE_DEMO_URL, PLAN_PICKER_COPY, USAGE_CARD, loadUsageCard, usageCardFor } from './plan-cards';
import type { InvokeFn } from './first-run-company';

// The GET /v1/pricing contract for the 2026-10-16 usage-pricing landing
// (projects/usage-only-pricing/landing-2026-10-16/README.md, "Feed contract").
const FEED = {
  usage: {
    version: '2026-10-16',
    newSignupsFrom: '2026-10-16T18:00:00Z',
    includedUsd: 10,
    trial: { days: 30, capUsd: 500 },
    meters: [
      { id: 'member-sync', label: 'Sync', unit: 'sync', unitUsd: 0.1 },
      { id: 'integration-call', label: 'Gateway call', unit: 'call', unitUsd: 0.05 },
      { id: 'hq-mcp-call', label: 'HQ MCP call', unit: 'call', unitUsd: 0.05 },
      { id: 'agent-run', label: 'Agent run', unit: 'run', unitUsd: 0.05 },
      { id: 'storage', label: 'Storage', unit: 'GB-month', unitUsd: 2.0 },
      { id: 'secret', label: 'Secret', unit: 'secret-month', unitUsd: 0.5 },
      { id: 'vault', label: 'Vault', unit: 'vault-month', unitUsd: 5.0, waivedInTrial: true },
    ],
    boxes: [
      { size: 'small', instanceType: 't3.small', monthlyUsd: 100 },
      { size: 'medium', instanceType: 't3.medium', monthlyUsd: 200 },
      { size: 'large', instanceType: 't3.large', monthlyUsd: 400 },
      { size: 'xlarge', instanceType: 't3.xlarge', monthlyUsd: 800 },
    ],
    free: ['deploys', 'dms', 'background-ai'],
    domains: { standardUsd: 20, premiumUsd: 500 },
  },
  signup: {
    options: [
      { id: 'free', label: 'Sign up free' },
      { id: 'enterprise', label: 'Request an enterprise demo' },
    ],
    selfHosted: { label: 'Use HQ free, self-hosted or on-prem', url: 'https://docs.hq.computer/hq/guide/use-hq-for-free/' },
  },
  // Legacy plans stay in the feed for existing customers.
  plans: [{ id: 'free', displayName: 'Starter', newSignupsUntil: '2026-10-16T18:00:00Z', included: {} }],
};

function rows(card = USAGE_CARD): Array<[string, string, string | null]> {
  return card.rows.map((row) => [row.label, row.value, row.detail ?? null]);
}

describe('the usage card', () => {
  it('shows the locked card: $10 included, the rates, the $5 vault, $100 to $800 boxes and the trial cap', () => {
    expect([USAGE_CARD.plan, USAGE_CARD.name, USAGE_CARD.price, USAGE_CARD.suffix]).toEqual([
      'free',
      'Usage',
      '$10',
      'included every month',
    ]);
    expect(USAGE_CARD.blurb).toBe('Pay only for usage past the $10 each month.');
    expect(rows()).toEqual([
      ['Sync', '$0.10 per sync', null],
      ['Gateway call', '$0.05 per call', null],
      ['HQ MCP call', '$0.05 per call', null],
      ['Agent run', '$0.05 per run', null],
      ['Storage', '$2.00 per GB-month', null],
      ['Secret', '$0.50 per secret-month', null],
      ['Vault', '$5 per vault a month', 'Company and personal vaults. Waived during the trial'],
      ['Cloud bot boxes', '$100 to $800 a month', 'small $100 · medium $200 · large $400 · xlarge $800'],
      ['Free', 'Deploys, DMs and background AI', null],
    ]);
    expect(USAGE_CARD.rows.every((row) => row.state === 'on')).toBe(true);
    expect([USAGE_CARD.cta, USAGE_CARD.ctaNote]).toEqual(['Sign up free', '30-day trial, usage capped at $500']);
  });

  it('links the enterprise demo and the self-hosted guide', () => {
    expect(USAGE_CARD.enterprise).toEqual({ label: 'Request an enterprise demo', url: ENTERPRISE_DEMO_URL });
    expect(ENTERPRISE_DEMO_URL).toBe('https://hqforwork.com/call#book');
    expect(USAGE_CARD.selfHosted).toEqual({
      label: 'Use HQ free, self-hosted or on-prem',
      url: 'https://docs.hq.computer/hq/guide/use-hq-for-free/',
    });
  });

  it('builds the same card from the published feed as from the bundled fallback', () => {
    const live = pricingFromFeed(FEED);
    expect(live.live).toBe(true);
    expect(usageCardFor(live)).toEqual(USAGE_CARD);
  });

  it('follows the feed when the server changes a number', () => {
    const changed = structuredClone(FEED);
    changed.usage.includedUsd = 15;
    changed.usage.trial.capUsd = 250;
    changed.usage.meters[0]!.unitUsd = 0.08;
    changed.usage.boxes = changed.usage.boxes.slice(0, 2);
    const card = usageCardFor(pricingFromFeed(changed));
    expect(card.price).toBe('$15');
    expect(card.ctaNote).toBe('30-day trial, usage capped at $250');
    expect(card.rows[0]).toMatchObject({ label: 'Sync', value: '$0.08 per sync' });
    expect(card.rows.find((row) => row.label === 'Cloud bot boxes')).toMatchObject({
      value: '$100 to $200 a month',
      detail: 'small $100 · medium $200',
    });
  });

  it('keeps the live rates when the feed has `usage` but no `signup` yet', () => {
    const usageOnly = { usage: { ...FEED.usage, includedUsd: 12 } };
    const feed = pricingFromFeed(usageOnly);
    expect(feed.live).toBe(false);
    const card = usageCardFor(feed);
    expect(card.price).toBe('$12');
    expect(card.cta).toBe('Sign up free');
    expect(card.enterprise?.label).toBe('Request an enterprise demo');
  });

  it('falls back to the bundled card for a feed without a usable `usage` block', () => {
    for (const body of [null, {}, { plans: FEED.plans }, { usage: { ...FEED.usage, meters: [] } }, { usage: { ...FEED.usage, trial: null } }]) {
      expect(usageCardFor(pricingFromFeed(body))).toEqual(USAGE_CARD);
    }
    const badMeter = structuredClone(FEED);
    (badMeter.usage.meters[2] as { unitUsd: unknown }).unitUsd = '0.05';
    expect(pricingFromFeed(badMeter).usage).toBe(PRICING_FALLBACK.usage);
  });

  it('drops the enterprise link when the feed offers only the free signup', () => {
    const freeOnly = structuredClone(FEED);
    freeOnly.signup.options = [{ id: 'free', label: 'Sign up free' }];
    expect(usageCardFor(pricingFromFeed(freeOnly)).enterprise).toBeNull();
  });

  it('never takes a non-https self-hosted link from the feed', () => {
    const bad = structuredClone(FEED);
    bad.signup.selfHosted.url = 'http://docs.hq.computer/hq/guide/use-hq-for-free/';
    expect(usageCardFor(pricingFromFeed(bad)).selfHosted.url).toBe('https://docs.hq.computer/hq/guide/use-hq-for-free/');
  });

  it('loads through hq_pro_fetch and returns the bundled card on any failure', async () => {
    const answer = (status: number, body: string) => vi.fn(async () => ({ status, body })) as unknown as InvokeFn;
    const changed = structuredClone(FEED);
    changed.usage.includedUsd = 20;
    const ok = answer(200, JSON.stringify(changed));
    expect((await loadUsageCard(ok)).price).toBe('$20');
    expect(ok).toHaveBeenCalledWith('hq_pro_fetch', { url: '/v1/pricing', method: 'GET', body: null });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadUsageCard(answer(503, '{}'))).toBe(USAGE_CARD);
    expect(await loadUsageCard(answer(200, 'not json'))).toBe(USAGE_CARD);
    const offline = vi.fn(async () => {
      throw new Error('Network error');
    }) as unknown as InvokeFn;
    expect(await loadUsageCard(offline)).toBe(USAGE_CARD);
    warn.mockRestore();
  });
});

// Design review (2026-10-12): the app's own words stay plain. No internal
// product names (Atlas, ontology), no pointer at a #setup channel the person
// has not seen yet, no em dashes, and no closed plan names. Meter labels come
// verbatim from the locked card, so "HQ MCP call" is the one MCP mention.
describe('plan copy stays in plain words', () => {
  function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
  }

  const FORBIDDEN = [/Atlas/i, /ontology/i, /#setup/, /—/, /Workforce/, /Starter/];

  it('has no Atlas, ontology, #setup, em dash or closed plan name in any card or picker string', () => {
    const copy = [...strings(PLAN_PICKER_COPY), ...strings(USAGE_CARD)];
    expect(copy.length).toBeGreaterThan(20);
    for (const text of copy) {
      for (const pattern of FORBIDDEN) {
        expect(text, `"${text}" matches ${pattern}`).not.toMatch(pattern);
      }
    }
    expect(copy.filter((text) => /MCP/.test(text))).toEqual(['HQ MCP call']);
  });
});
