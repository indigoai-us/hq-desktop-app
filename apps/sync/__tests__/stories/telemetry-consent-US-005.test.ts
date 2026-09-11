// @vitest-environment happy-dom
//
// US-005 — Re-prompt everyone whose answer is stale or administrative.
//
// A person whose recorded consent is pre-versioned, administratively set, or
// below the current consent version is asked once, properly, on launch. The
// re-prompt reuses the EXACT same blocking, unbiased consent UI as onboarding
// (no pre-selection, no continue until answered) and, on answer, replaces the
// stale record with a fully versioned one via an UNCONDITIONAL write
// (surface=onboarding + the current version, never onlyIfUnset). It is shown at
// most once per consent version per person, and a dismissal marks it shown
// WITHOUT posting any answer.
//
// These tests mount the real OnboardingWizard in `mode="reprompt"` and drive it
// through the DOM, mirroring the US-001/002 story-test idiom. The
// server-authoritative "is a re-prompt due / shown once" decision itself lives
// in Rust (`decide_reprompt` in commands/telemetry.rs) and is unit-tested there
// (it cannot be compiled on this machine — see env-notes.md — but the
// rust-macos CI job runs it as a blocking gate).

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
import { __resetWizardRouterCompletionForTests } from '../../src/lib/onboarding-wizard';
import { TELEMETRY_CONSENT_VERSION } from '../../src/lib/consent-version';

const REPROMPT_PERSON = 'prs_alice';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let finishCount = 0;

