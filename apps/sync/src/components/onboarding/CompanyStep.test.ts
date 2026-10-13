// @vitest-environment happy-dom
/**
 * The first-run company step on its own (design review, 2026-10-12): name the
 * company, "Setting up <name>", the plan, then its own "Invite your team"
 * screen and the "<name> is ready." moment. Invites go out only once the
 * company is ready, through the pending-invite queue, with each address's
 * outcome on show.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, tick, unmount } from 'svelte';
import CompanyStep from './CompanyStep.svelte';
import type { InvokeFn } from '../../lib/first-run-company';
import { PENDING_COMPANY_INVITES_KEY } from '../../lib/pending-company-invites';

const createCompanyCard = {
  v: 1,
  type: 'lifecycle_card',
  kind: 'create_company',
  cardId: 'card_create_company',
  state: 'open',
  title: 'Name your company',
  summary: null,
  fields: [
    { id: 'name', label: 'Company name', control: 'text', required: true, value: '' },
    { id: 'slug', label: 'Company handle', control: 'text', required: true, value: '' },
    { id: 'website', label: 'Website', control: 'text', required: false, value: '' },
  ],
  actions: [{ id: 'submit', label: 'Create company', style: 'primary' }],
  viewer: { canAct: true },
};

interface Scenario {
  /** team:invite for this address is refused with the returned message (null sends it). */
  inviteError?: (email: string) => string | null;
  /** GET /entity/cmp_new answers ready this many times, then "provisioning" (invites wait). */
  readyReads?: number;
  /** GET /entity/cmp_new waits for this before answering (holds "Setting up…"). */
  entityGate?: Promise<void>;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
type InvokeMock = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
let invoke: Mock<InvokeMock>;
let listeners: Map<string, (payload: unknown) => void>;

function stubInvoke(scenario: Scenario = {}): void {
  let readyReads = 0;
  invoke = vi.fn<InvokeMock>(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'fetch_channel':
        return {
          channelId: 'setup',
          messages: [
            {
              eventId: 'evt_card',
              createdAt: new Date().toISOString(),
              messageKind: 'system',
              systemEvent: createCompanyCard,
            },
          ],
        };
      case 'run_card_action':
        if (args?.cardId === 'companies_summary') throw new Error('[not_found] Request failed (status 404)');
        return { state: 'done', companyUid: 'cmp_new', companyChannelId: 'ch_new' };
      case 'check_company_slug':
        return { valid: true, available: true, normalized: args?.slug, suggestion: null, reasons: [] };
      case 'activate_company_cloud':
        return { activated: true };
      case 'run_company_tab_action': {
        const email = String((args?.values as { email?: string } | undefined)?.email ?? '');
        const refusal = scenario.inviteError?.(email);
        if (refusal) throw new Error(refusal);
        return { state: 'done' };
      }
      case 'hq_pro_fetch': {
        if (args?.url === '/entity/cmp_new') {
          if (scenario.entityGate) await scenario.entityGate;
          readyReads += 1;
          const ready = scenario.readyReads === undefined || readyReads <= scenario.readyReads;
          return {
            status: 200,
            body: JSON.stringify({
              entity: { uid: 'cmp_new', status: ready ? 'active' : 'provisioning', bucketName: ready ? 'hq-vault' : '' },
            }),
          };
        }
        if (args?.url === '/v1/billing/checkout/team') {
          return { status: 200, body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test' }) };
        }
        return { status: 503, body: '{}' };
      }
      default:
        return undefined;
    }
  });
}

type CompanyStepExports = { back: () => boolean };

function stepBack(): boolean {
  return (component as unknown as CompanyStepExports).back();
}

