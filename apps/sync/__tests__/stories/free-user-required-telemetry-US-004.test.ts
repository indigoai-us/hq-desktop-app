// @vitest-environment happy-dom
//
// US-004 (free-user-required-telemetry): the free-plan usage data disclosure.
//
// When the wizard reaches the usage-data question (the consent screen in
// consent-only runs, the ready screen in a first run) it reads the notice from
// the server. A company with no card on file whose notice is pending or
// required sees the server's disclosure in place of the share/decline choice,
// with exactly two ways forward: Continue (acknowledged by the server before
// anything moves on) and "Add a card instead". A card on file, a failed read,
// or an outpost session keeps today's choice. These tests mount the real
// OnboardingWizard and drive it through the DOM.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const listen = vi.hoisted(() =>
  vi.fn(async () => () => {
    /* unlisten */
  }),
);
vi.mock('@tauri-apps/api/event', () => ({ listen }));

const openExternal = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openExternal }));
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => ({ ok: true, status: 200 })),
}));

import { flushSync, mount, tick, unmount } from 'svelte';
import OnboardingWizard from '../../src/components/onboarding/OnboardingWizard.svelte';
import { __resetWizardRouterCompletionForTests, WIZARD_STEPS } from '../../src/lib/onboarding-wizard';
import { TELEMETRY_CONSENT_VERSION } from '../../src/lib/consent-version';
import { HQ_CONSOLE_BASE } from '@hq/ui/hq-console';

const READY_STEP = WIZARD_STEPS.find((s) => s.id === 'ready')!.index;
const CONSENT_STEP = WIZARD_STEPS.find((s) => s.id === 'consent')!.index;

const DISCLOSURE = {
  version: 'free-required-2026-10',
  title: 'Usage data is part of the free plan',
  summary: 'On the free plan, HQ shares anonymous usage data so we can keep the plan free.',
  collected: ['Which skills and commands you run', 'Model names and token counts'],
  neverCollected: ['Your prompts or replies', 'The contents of your files'],
  offSwitch: 'You can turn this off any time by adding a card to your company.',
  upgradePath: 'Add a card to your company to make sharing optional.',
};

type NoticeState = 'pending' | 'required' | 'card' | 'not-applicable' | 'fail';

const RAW_SERVER_ERROR = 'HTTP 500 internal: stack trace at handler.ts:42 req_id=raw-abc123';
const RAW_OFFLINE_ERROR = 'network error: ECONNREFUSED 127.0.0.1:443 raw-xyz789';

let noticeState: NoticeState = 'pending';
let ackError: string | null = null;
let outpost = false;
/** When set, the notice read waits for this before answering. */
let noticeGate: Promise<void> | null = null;

function noticeFor(state: NoticeState) {
  if (state === 'fail') throw new Error('unknown command get_telemetry_notice');
  const status =
    state === 'pending' ? 'notice-pending' : state === 'required' ? 'required' : state === 'card' ? 'required' : 'not-applicable';
  return {
    status,
    seenAt: null,
    requiredFrom: null,
    ackAt: null,
    hasCard: state === 'card',
    disclosure: state === 'not-applicable' ? null : DISCLOSURE,
  };
}

function stubInvoke() {
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/test/hq';
      case 'detect_ai_tools':
        return { any: true, claude_cli: false, claude_desktop: true, codex_desktop: true };
      case 'ensure_person_entity':
        return true;
      case 'get_machine_identity_status':
        return { available: outpost, active: outpost };
      case 'get_telemetry_notice':
        if (noticeGate) await noticeGate;
        return noticeFor(noticeState);
      case 'post_telemetry_disclosure_ack':
        if (ackError) throw new Error(ackError);
        return { ackAt: '2026-10-23T00:00:00Z', version: DISCLOSURE.version };
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

async function flushUntil(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

async function mountAt(initialStep: number, mode?: 'consent') {
  onfinish = vi.fn();
  component = mount(OnboardingWizard, {
    target: host,
    props: { initialStep, onfinish, ...(mode ? { mode } : {}) },
  });
  await flush();
}

const byId = <T extends HTMLElement = HTMLButtonElement>(id: string) =>
  host.querySelector<T>(`[data-testid="${id}"]`);

function calls(command: string) {
  return invoke.mock.calls.filter((c) => c[0] === command);
}

function visible(el: HTMLElement | null): boolean {
  if (!el) return false;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hidden) return false;
  }
  return true;
}

