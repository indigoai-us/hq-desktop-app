// @vitest-environment happy-dom
//
// US-014 (free-user-required-telemetry): no opt-in wording for no-card people.
//
// Once the free-plan disclosure applies (no card on file, notice pending or
// required), every usage-data line the wizard shows must describe that state.
// The old opt-in wording ("share anonymous usage data", "your usage data
// choice", the re-prompt "Not now") belongs to card holders only. These tests
// mount the real OnboardingWizard, wait for the disclosure, and check the
// consent screen, the re-prompt variant, the ready screen, and the offline and
// server failure notes. Card-holder wording is checked to stay as it was.

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

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => ({ ok: true, status: 200 })),
}));

// The held-answer path only runs while the install is still going, which a
// mounted test cannot reach. When `deferFailure` is set, the wizard is told to
// hold the answer and the hold comes back already failed, so the deferred
// failure note renders with the real wizard state around it.
const deferred = vi.hoisted(() => ({ failure: null as null | 'offline' | 'server' }));
vi.mock('../../src/lib/deferred-consent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/deferred-consent')>();
  return {
    ...actual,
    shouldDeferConsent: (input: { consentOnly: boolean; installPending: boolean }) =>
      deferred.failure ? !input.consentOnly : actual.shouldDeferConsent(input),
    holdConsentAnswer: async (enabled: boolean) =>
      deferred.failure
        ? { phase: 'failed', enabled, kind: deferred.failure, message: 'raw-deferred-detail' }
        : actual.holdConsentAnswer(enabled),
  };
});

import { flushSync, mount, tick, unmount } from 'svelte';
import OnboardingWizard from '../../src/components/onboarding/OnboardingWizard.svelte';
import { __resetWizardRouterCompletionForTests, WIZARD_STEPS } from '../../src/lib/onboarding-wizard';

const READY_STEP = WIZARD_STEPS.find((s) => s.id === 'ready')!.index;
const CONSENT_STEP = WIZARD_STEPS.find((s) => s.id === 'consent')!.index;

// The locked disclosure text, version 2026-10-22.
const DISCLOSURE = {
  version: '2026-10-22',
  title: 'Usage data on the free plan',
  summary:
    'Using HQ for free includes sharing usage data with us. It helps us see what people use and fix what breaks. Adding a card to your company turns this into a setting you can switch off.',
  collected: [
    'usage counts',
    'skill and command names',
    'timings',
    'model names',
    'company and person ids',
    'app version and operating system',
  ],
  neverCollected: ['file contents', 'secrets', 'prompts and outputs', 'vault data'],
  offSwitch: 'Add a card to your company and collection becomes a setting you can turn off.',
  upgradePath:
    "Add a card or upgrade your company in HQ at https://hq.computer under your company's Billing page.",
};

const OLD_OPT_IN = /share anonymous usage data/i;
const ANONYMOUS = /anonymous/i;
const OLD_CHOICE = /usage data choice/i;

type NoticeState = 'pending' | 'required' | 'card';

let noticeState: NoticeState = 'pending';
let ackError: string | null = null;

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
        return { available: false, active: false };
      case 'get_telemetry_notice':
        return {
          status: noticeState === 'pending' ? 'notice-pending' : 'required',
          seenAt: null,
          requiredFrom: null,
          ackAt: null,
          hasCard: noticeState === 'card',
          disclosure: DISCLOSURE,
        };
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

async function mountAt(initialStep: number, mode?: 'consent' | 'reprompt') {
  component = mount(OnboardingWizard, {
    target: host,
    props: { initialStep, onfinish: vi.fn(), ...(mode ? { mode } : {}) },
  });
  await flush();
}

const byId = <T extends HTMLElement = HTMLButtonElement>(id: string) =>
  host.querySelector<T>(`[data-testid="${id}"]`);

/** Text a person can see: skips anything inside a hidden ancestor. */
function visibleText(root: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node instanceof HTMLElement && node.hidden) return;
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    node.childNodes.forEach(walk);
  };
  walk(root);
  return parts.join(' ');
}