function mountStep(props: Record<string, unknown> = {}) {
  const oncomplete = vi.fn();
  const onTelemetry = vi.fn();
  const onbackchange = vi.fn();
  const openUrl = vi.fn(async () => {});
  component = mount(CompanyStep, {
    target: host,
    props: {
      path: { kind: 'create', decision: 'create' },
      invoke: invoke as unknown as InvokeFn,
      openUrl,
      listen: async (event: string, handler: (payload: unknown) => void) => {
        listeners.set(event, handler);
        return () => listeners.delete(event);
      },
      onTelemetry,
      oncomplete,
      onbackchange,
      ...props,
    },
  });
  return { oncomplete, onTelemetry, onbackchange, openUrl };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
  flushSync();
}

async function flushUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await flush();
    if (predicate()) return;
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(400);
  await flush();
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const textOf = (id: string) => byId(id)?.textContent?.trim();
const phase = () => byId('onboarding-company')?.getAttribute('data-phase');
const heading = () => host.querySelector('[data-scene-heading]')?.textContent?.trim();

function click(id: string): void {
  const button = byId<HTMLButtonElement>(id);
  if (!button) throw new Error(`Expected ${id} to render.`);
  if (button.disabled) throw new Error(`${id} is disabled.`);
  button.click();
}

function typeInto(id: string, value: string): void {
  const input = byId<HTMLInputElement>(id);
  if (!input) throw new Error(`Expected ${id} to render.`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function inviteInput(): HTMLInputElement {
  return byId<HTMLInputElement>('onboarding-company-invite-input')!;
}

async function press(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  inviteInput().dispatchEvent(event);
  await flush();
  return event;
}

async function addInvite(text: string, key = 'Enter'): Promise<void> {
  typeInto('onboarding-company-invite-input', text);
  await flush();
  await press(key);
}

function chips(): Array<[string | undefined, string | null]> {
  return [...host.querySelectorAll('[data-testid="onboarding-company-invite-row"]')].map((row) => [
    row.querySelector('.cs-chip-email')?.textContent?.trim(),
    row.getAttribute('data-status'),
  ]);
}

function telemetry(onTelemetry: ReturnType<typeof vi.fn>, action: string): Array<Record<string, unknown>> {
  return onTelemetry.mock.calls.map(([event]) => event).filter((event) => event.action === action);
}

/** Name the company "Acme" and create it; resolves on the plan screen. */
async function createAcme(): Promise<void> {
  await flushUntil(() => Boolean(byId('onboarding-company-field-name')), 'the company form');
  typeInto('onboarding-company-field-name', 'Acme');
  await settle();
  click('onboarding-company-create');
  await flushUntil(() => Boolean(byId('onboarding-plan-choose-starter')), 'the plan screen');
}

/** Create "Acme", start on Starter, and land on the invite screen. */
async function reachInvites(): Promise<void> {
  await createAcme();
  click('onboarding-plan-choose-starter');
  await flushUntil(() => phase() === 'invite', 'the invite screen');
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  listeners = new Map();
  localStorage.removeItem(PENDING_COMPANY_INVITES_KEY);
  stubReducedMotion(false);
  stubInvoke();
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host.remove();
  localStorage.removeItem(PENDING_COMPANY_INVITES_KEY);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CompanyStep: Back from its first question', () => {
  it('may leave on the form, and has no Back while the company is set up or on the plans', async () => {
    let release!: () => void;
    stubInvoke({ entityGate: new Promise<void>((resolve) => (release = resolve)) });
    const { onbackchange } = mountStep();
    await flushUntil(() => Boolean(byId('onboarding-company-field-name')), 'the company form');
    expect(onbackchange).toHaveBeenLastCalledWith(true);
    // On its first question, Back leaves the step: the step itself does not move.
    expect(stepBack()).toBe(false);
    expect(phase()).toBe('details');

    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => phase() === 'provisioning', 'setting up');
    expect(onbackchange).toHaveBeenLastCalledWith(false);
    expect(stepBack()).toBe(false);
    expect(phase()).toBe('provisioning');

    release();
    await flushUntil(() => Boolean(byId('onboarding-plan-choose-starter')), 'the plan screen');
    // The company exists: no way back to "Name your company" from the plans.
    expect(onbackchange).toHaveBeenLastCalledWith(false);
    expect(stepBack()).toBe(false);
    expect(phase()).toBe('plan');
  });

  it('has no Back when provisioning failed', async () => {
    const answer = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'hq_pro_fetch' && args?.url === '/entity/cmp_new') {
        return {
          status: 200,
          body: JSON.stringify({ entity: { uid: 'cmp_new', provisioningStatus: 'failed', provisioningFailedStep: 'kms-create' } }),
        };
      }
      return answer(command, args);
    });
    const { onbackchange } = mountStep();
    await flushUntil(() => Boolean(byId('onboarding-company-field-name')), 'the company form');
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => phase() === 'provision-failed', 'the failure');
    expect(onbackchange).toHaveBeenLastCalledWith(false);
    expect(stepBack()).toBe(false);
    expect(phase()).toBe('provision-failed');
  });

  it.each([
    [
      'join',
      {
        kind: 'join',
        decision: 'join_invite',
        invites: [{ slug: 'acme', name: 'Acme', companyUid: 'cmp_acme', inviter: null }],
        signedInEmail: null,
      },
      'onboarding-company-join',
    ],
    [
      'existing',
      {
        kind: 'existing',
        decision: 'offer_existing',
        company: {
          companyUid: 'cmp_mine',
          name: 'Mine',
          slug: 'mine',
          role: 'owner',
          paid: false,
          bucketName: 'b',
          provisioning: null,
          provisioningFailedStep: null,
        },
        companies: [],
      },
      'onboarding-company-use-existing',
    ],
    [
      'other-identity',
      {
        kind: 'other-identity',
        decision: 'company_other_account',
        other: { maskedEmail: 'c•••@acme.com', companyName: 'Acme' },
        signedInEmail: 'me@example.com',
      },
      'onboarding-company-switch-account',
    ],
  ])('may leave from the %s question', async (_name, path, testId) => {
    const { onbackchange } = mountStep({ path });
    await flushUntil(() => Boolean(byId(testId)), testId);
    expect(onbackchange).toHaveBeenLastCalledWith(true);
  });
});

