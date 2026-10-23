// @vitest-environment happy-dom
//
// Free-plan usage data, desktop side: a person on a free company who opted
// out earlier sees ONE card at launch, inside the existing consent screen. It
// says free companies require usage data and this account is sending it, and
// its only way to opt out is upgrading. It is shown once (guard written when
// displayed), never loops (an acknowledged notice never re-arms it), and a
// paid company keeps its share/decline choice, so a paid person can still opt
// out. The 390px layout check lives in e2e/browser/free-plan-telemetry-card.spec.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const listen = vi.hoisted(() => vi.fn(async () => () => {}));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
const openExternal = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openExternal }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn(async () => ({ ok: true, status: 200 })) }));

import { flushSync, mount, tick, unmount } from 'svelte';
import OnboardingWizard from '../../src/components/onboarding/OnboardingWizard.svelte';
import { __resetWizardRouterCompletionForTests, WIZARD_STEPS } from '../../src/lib/onboarding-wizard';
import {
  markRequiredCardShown,
  readFreePlanTelemetry,
  requiredCardAlreadyShown,
  shouldShowRequiredCard,
} from '../../src/lib/free-plan-telemetry';

const CONSENT_STEP = WIZARD_STEPS.find((s) => s.id === 'consent')!.index;
const PERSON = 'prs_free_optout';

const DISCLOSURE = {
  version: '2026-10-22',
  title: 'Usage data on the free plan',
  summary: 'Using HQ for free includes sharing usage data with us.',
  collected: ['usage counts'],
  neverCollected: ['file contents'],
  offSwitch: 'Add a card to your company and collection becomes a setting you can turn off.',
  upgradePath: "Add a card or upgrade your company in HQ under your company's Billing page.",
};

type Plan = 'free' | 'paid';
let plan: Plan = 'free';
let noticeStatus = 'required';
let consent: { enabled: boolean; unset: boolean } | 'fail' = { enabled: false, unset: false };

function stubInvoke() {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'get_telemetry_notice':
        return {
          status: noticeStatus,
          hasCard: plan === 'paid',
          disclosure: noticeStatus === 'acked' ? null : DISCLOSURE,
        };
      case 'get_telemetry_consent_status':
        if (consent === 'fail') throw new Error('offline');
        return consent;
      case 'post_telemetry_disclosure_ack':
        noticeStatus = 'acked';
        return { ackAt: '2026-10-23T00:00:00Z', version: DISCLOSURE.version };
      case 'post_telemetry_opt_in':
        consent = { enabled: Boolean(args?.enabled), unset: false };
        return undefined;
      case 'get_machine_identity_status':
        return { available: false, active: false };
      default:
        return undefined;
    }
  });
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let onfinish: ReturnType<typeof vi.fn>;

async function flush() {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}
async function flushUntil(predicate: () => boolean, label: string) {
  for (let i = 0; i < 40; i += 1) {
    await flush();
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function settle() {
  await flush();
  await new Promise((r) => setTimeout(r, 30));
  await flush();
}
const byId = <T extends HTMLElement = HTMLButtonElement>(id: string) =>
  host.querySelector<T>(`[data-testid="${id}"]`);
const calls = (command: string) => invoke.mock.calls.filter((c) => c[0] === command);

async function mountLaunchCard(freePlanOptedOut: boolean) {
  onfinish = vi.fn();
  component = mount(OnboardingWizard, {
    target: host,
    props: { initialStep: CONSENT_STEP, onfinish, mode: 'reprompt', repromptPersonUid: PERSON, freePlanOptedOut },
  });
  await flush();
}

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error test shim
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  }
});

beforeEach(() => {
  __resetWizardRouterCompletionForTests();
  invoke.mockReset();
  plan = 'free';
  noticeStatus = 'required';
  consent = { enabled: false, unset: false };
  localStorage.clear();
  stubInvoke();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) {
    void unmount(component);
    component = null;
  }
});