function expectNoOptInWording() {
  const text = visibleText(host);
  expect(text).not.toMatch(OLD_OPT_IN);
  expect(text).not.toMatch(ANONYMOUS);
  expect(text).not.toMatch(OLD_CHOICE);
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
  noticeState = 'pending';
  ackError = null;
  deferred.failure = null;
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

describe('US-014 consent screen with no card', () => {
  for (const mode of ['consent', 'reprompt'] as const) {
    for (const state of ['pending', 'required'] as const) {
      it(`${mode} run, notice ${state}: shows the disclosure and no opt-in wording`, async () => {
        noticeState = state;
        await mountAt(CONSENT_STEP, mode);
        await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
        const text = visibleText(host);
        expect(text).toContain(DISCLOSURE.title);
        for (const line of [...DISCLOSURE.collected, ...DISCLOSURE.neverCollected]) {
          expect(text).toContain(line);
        }
        expectNoOptInWording();
        // The re-prompt "Not now" belongs to the opt-in model.
        expect(byId('consent-dismiss')).toBeNull();
      });
    }
  }

  for (const [kind, raw] of [
    ['server', 'HTTP 500 raw-server-detail'],
    ['offline', 'network error: ECONNREFUSED raw-offline-detail'],
  ] as const) {
    it(`the ${kind} failure note after Continue uses disclosure wording`, async () => {
      ackError = raw;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await mountAt(CONSENT_STEP, 'reprompt');
      await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
      byId('disclosure-continue')!.click();
      await flushUntil(() => Boolean(byId('consent-error')), 'the failure note');
      const note = byId<HTMLElement>('consent-error')!.textContent ?? '';
      expect(note).toContain(kind === 'offline' ? "couldn't confirm this yet" : "couldn't confirm this with the server");
      expect(note).not.toMatch(/your choice/i);
      expectNoOptInWording();
      expect(host.textContent).not.toContain('raw-');
      warn.mockRestore();
    });
  }
});

describe('US-014 ready screen with no card', () => {
  it('shows the disclosure in place of the share checkbox and no opt-in wording', async () => {
    await mountAt(READY_STEP);
    await flushUntil(() => Boolean(byId('ready-disclosure')), 'the disclosure');
    expect(byId('ready-consent-share')).toBeNull();
    expectNoOptInWording();
  });

  for (const kind of ['offline', 'server'] as const) {
    it(`the deferred ${kind} failure note uses disclosure wording`, async () => {
      deferred.failure = kind;
      await mountAt(READY_STEP);
      await flushUntil(() => Boolean(byId('disclosure-continue')), 'the disclosure');
      byId('disclosure-continue')!.click();
      await flushUntil(() => Boolean(byId('consent-deferred-error')), 'the deferred failure note');
      const note = byId<HTMLElement>('consent-deferred-error')!.textContent ?? '';
      expect(note).toContain(
        kind === 'offline'
          ? "HQ couldn't finish saving this yet"
          : "HQ couldn't finish saving this with the server just now",
      );
      expect(byId('consent-deferred-retry')).not.toBeNull();
      expectNoOptInWording();
      expect(host.textContent).not.toContain('raw-deferred-detail');
    });
  }
});

describe('US-014 card-holder wording stays', () => {
  it('a company with a card keeps the share checkbox wording on the ready screen', async () => {
    noticeState = 'card';
    await mountAt(READY_STEP);
    await settle();
    expect(byId('ready-disclosure')).toBeNull();
    expect(visibleText(host)).toMatch(OLD_OPT_IN);
  });

  it('a company with a card keeps the deferred failure wording', async () => {
    noticeState = 'card';
    deferred.failure = 'offline';
    await mountAt(READY_STEP);
    await settle();
    const share = byId<HTMLInputElement>('ready-consent-share');
    expect(share).not.toBeNull();
    byId('onboarding-open-desktop')!.click();
    await flushUntil(() => Boolean(byId('consent-deferred-error')), 'the deferred failure note');
    expect(byId<HTMLElement>('consent-deferred-error')!.textContent).toMatch(OLD_CHOICE);
  });
});

describe('US-014 source regressions', () => {
  const wizardSource = readFileSync(
    resolve(process.cwd(), 'src/components/onboarding/OnboardingWizard.svelte'),
    'utf8',
  );

  it('writes the disclosure-state deferred failure copy without long dashes, prices, or "anonymous"', () => {
    const start = wizardSource.indexOf('data-testid="consent-deferred-error"');
    const end = wizardSource.indexOf('{:else if deferredConsent.kind', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const copy = wizardSource.slice(start, end);
    expect(copy).toContain('{#if disclosureShown}');
    expect(copy).not.toMatch(/[–—]/);
    expect(copy).not.toMatch(/\$\s?\d/);
    expect(copy).not.toMatch(ANONYMOUS);
  });
});