describe('CompanyStep: Back inside the step', () => {
  it('goes back from "<name> is ready." to the invites, keeping the chips, and from the invites to the plans', async () => {
    const { onbackchange, oncomplete } = mountStep();
    await reachInvites();
    // The plan was picked on this screen: Back may return to it.
    expect(onbackchange).toHaveBeenLastCalledWith(true);
    await addInvite('pat@acme.com');
    await addInvite('sam@acme.com');
    click('onboarding-company-invite-skip');
    await flushUntil(() => phase() === 'done', 'the ready moment');
    expect(onbackchange).toHaveBeenLastCalledWith(true);

    expect(stepBack()).toBe(true);
    await flush();
    expect(phase()).toBe('invite');
    expect(chips()).toEqual([
      ['pat@acme.com', 'new'],
      ['sam@acme.com', 'new'],
    ]);
    expect(textOf('onboarding-company-invite-send')).toBe('Send 2 invites');
    expect(onbackchange).toHaveBeenLastCalledWith(true);

    expect(stepBack()).toBe(true);
    await flush();
    expect(phase()).toBe('plan');
    expect(byId('onboarding-plan-choose-starter')).not.toBeNull();
    expect(onbackchange).toHaveBeenLastCalledWith(false);
    // The plan screen has no Back of its own.
    expect(stepBack()).toBe(false);
    expect(phase()).toBe('plan');
    // Nothing was sent or finished by going back.
    expect(invoke.mock.calls.some(([command]) => command === 'run_company_tab_action')).toBe(false);
    expect(oncomplete).not.toHaveBeenCalled();
  });

  it('keeps sent invites as sent when coming back from "<name> is ready."', async () => {
    const { onbackchange } = mountStep();
    await reachInvites();
    await addInvite('pat@acme.com');
    click('onboarding-company-invite-send');
    await flushUntil(() => chips()[0]?.[1] === 'sent', 'the invite going out');
    await vi.advanceTimersByTimeAsync(900);
    await flushUntil(() => phase() === 'done', 'the ready moment');
    expect(stepBack()).toBe(true);
    await flush();
    expect(phase()).toBe('invite');
    expect(chips()).toEqual([['pat@acme.com', 'sent']]);
    expect(textOf('onboarding-company-invite-continue')).toBe('Continue');
    expect(onbackchange).toHaveBeenLastCalledWith(true);
    // Coming back is not a reason to move on again by itself.
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(phase()).toBe('invite');
  });

  it('has no Back on the invites while they are being sent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const answer = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'run_company_tab_action') await gate;
      return answer(command, args);
    });
    const { onbackchange } = mountStep();
    await reachInvites();
    await addInvite('pat@acme.com');
    click('onboarding-company-invite-send');
    await flushUntil(() => chips()[0]?.[1] === 'sending', 'the sending state');
    expect(onbackchange).toHaveBeenLastCalledWith(false);
    expect(stepBack()).toBe(false);
    expect(phase()).toBe('invite');
    release();
    await flushUntil(() => chips()[0]?.[1] === 'sent', 'the invite going out');
    expect(onbackchange).toHaveBeenLastCalledWith(true);
  });

  it('has no Back on the invites when the plan was picked on the website', async () => {
    const { onbackchange } = mountStep({ priorPlan: 'starter' });
    await flushUntil(() => Boolean(byId('onboarding-company-field-name')), 'the company form');
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => phase() === 'invite', 'the invite screen');
    expect(onbackchange).toHaveBeenLastCalledWith(false);
    expect(stepBack()).toBe(false);
    expect(phase()).toBe('invite');
    // Its ready moment still goes back to the invites.
    click('onboarding-company-invite-skip');
    await flushUntil(() => phase() === 'done', 'the ready moment');
    expect(onbackchange).toHaveBeenLastCalledWith(true);
    expect(stepBack()).toBe(true);
    await flush();
    expect(phase()).toBe('invite');
    expect(onbackchange).toHaveBeenLastCalledWith(false);
  });

  it('has no Back on the invites after Workforce checkout was paid', async () => {
    const { onbackchange } = mountStep();
    await createAcme();
    click('onboarding-plan-choose-workforce');
    await flushUntil(() => Boolean(byId('onboarding-checkout-done')), 'the checkout screen');
    // No Back on the checkout screen either.
    expect(onbackchange).toHaveBeenLastCalledWith(false);
    expect(stepBack()).toBe(false);
    listeners.get('messages:open-setup')?.({ companyUid: 'cmp_new', checkout: 'done' });
    await flushUntil(() => phase() === 'invite', 'the invite screen');
    expect(onbackchange).toHaveBeenLastCalledWith(false);
    expect(stepBack()).toBe(false);
    expect(phase()).toBe('invite');
  });

  it('keeps Back to the plans after "Start on Starter for now"', async () => {
    const { onbackchange } = mountStep();
    await createAcme();
    click('onboarding-plan-choose-workforce');
    await flushUntil(() => Boolean(byId('onboarding-checkout-starter')), 'the checkout screen');
    click('onboarding-checkout-starter');
    await flushUntil(() => phase() === 'invite', 'the invite screen');
    expect(onbackchange).toHaveBeenLastCalledWith(true);
    expect(stepBack()).toBe(true);
    await flush();
    expect(phase()).toBe('plan');
  });
});

