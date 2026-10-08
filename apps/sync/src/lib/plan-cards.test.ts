import { describe, expect, it } from 'vitest';
import { PLAN_CARDS, PLAN_PICKER_COPY } from './plan-cards';

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
        '10 secrets · 10 GB · 3 integrations, no MCP or Atlas',
        '500 lifetime deploys. Over a limit, new files and new secrets stop until you are back under',
      ],
    ]);
    expect(rows(1)).toEqual([
      ['on', 'Hosted teammates with Slack, email, and your company context', 'From $100/mo per box · self-run bots free'],
      ['on', '+ hosted MCP, meetings, ontology & signals', null],
      ['on', 'Unlimited secrets, storage & deploys', null],
      ['on', 'One onboarding session + private Slack', null],
    ]);
  });
});