function expectDisclosureCopy(scope: HTMLElement) {
  const text = scope.textContent ?? '';
  expect(text).toContain(DISCLOSURE.title);
  expect(text).toContain(DISCLOSURE.summary);
  for (const line of [...DISCLOSURE.collected, ...DISCLOSURE.neverCollected]) {
    expect(text).toContain(line);
  }
  expect(text).toContain(DISCLOSURE.offSwitch);
  expect(text).toContain(DISCLOSURE.upgradePath);
  const collected = scope.querySelector('[data-testid="disclosure-collected"]');
  const never = scope.querySelector('[data-testid="disclosure-never-collected"]');
  expect(collected?.querySelectorAll('li')).toHaveLength(DISCLOSURE.collected.length);
  expect(never?.querySelectorAll('li')).toHaveLength(DISCLOSURE.neverCollected.length);
}

beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error test shim
    window.matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  }
});

beforeEach(() => {
  __resetWizardRouterCompletionForTests();
  invoke.mockReset();
  listen.mockClear();
  openExternal.mockClear();
  noticeState = 'pending';
  ackError = null;
  outpost = false;
  noticeGate = null;
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

describe('US-004 consent screen (consent-only run)', () => {
  for (const state of ['pending', 'required'] as const) {
    it(`shows the server disclosure in place of the choice when the notice is ${state} and there is no card`, async () => {
      noticeState = state;
      await mountAt(CONSENT_STEP, 'consent');
      await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
      const screen = byId<HTMLElement>('onboarding-consent')!;
      expectDisclosureCopy(screen);
      // The share/decline radios are hidden; only Continue and Add a card remain.
      const radios = [...screen.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      expect(radios.every((r) => !visible(r))).toBe(true);
      expect(byId('consent-continue')).toBeNull();
      expect(byId('disclosure-add-card')!.textContent).toContain('Add a card instead');
      expect(calls('get_telemetry_notice')).toHaveLength(1);
    });
  }

  it('keeps the share/decline choice when the company has a card', async () => {
    noticeState = 'card';
    await mountAt(CONSENT_STEP, 'consent');
    await settle();
    expect(calls('get_telemetry_notice')).toHaveLength(1);
    expect(byId('disclosure-continue')).toBeNull();
    expect(byId('consent-continue')).not.toBeNull();
    const screen = byId<HTMLElement>('onboarding-consent')!;
    expect(screen.textContent).not.toContain(DISCLOSURE.title);
    const radios = [...screen.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.length).toBeGreaterThan(0);
    expect(radios.every((r) => visible(r))).toBe(true);
  });

  it('falls back to the choice and logs when the notice read fails', async () => {
    noticeState = 'fail';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountAt(CONSENT_STEP, 'consent');
    await settle();
    expect(byId('disclosure-continue')).toBeNull();
    expect(byId('consent-continue')).not.toBeNull();
    expect(byId('consent-continue')!.disabled).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('get_telemetry_notice failed'))).toBe(true);
    warn.mockRestore();
  });

  it('Continue records the acknowledgement, then an explicit yes, then finishes', async () => {
    await mountAt(CONSENT_STEP, 'consent');
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
    byId('disclosure-continue')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');

    expect(calls('post_telemetry_disclosure_ack')).toHaveLength(1);
    expect(calls('post_telemetry_opt_in')).toHaveLength(1);
    expect(calls('post_telemetry_opt_in')[0][1]).toMatchObject({
      enabled: true,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
    const order = invoke.mock.calls.map((c) => String(c[0]));
    expect(order.indexOf('post_telemetry_disclosure_ack')).toBeLessThan(order.indexOf('post_telemetry_opt_in'));
  });

  it('a Continue click before the notice arrives waits for it and shows the disclosure instead of sending the choice', async () => {
    let release!: () => void;
    noticeGate = new Promise<void>((r) => (release = r));
    await mountAt(CONSENT_STEP, 'consent');
    await flushUntil(() => calls('get_telemetry_notice').length === 1, 'the notice read');
    byId('consent-continue')!.click();
    await settle();
    expect(calls('post_telemetry_opt_in')).toHaveLength(0);
    release();
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
    await settle();
    expect(calls('post_telemetry_opt_in')).toHaveLength(0);
    expect(onfinish).not.toHaveBeenCalled();
  });

  it('a server failure on Continue shows Retry, does not move on, and never shows raw error text', async () => {
    ackError = RAW_SERVER_ERROR;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountAt(CONSENT_STEP, 'consent');
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
    byId('disclosure-continue')!.click();
    await flushUntil(() => Boolean(byId('consent-error')), 'the failure note');

    expect(onfinish).not.toHaveBeenCalled();
    expect(calls('post_telemetry_opt_in')).toHaveLength(0);
    expect(byId('consent-retry')).not.toBeNull();
    expect(byId('consent-finish-offline')).toBeNull();
    expect(host.textContent).not.toContain('raw-abc123');
    expect(host.textContent).not.toContain('HTTP 500');

    // Retry succeeds once the server answers.
    ackError = null;
    byId('consent-retry')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish after retry');
    expect(calls('post_telemetry_disclosure_ack')).toHaveLength(2);
    expect(calls('post_telemetry_opt_in')).toHaveLength(1);
    warn.mockRestore();
  });

  it('an offline failure offers the usual finish-anyway without raw error text', async () => {
    ackError = RAW_OFFLINE_ERROR;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountAt(CONSENT_STEP, 'consent');
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
    byId('disclosure-continue')!.click();
    await flushUntil(() => Boolean(byId('consent-finish-offline')), 'the offline finish');
    expect(onfinish).not.toHaveBeenCalled();
    expect(byId('consent-error')!.textContent).toContain('offline');
    expect(host.textContent).not.toContain('raw-xyz789');
    expect(host.textContent).not.toContain('ECONNREFUSED');
    warn.mockRestore();
  });

  it('Add a card opens card setup, and coming back with a card swaps to the choice', async () => {
    await mountAt(CONSENT_STEP, 'consent');
    await flushUntil(() => Boolean(byId('disclosure-add-card')), 'the disclosure');
    byId('disclosure-add-card')!.click();
    await flushUntil(() => openExternal.mock.calls.length === 1, 'card setup to open');
    // A consent-only run has no company picked in this window, so card
    // setup opens in the console.
    expect(openExternal.mock.calls[0][0]).toBe(HQ_CONSOLE_BASE);
    await flushUntil(() => Boolean(byId('disclosure-card-hint')), 'the card hint');
    expect(byId('disclosure-card-hint')!.textContent).toContain('checks again when you come back');

    noticeState = 'card';
    window.dispatchEvent(new Event('focus'));
    await flushUntil(() => Boolean(byId('consent-continue')), 'the choice to return');
    expect(calls('get_telemetry_notice')).toHaveLength(2);
    expect(byId('disclosure-continue')).toBeNull();
    expect(calls('post_telemetry_disclosure_ack')).toHaveLength(0);
  });

  it('coming back without a card keeps the disclosure', async () => {
    await mountAt(CONSENT_STEP, 'consent');
    await flushUntil(() => Boolean(byId('disclosure-add-card')), 'the disclosure');
    byId('disclosure-add-card')!.click();
    await flushUntil(() => openExternal.mock.calls.length === 1, 'card setup to open');
    await settle();
    window.dispatchEvent(new Event('focus'));
    await flushUntil(() => calls('get_telemetry_notice').length === 2, 'the second read');
    await settle();
    expect(byId('disclosure-continue')).not.toBeNull();
    expect(byId('consent-continue')).toBeNull();
  });
});

describe('US-004 ready screen (first run)', () => {
  it('replaces the usage-data checkbox with the disclosure and holds Finish until Continue is confirmed', async () => {
    await mountAt(READY_STEP);
    await flushUntil(() => Boolean(byId('ready-disclosure')), 'the disclosure');
    expectDisclosureCopy(byId<HTMLElement>('ready-disclosure')!);
    expect(byId('ready-consent-share')).toBeNull();
    expect(byId('onboarding-open-desktop')!.disabled).toBe(true);

    byId('disclosure-continue')!.click();
    await flushUntil(() => Boolean(byId('disclosure-confirmed')), 'the confirmation');
    expect(calls('post_telemetry_disclosure_ack')).toHaveLength(1);
    expect(calls('post_telemetry_opt_in')).toHaveLength(1);
    expect(calls('post_telemetry_opt_in')[0][1]).toMatchObject({ enabled: true, surface: 'onboarding' });
    expect(byId('onboarding-open-desktop')!.disabled).toBe(false);
    expect(onfinish).not.toHaveBeenCalled();

    byId('onboarding-open-desktop')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    // The answer was already recorded on Continue; finishing does not post twice.
    expect(calls('post_telemetry_opt_in')).toHaveLength(1);
  });

  it('a Finish click before the notice arrives waits for it and does not finish when the disclosure applies', async () => {
    let release!: () => void;
    noticeGate = new Promise<void>((r) => (release = r));
    await mountAt(READY_STEP);
    await flushUntil(() => calls('get_telemetry_notice').length === 1, 'the notice read');
    byId('onboarding-open-desktop')!.click();
    await settle();
    expect(onfinish).not.toHaveBeenCalled();
    release();
    await flushUntil(() => Boolean(byId('ready-disclosure')), 'the disclosure');
    await settle();
    expect(onfinish).not.toHaveBeenCalled();
    expect(calls('post_telemetry_opt_in')).toHaveLength(0);
    expect(byId('onboarding-open-desktop')!.disabled).toBe(true);
  });

  it('keeps Finish disabled when the acknowledgement fails', async () => {
    ackError = RAW_SERVER_ERROR;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountAt(READY_STEP);
    await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
    byId('disclosure-continue')!.click();
    await flushUntil(() => Boolean(byId('consent-error')), 'the failure note');
    expect(byId('onboarding-open-desktop')!.disabled).toBe(true);
    expect(calls('post_telemetry_opt_in')).toHaveLength(0);
    expect(host.textContent).not.toContain('raw-abc123');
    warn.mockRestore();
  });

  it('keeps today’s checkbox when the company has a card', async () => {
    noticeState = 'card';
    await mountAt(READY_STEP);
    await settle();
    expect(calls('get_telemetry_notice')).toHaveLength(1);
    expect(byId('ready-disclosure')).toBeNull();
    expect(byId('ready-consent-share')).not.toBeNull();
    expect(byId('onboarding-open-desktop')!.disabled).toBe(false);
  });

  it('keeps today’s checkbox and never blocks when the notice read fails', async () => {
    noticeState = 'fail';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountAt(READY_STEP);
    await settle();
    expect(byId('ready-disclosure')).toBeNull();
    expect(byId('ready-consent-share')).not.toBeNull();
    expect(byId('onboarding-open-desktop')!.disabled).toBe(false);
    warn.mockRestore();
  });

  it('keeps today’s checkbox when the server says the notice does not apply', async () => {
    noticeState = 'not-applicable';
    await mountAt(READY_STEP);
    await settle();
    expect(byId('ready-disclosure')).toBeNull();
    expect(byId('ready-consent-share')).not.toBeNull();
  });

  it('leaves an outpost session unchanged: no notice read and no usage-data line', async () => {
    outpost = true;
    await mountAt(READY_STEP);
    await settle();
    expect(calls('get_telemetry_notice')).toHaveLength(0);
    expect(byId('ready-consent')).toBeNull();
    expect(byId('ready-disclosure')).toBeNull();
  });
});

describe('US-004 source regressions', () => {
  const wizardSource = readFileSync(
    resolve(process.cwd(), 'src/components/onboarding/OnboardingWizard.svelte'),
    'utf8',
  );

  it('adds no new step to the wizard', () => {
    expect(WIZARD_STEPS.slice(0, 9).map((s) => s.id)).toEqual([
      'welcome-signin',
      'directory',
      'setup',
      'company',
      'first-folder-sync',
      'invite-teammate',
      'consent',
      'connector-import',
      'ready',
    ]);
  });

  it('writes the disclosure UI copy without prices or long dashes', () => {
    const start = wizardSource.indexOf('{#snippet disclosureDetails');
    const end = wizardSource.indexOf('{/snippet}', wizardSource.indexOf('{#snippet consentFailureCopy'));
    expect(start).toBeGreaterThan(-1);
    const copy = wizardSource.slice(start, end);
    expect(copy).not.toMatch(/[–—]/);
    expect(copy).not.toMatch(/\$\s?\d/);
  });
});