describe('CompanyStep: name, set up, plan', () => {
  it('asks for a name and a website only, and counts the company created once it is ready', async () => {
    const { onTelemetry } = mountStep();
    await flushUntil(() => Boolean(byId('onboarding-company-field-name')), 'the company form');
    expect(heading()).toBe('Name your company');
    expect(byId('onboarding-company-invites')).toBeNull();
    expect(byId('onboarding-company-field-slug')).toBeNull();
    expect(host.querySelector('form.cs-form')?.hasAttribute('novalidate')).toBe(true);
    expect(byId('onboarding-company-actions')?.classList.contains('cs-actions')).toBe(true);

    await createAcme();
    // Nothing invited at create time.
    expect(invoke.mock.calls.some(([command]) => command === 'run_company_tab_action')).toBe(false);
    expect(telemetry(onTelemetry, 'company_created')).toEqual([
      {
        action: 'company_created',
        companyUid: 'cmp_new',
        inviteCount: 0,
        inviteFailureCount: 0,
        inviteQueuedCount: 0,
        namePrefill: expect.any(String),
      },
    ]);
    // Emitted at provisioning-ready, before any plan is chosen.
    const actions = onTelemetry.mock.calls.map(([event]) => event.action);
    expect(actions.indexOf('company_created')).toBeGreaterThan(actions.indexOf('provisioning_ready'));
    expect(actions).not.toContain('plan_chosen');
  });

  it('goes from a plan picked on the website straight to the invites', async () => {
    const { onTelemetry } = mountStep({ priorPlan: 'starter' });
    await flushUntil(() => Boolean(byId('onboarding-company-field-name')), 'the company form');
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => phase() === 'invite', 'the invite screen');
    expect(byId('onboarding-plan-choose-starter')).toBeNull();
    expect(telemetry(onTelemetry, 'plan_chosen')).toEqual([{ action: 'plan_chosen', companyUid: 'cmp_new', plan: 'starter' }]);
  });

  it.each([
    ['the checkout return', 'return', true],
    ['"I finished checkout"', 'onboarding-checkout-done', false],
    ['"Start on Starter for now"', 'onboarding-checkout-starter', false],
  ])('goes on to the invites after Workforce checkout, from %s', async (_label, how, paid) => {
    const { oncomplete } = mountStep();
    await createAcme();
    click('onboarding-plan-choose-workforce');
    await flushUntil(() => Boolean(byId('onboarding-checkout-done')), 'the checkout screen');
    if (how === 'return') listeners.get('messages:open-setup')?.({ companyUid: 'cmp_new', checkout: 'done' });
    else click(how);
    await flushUntil(() => phase() === 'invite', 'the invite screen');
    expect(oncomplete).not.toHaveBeenCalled();

    click('onboarding-company-invite-skip');
    await flushUntil(() => phase() === 'done', 'the ready moment');
    click('onboarding-company-ready-continue');
    const plan = how === 'onboarding-checkout-starter' ? 'starter' : 'workforce';
    expect(oncomplete).toHaveBeenCalledWith({ outcome: 'created', companyUid: 'cmp_new', plan: paid ? 'workforce' : plan, paid });
  });

  it('never shows the internal step name when provisioning fails', async () => {
    stubInvoke();
    const failing = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'hq_pro_fetch' && args?.url === '/entity/cmp_new') {
        return {
          status: 200,
          body: JSON.stringify({ entity: { uid: 'cmp_new', provisioningStatus: 'failed', provisioningFailedStep: 'kms-create' } }),
        };
      }
      return failing(command, args);
    });
    const { onTelemetry } = mountStep();
    await flushUntil(() => Boolean(byId('onboarding-company-field-name')), 'the company form');
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(byId('onboarding-company-provisioning-failed')), 'the failure');
    expect(heading()).toBe('Setup didn’t finish');
    expect(textOf('onboarding-company-provisioning-failed')).toBe(
      'Acme is saved, but setting it up did not finish. Try again, or skip and finish it later in HQ Desktop.',
    );
    expect(host.textContent).not.toContain('kms-create');
    expect(telemetry(onTelemetry, 'provisioning_failed')[0]).toMatchObject({ step: 'kms-create' });
  });
});