async function flush() {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

/** submitConsent awaits ensure_person_entity then postOptIn then the mark; the
 * observable state settles a few microtasks later. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await flush();
}

let postResult: { mode: 'ok' } | { mode: 'reject'; error: unknown } = { mode: 'ok' };
const calls: { command: string; args?: Record<string, unknown> }[] = [];

function stubInvoke() {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/test/hq';
      case 'detect_ai_tools':
        return { any: true, claude_cli: true };
      case 'ensure_person_entity':
        return true;
      case 'write_menubar_telemetry_pref':
      case 'mark_consent_reprompt_shown':
        return undefined;
      case 'post_telemetry_opt_in':
        if (postResult.mode === 'reject') throw postResult.error;
        return undefined;
      default:
        return undefined;
    }
  });
}

async function mountReprompt(personUid: string | null = REPROMPT_PERSON) {
  finishCount = 0;
  component = mount(OnboardingWizard, {
    target: host,
    props: {
      initialStep: 3,
      mode: 'reprompt',
      repromptPersonUid: personUid,
      onfinish: () => {
        finishCount += 1;
      },
    },
  });
  await flush();
}

function consentPanel(): HTMLElement {
  const panel = host.querySelector<HTMLElement>('[data-testid="onboarding-consent"]');
  if (!panel) throw new Error('consent panel not found');
  return panel;
}

function consentRadios(): HTMLInputElement[] {
  return Array.from(
    consentPanel().querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  );
}

function chooseShare() {
  const [share] = consentRadios();
  share.checked = true;
  share.dispatchEvent(new Event('change', { bubbles: true }));
}

function chooseDecline() {
  const [, decline] = consentRadios();
  decline.checked = true;
  decline.dispatchEvent(new Event('change', { bubbles: true }));
}

function continueBtn(): HTMLButtonElement {
  const btn = consentPanel().querySelector<HTMLButtonElement>(
    '[data-testid="consent-continue"]',
  );
  if (!btn) throw new Error('consent continue button not found');
  return btn;
}

function dismissBtn(): HTMLButtonElement | null {
  return consentPanel().querySelector<HTMLButtonElement>('[data-testid="consent-dismiss"]');
}

function postCalls() {
  return calls.filter((c) => c.command === 'post_telemetry_opt_in');
}

function markCalls() {
  return calls.filter((c) => c.command === 'mark_consent_reprompt_shown');
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
  calls.length = 0;
  postResult = { mode: 'ok' };
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

describe('US-005 the re-prompt opens straight on the blocking consent step', () => {
  it('shows the consent step with no other onboarding steps (no setup/ready)', async () => {
    await mountReprompt();

    const consent = host.querySelector<HTMLElement>('[data-testid="onboarding-consent"]');
    expect(consent).not.toBeNull();
    expect(consent!.classList.contains('on')).toBe(true);

    // It is ONLY consent — no install/setup ran (reprompt is not a fresh install).
    const setupCommands = calls.filter(
      (c) =>
        c.command === 'read_install_manifest' ||
        c.command === 'fetch_and_extract_template' ||
        c.command === 'install_hq_core',
    );
    expect(setupCommands).toHaveLength(0);
  });

  // ── AC2: blocking exactly like onboarding ────────────────────────────────
  it('pre-selects neither option and keeps continue disabled until answered (AC2)', async () => {
    await mountReprompt();

    const radios = consentRadios();
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => !r.checked)).toBe(true);
    expect(continueBtn().disabled).toBe(true);

    // Nothing autofocused.
    const active = document.activeElement;
    expect(active === null || active === document.body).toBe(true);

    // Choosing an option enables continue.
    chooseShare();
    await flush();
    expect(continueBtn().disabled).toBe(false);
  });
});

describe('US-005 answering replaces the stale record (AC3, e2e)', () => {
  // e2e: "Given a person with an administratively-set record, when the app
  // launches, then the consent step appears and their answer replaces the
  // administrative record." The replacement is the UNCONDITIONAL versioned
  // write; the administrative source is overwritten server-side by it.
  it('posts an unconditional versioned write with surface=onboarding', async () => {
    await mountReprompt();
    chooseShare();
    await flush();

    continueBtn().click();
    await settle();

    const post = postCalls().at(-1);
    expect(post).toBeDefined();
    expect(post!.args).toMatchObject({
      enabled: true,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
    // A re-prompt DELIBERATELY replaces the stale record — never onlyIfUnset,
    // which would let the stale/administrative record survive.
    expect(post!.args?.onlyIfUnset).toBeUndefined();
  });

  it('records the answer for either option (decline is a first-class answer)', async () => {
    await mountReprompt();
    chooseDecline();
    await flush();

    continueBtn().click();
    await settle();

    const post = postCalls().at(-1);
    expect(post!.args).toMatchObject({
      enabled: false,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
  });

  it('marks the re-prompt shown for this person+version and finishes on answer', async () => {
    await mountReprompt();
    chooseShare();
    await flush();
    continueBtn().click();
    await settle();

    const mark = markCalls().at(-1);
    expect(mark).toBeDefined();
    expect(mark!.args).toMatchObject({
      consentVersion: TELEMETRY_CONSENT_VERSION,
      personUid: REPROMPT_PERSON,
    });
    expect(finishCount).toBe(1);
  });
});

describe('US-005 dismissal is not an answer (AC4)', () => {
  it('offers a "Not now" dismissal on the re-prompt', async () => {
    await mountReprompt();
    expect(dismissBtn()).not.toBeNull();
  });

  it('dismissing marks the prompt shown but posts NO answer', async () => {
    await mountReprompt();

    const dismiss = dismissBtn();
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await settle();

    // The prompt is remembered as shown for this person+version…
    const mark = markCalls().at(-1);
    expect(mark!.args).toMatchObject({
      consentVersion: TELEMETRY_CONSENT_VERSION,
      personUid: REPROMPT_PERSON,
    });
    // …but NOTHING was posted — a dismissal is never an answer, so the record
    // stays stale and collection continues under the previous default.
    expect(postCalls()).toHaveLength(0);
    expect(
      calls.some((c) => c.command === 'write_menubar_telemetry_pref'),
    ).toBe(false);
    expect(finishCount).toBe(1);
  });
});

describe('US-005 a failed write is visible and does not falsely complete', () => {
  it('a server error keeps the prompt up with a retry and does not mark/finish', async () => {
    postResult = { mode: 'reject', error: 'HTTP 500: internal server error' };
    await mountReprompt();
    chooseShare();
    await flush();

    continueBtn().click();
    await settle();

    // Still on the consent step, with a retry affordance surfaced.
    expect(consentPanel().classList.contains('on')).toBe(true);
    expect(
      consentPanel().querySelector('[data-testid="consent-retry"]'),
    ).not.toBeNull();
    // The write did not succeed, so we did NOT finish and did NOT record the
    // answer as shown/answered — the person must be asked again.
    expect(finishCount).toBe(0);
    expect(markCalls()).toHaveLength(0);
  });

  it('retry after recovery posts again and then finishes', async () => {
    postResult = { mode: 'reject', error: 'HTTP 503' };
    await mountReprompt();
    chooseShare();
    await flush();
    continueBtn().click();
    await settle();

    const attemptsBeforeRetry = postCalls().length;
    expect(attemptsBeforeRetry).toBeGreaterThanOrEqual(1);
    expect(finishCount).toBe(0);

    postResult = { mode: 'ok' };
    const retry = consentPanel().querySelector<HTMLButtonElement>(
      '[data-testid="consent-retry"]',
    )!;
    retry.click();
    await settle();

    expect(postCalls().length).toBeGreaterThan(attemptsBeforeRetry);
    expect(finishCount).toBe(1);
    expect(markCalls().length).toBeGreaterThanOrEqual(1);
  });
});

describe('US-005 guard requires a person to key against', () => {
  it('still finishes if no person uid is available, without a bogus mark', async () => {
    // Defensive: App only arms the re-prompt when the server names a person, so
    // this path is not normally reached — but if it were, answering must not
    // write a person-less guard (which could never be matched).
    await mountReprompt(null);
    chooseShare();
    await flush();
    continueBtn().click();
    await settle();

    expect(postCalls().at(-1)!.args).toMatchObject({
      enabled: true,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
    expect(markCalls()).toHaveLength(0);
    expect(finishCount).toBe(1);
  });
});