describe('free-plan card: shown once to an opted-out free user', () => {
  it('applies to a free company whose person opted out, and not again once shown', async () => {
    const state = await readFreePlanTelemetry(null, invoke);
    expect(state).toMatchObject({ freePlan: true, previouslyOptedOut: true });
    expect(shouldShowRequiredCard(state)).toBe(true);

    expect(markRequiredCardShown(DISCLOSURE.version)).toBe(true);
    expect(requiredCardAlreadyShown(DISCLOSURE.version)).toBe(true);
    expect(shouldShowRequiredCard(await readFreePlanTelemetry(null, invoke))).toBe(false);
  });

  it('the card says the account is sending usage data and offers only Continue and Upgrade', async () => {
    await mountLaunchCard(true);
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the card');
    const screen = byId<HTMLElement>('onboarding-consent')!;
    expect(byId('disclosure-opted-out')!.textContent).toContain(
      'Free companies require usage data, so this account is sending it now.',
    );
    expect(byId('disclosure-add-card')!.textContent).toBe('Upgrade to turn it off');
    expect(byId('consent-continue')).toBeNull();
    const radios = [...screen.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.every((r) => r.closest('[hidden]') !== null)).toBe(true);
  });

  it('first-run disclosure without a prior opt-out keeps its original wording', async () => {
    await mountLaunchCard(false);
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
    expect(byId('disclosure-opted-out')).toBeNull();
    expect(byId('disclosure-add-card')!.textContent).toBe('Add a card instead');
  });
});

describe('free-plan card: no re-prompt loop', () => {
  it('Continue acknowledges, records sharing, marks the re-prompt shown, and finishes', async () => {
    await mountLaunchCard(true);
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the card');
    byId('disclosure-continue')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'finish');

    expect(calls('post_telemetry_disclosure_ack')).toHaveLength(1);
    expect(calls('post_telemetry_opt_in').at(-1)![1]).toMatchObject({ enabled: true });
    expect(calls('mark_consent_reprompt_shown').at(-1)![1]).toMatchObject({ personUid: PERSON });
  });

  it('an acknowledged notice never re-arms the card, even if the local guard is lost', async () => {
    noticeStatus = 'acked';
    localStorage.clear();
    expect(shouldShowRequiredCard(await readFreePlanTelemetry(null, invoke))).toBe(false);
  });

  it('after answering, the person is no longer opted out, so the card cannot return', async () => {
    await mountLaunchCard(true);
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the card');
    byId('disclosure-continue')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'finish');
    localStorage.clear();
    const state = await readFreePlanTelemetry(null, invoke);
    expect(state.previouslyOptedOut).toBe(false);
    expect(shouldShowRequiredCard(state)).toBe(false);
  });

  it('a guard that does not persist keeps the card off (App defers it, never shows unguarded)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/App.svelte'), 'utf8').replace(/\s+/g, ' ');
    const guard = src.indexOf('if (!markRequiredCardShown(freePlan.notice.disclosure.version)) {');
    const arm = src.indexOf('consentReprompt = { personUid: status.personUid, freePlanOptedOut: true };');
    expect(guard).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(guard);
    // The card replaces the stale-consent re-prompt for that launch: one prompt, not two.
    const staleArm = src.indexOf('if (status.shouldReprompt && status.personUid) {');
    expect(staleArm).toBeGreaterThan(arm);
    expect(src.slice(arm, staleArm)).toContain('return;');
  });

  it('a failed consent read never shows the card', async () => {
    consent = 'fail';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(shouldShowRequiredCard(await readFreePlanTelemetry(null, invoke))).toBe(false);
    warn.mockRestore();
  });
});

describe('free-plan card: paid users keep the choice', () => {
  it('a paid company never gets the card', async () => {
    plan = 'paid';
    const state = await readFreePlanTelemetry(null, invoke);
    expect(state.freePlan).toBe(false);
    expect(shouldShowRequiredCard(state)).toBe(false);
  });

  it('a paid person can still opt out on the consent screen', async () => {
    plan = 'paid';
    await mountLaunchCard(false);
    await settle();
    expect(byId('disclosure-continue')).toBeNull();
    const radios = [...byId<HTMLElement>('onboarding-consent')!.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.length).toBe(2);
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    byId('consent-continue')!.click();
    await settle();
    expect(calls('post_telemetry_opt_in').at(-1)![1]).toMatchObject({ enabled: false });
  });
});