describe('CompanyStep: Invite your team', () => {
  it('turns a typed address into a chip on Enter, comma, space and Tab', async () => {
    mountStep();
    await reachInvites();
    expect(heading()).toBe('Invite your team');
    expect(textOf('onboarding-company-invite-skip')).toBe('Skip for now');

    for (const [index, key] of ['Enter', ',', ' ', 'Tab'].entries()) {
      typeInto('onboarding-company-invite-input', `p${index}@acme.com`);
      await flush();
      const event = await press(key);
      expect(event.defaultPrevented, key).toBe(true);
      expect(inviteInput().value, key).toBe('');
    }
    expect(chips()).toEqual([
      ['p0@acme.com', 'new'],
      ['p1@acme.com', 'new'],
      ['p2@acme.com', 'new'],
      ['p3@acme.com', 'new'],
    ]);
    expect(textOf('onboarding-company-invite-send')).toBe('Send 4 invites');
  });

  it('commits an address on blur and a pasted list on paste, without duplicates', async () => {
    mountStep();
    await reachInvites();
    typeInto('onboarding-company-invite-input', 'pat@acme.com');
    inviteInput().dispatchEvent(new FocusEvent('blur'));
    await flush();
    expect(chips()).toEqual([['pat@acme.com', 'new']]);

    typeInto('onboarding-company-invite-input', 'sam@acme.com, PAT@acme.com lee@acme.com');
    inviteInput().dispatchEvent(new Event('paste', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(chips()).toEqual([
      ['pat@acme.com', 'new'],
      ['sam@acme.com', 'new'],
      ['lee@acme.com', 'new'],
    ]);
    expect(inviteInput().value).toBe('');
  });

  it('keeps text that is not an address in the field, with a hint', async () => {
    mountStep();
    await reachInvites();
    await addInvite('not-an-email');
    expect(chips()).toEqual([]);
    expect(inviteInput().value).toBe('not-an-email');
    expect(inviteInput().getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector('#onboarding-company-invite-hint')?.textContent?.trim()).toBe(
      '“not-an-email” is not an email address.',
    );
    // Send does nothing with it.
    click('onboarding-company-invite-send');
    await flush();
    expect(invoke.mock.calls.some(([command]) => command === 'run_company_tab_action')).toBe(false);
  });

  it('sends through the pending-invite queue, marks each address sent, and moves on after a beat', async () => {
    const { onTelemetry, oncomplete } = mountStep();
    await reachInvites();
    await addInvite('pat@acme.com');
    expect(textOf('onboarding-company-invite-send')).toBe('Send invite');
    await addInvite('sam@acme.com');
    expect(textOf('onboarding-company-invite-send')).toBe('Send 2 invites');

    click('onboarding-company-invite-send');
    await flushUntil(() => chips().every(([, status]) => status === 'sent'), 'the invites going out');
    expect(
      invoke.mock.calls
        .filter(([command]) => command === 'run_company_tab_action')
        .map(([, args]) => (args as { companyUid: string; values: Record<string, string> }))
        .map(({ companyUid, values }) => [companyUid, values.email, values.role]),
    ).toEqual([
      ['cmp_new', 'pat@acme.com', 'member'],
      ['cmp_new', 'sam@acme.com', 'member'],
    ]);
    // The queue is drained once they went out.
    expect(localStorage.getItem(PENDING_COMPANY_INVITES_KEY)).toBeNull();
    expect(telemetry(onTelemetry, 'invites_sent')).toEqual([
      { action: 'invites_sent', companyUid: 'cmp_new', inviteCount: 2, inviteFailureCount: 0, inviteQueuedCount: 0 },
    ]);
    expect(host.querySelector('#onboarding-company-invite-hint')?.textContent?.trim()).toBe('2 invites sent.');
    // Everything delivered and nothing new: Continue instead of Send.
    expect(byId('onboarding-company-invite-send')).toBeNull();
    expect(textOf('onboarding-company-invite-continue')).toBe('Continue');

    await vi.advanceTimersByTimeAsync(850);
    await flush();
    expect(phase()).toBe('invite');
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(phase()).toBe('done');
    expect(textOf('onboarding-company-ready')).toBe('Acme is ready.');
    expect(host.querySelector('.cs-summary')?.textContent).toContain('2 teammates invited');
    expect(oncomplete).not.toHaveBeenCalled();
    click('onboarding-company-ready-continue');
    expect(oncomplete).toHaveBeenCalledWith({ outcome: 'created', companyUid: 'cmp_new', plan: 'starter', paid: false });
  });

  it('moves on at once under Reduce Motion', async () => {
    stubReducedMotion(true);
    mountStep();
    await reachInvites();
    await addInvite('pat@acme.com');
    click('onboarding-company-invite-send');
    await flushUntil(() => chips()[0]?.[1] === 'sent', 'the invite going out');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(phase()).toBe('done');
  });

  it('says "Sending…" while the invites go out', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'run_company_tab_action') await gate;
      return sending(command, args);
    });
    mountStep();
    await reachInvites();
    await addInvite('pat@acme.com');
    click('onboarding-company-invite-send');
    await flushUntil(() => chips()[0]?.[1] === 'sending', 'the sending state');
    expect(textOf('onboarding-company-invite-send')).toBe('Sending…');
    expect(byId<HTMLButtonElement>('onboarding-company-invite-send')?.disabled).toBe(true);
    expect(byId<HTMLButtonElement>('onboarding-company-invite-skip')?.disabled).toBe(true);
    release();
    await flushUntil(() => chips()[0]?.[1] === 'sent', 'the invite going out');
  });

  it('shows a refused address as failed, offers Send again, and stays put', async () => {
    stubInvoke({ inviteError: (email) => (email === 'bad@acme.com' ? 'Refused' : null) });
    const { onTelemetry } = mountStep();
    await reachInvites();
    await addInvite('pat@acme.com');
    await addInvite('bad@acme.com');
    click('onboarding-company-invite-send');
    await flushUntil(() => chips().every(([, status]) => status !== 'sending' && status !== 'new'), 'the outcome');
    expect(chips()).toEqual([
      ['pat@acme.com', 'sent'],
      ['bad@acme.com', 'failed'],
    ]);
    expect(telemetry(onTelemetry, 'invites_sent')).toEqual([
      { action: 'invites_sent', companyUid: 'cmp_new', inviteCount: 2, inviteFailureCount: 1, inviteQueuedCount: 0 },
    ]);
    expect(textOf('onboarding-company-invite-send')).toBe('Send again');
    // One went out, so the ghost button reads Continue.
    expect(textOf('onboarding-company-invite-skip')).toBe('Continue');
    expect(host.querySelector('#onboarding-company-invite-hint')?.textContent).toContain('One invite didn’t go out.');
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(phase()).toBe('invite');
  });

  it('marks invites queued when the company is not reachable as ready yet, and still moves on', async () => {
    // Ready for the provisioning wait, then not ready when the invites flush.
    stubInvoke({ readyReads: 1 });
    const { onTelemetry } = mountStep();
    await reachInvites();
    await addInvite('pat@acme.com');
    click('onboarding-company-invite-send');
    await flushUntil(() => chips()[0]?.[1] === 'queued', 'the queued invite');
    expect(invoke.mock.calls.some(([command]) => command === 'run_company_tab_action')).toBe(false);
    expect(JSON.parse(localStorage.getItem(PENDING_COMPANY_INVITES_KEY) ?? '[]')).toEqual([
      expect.objectContaining({ companyUid: 'cmp_new', invites: [{ email: 'pat@acme.com', role: 'member' }] }),
    ]);
    expect(telemetry(onTelemetry, 'invites_sent')).toEqual([
      { action: 'invites_sent', companyUid: 'cmp_new', inviteCount: 1, inviteFailureCount: 0, inviteQueuedCount: 1 },
    ]);
    expect(host.querySelector('#onboarding-company-invite-hint')?.textContent).toContain('Invites are on their way.');
    await vi.advanceTimersByTimeAsync(900);
    await flush();
    expect(phase()).toBe('done');
    expect(host.querySelector('.cs-summary')?.textContent).toContain('1 teammate invited');
  });

  it('skips the invites with Skip for now, recording it, and finishes on Continue', async () => {
    const { onTelemetry, oncomplete } = mountStep();
    await reachInvites();
    click('onboarding-company-invite-skip');
    await flushUntil(() => phase() === 'done', 'the ready moment');
    expect(telemetry(onTelemetry, 'invites_skipped')).toEqual([{ action: 'invites_skipped', companyUid: 'cmp_new' }]);
    expect(telemetry(onTelemetry, 'invites_sent')).toEqual([]);
    expect(invoke.mock.calls.some(([command]) => command === 'run_company_tab_action')).toBe(false);
    expect(textOf('onboarding-company-ready')).toBe('Acme is ready.');
    expect(host.querySelector('.cs-summary')?.textContent).toContain('Invite people any time from the Team tab');
    expect(oncomplete).not.toHaveBeenCalled();
    click('onboarding-company-ready-continue');
    expect(oncomplete).toHaveBeenCalledTimes(1);
    expect(oncomplete).toHaveBeenCalledWith({ outcome: 'created', companyUid: 'cmp_new', plan: 'starter', paid: false });
  });
});

describe('CompanyStep: leaving copies of a screen', () => {
  // Reported: "Name your company" blinked on arrival, and "Setting up" flashed
  // over "Choose how your HQ runs" on Create company. A screen replaced before
  // it had risen in was copied at full strength for the leave fade.
  let hostOpacity = '1';
  /** Pane parts' on-screen opacity, by the title of their screen. */
  let partOpacity: (title: string) => string = () => '1';

  beforeEach(() => {
    hostOpacity = '1';
    partOpacity = () => '1';
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: () => ({ finished: new Promise(() => {}) }),
    });
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const style = real(el);
      const pane = el.parentElement?.classList.contains('cs-pane') ? el.parentElement : null;
      const title = pane?.querySelector('.cs-title')?.textContent?.trim() ?? '';
      const opacity = el === host ? hostOpacity : pane ? partOpacity(title) : '1';
      return new Proxy(style, {
        get: (target, key) =>
          key === 'opacity'
            ? opacity
            : key === 'animationName'
              ? pane
                ? 'cs-rise'
                : 'none'
              : key === 'transform'
                ? 'none'
                : Reflect.get(target, key),
      });
    });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  const ghosts = () => [...document.querySelectorAll<HTMLElement>('.cs-ghost')];
  const ghostTitles = () => ghosts().map((ghost) => ghost.querySelector('.cs-title')?.textContent?.trim());
  const wait = () => byId('onboarding-company')?.style.getPropertyValue('--cs-wait');

  afterEach(() => {
    for (const ghost of ghosts()) ghost.remove();
  });

  it('leaves no copy of a screen swapped while the step is still fading in', async () => {
    hostOpacity = '0.1';
    mountStep();
    await flushUntil(() => phase() === 'details', 'the company form');
    expect(ghosts()).toHaveLength(0);
    // The form rises on the story screens' own timing.
    expect(wait()).toBe('0ms');
  });

  it('leaves no copy of "Setting up" when the company was ready before it showed', async () => {
    partOpacity = (title) => (title.startsWith('Setting up') ? '0' : title === 'Name your company' ? '0.4' : '1');
    mountStep();
    await flushUntil(() => phase() === 'details', 'the company form');
    for (const ghost of ghosts()) ghost.remove();
    await createAcme();
    expect(ghostTitles()).toEqual(['Name your company']);
    // The copy leaves from where its entrance had got to, not fully shown.
    const copyTitle = ghosts()[0]!.querySelector<HTMLElement>('.cs-title')!;
    expect(copyTitle.style.opacity).toBe('0.4');
    // The plans still wait for the form's copy to fade out.
    expect(Number.parseInt(wait() ?? '', 10)).toBeGreaterThan(0);
  });
});
