// @vitest-environment happy-dom
//
// US-002 — The consent write cannot silently fail.
//
// US-001 moved consent to its own blocking step (index 3) AFTER setup. US-002
// makes the remote write a FOREGROUND operation whose failure is visible:
//
//   - AC1: the caller's person entity is guaranteed to exist before the POST
//          (the step awaits `ensure_person_entity`), so the write cannot 404.
//   - AC2/AC3: a failed remote write does NOT advance to `ready`; it surfaces a
//          retry affordance instead of being swallowed to the console.
//   - AC4: an offline person can still finish setup — the answer is cached with
//          provenance and reconciled later — without that being reported as a
//          successful server write.
//
// The local cache write still happens FIRST and still happens even when the
// upload fails (the deliberate ordering that makes AC4 work). These tests mount
// the real OnboardingWizard and drive it through the DOM, mirroring the US-001
// story test idiom.

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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function flush() {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

/** Flush several async boundaries — submitConsent awaits ensure_person_entity
 * then postOptIn, so the observable state settles a few microtasks later. */
async function settle() {
  for (let i = 0; i < 6; i += 1) await flush();
}

/**
 * Configurable invoke stub. `postResult` controls how `post_telemetry_opt_in`
 * behaves so a single test can flip it from failure to success across a retry.
 */
let postResult: { mode: 'ok' } | { mode: 'reject'; error: unknown } = { mode: 'ok' };
// When true, the local cache write (write_menubar_telemetry_pref) fails — used
// to prove finding #5: with NO cached answer there is nothing to reconcile, so
// "finish offline" must not be offered.
let cacheWriteFails = false;
let detectedConnectorCount = 0;
const calls: { command: string; args?: Record<string, unknown> }[] = [];

function stubInvoke() {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/test/hq';
      case 'detect_ai_tools':
        return { any: true, claude_cli: true };
      case 'detect_claude_desktop_connectors':
        return {
          present: detectedConnectorCount > 0,
          count: detectedConnectorCount,
          path: '/Users/test/.config/Claude/claude_desktop_config.json',
        };
      case 'ensure_person_entity':
        return true;
      case 'write_menubar_telemetry_pref':
        if (cacheWriteFails) throw new Error('disk full: cache write failed');
        return undefined;
      case 'post_telemetry_opt_in':
        if (postResult.mode === 'reject') throw postResult.error;
        return undefined;
      default:
        return undefined;
    }
  });
}

async function mountAt(initialStep: number) {
  component = mount(OnboardingWizard, {
    target: host,
    props: { initialStep, onfinish: () => {} },
  });
  await flush();
}

function consentPanel(): HTMLElement {
  const panel = host.querySelector<HTMLElement>('[data-testid="onboarding-consent"]');
  if (!panel) throw new Error('consent panel not found');
  return panel;
}

function chooseShare() {
  const radios = Array.from(
    consentPanel().querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  );
  const share = radios[0];
  share.checked = true;
  share.dispatchEvent(new Event('change', { bubbles: true }));
}

function primaryContinue(): HTMLButtonElement {
  const btn = consentPanel().querySelector<HTMLButtonElement>('button.btn-primary');
  if (!btn) throw new Error('consent primary button not found');
  return btn;
}

function readyIsActive(): boolean {
  const ready = host.querySelector<HTMLElement>('[data-testid="onboarding-summary"]');
  return Boolean(ready && ready.classList.contains('on'));
}

function connectorImportIsActive(): boolean {
  const connectorImport = host.querySelector<HTMLElement>(
    '[data-testid="onboarding-connector-import"]',
  );
  return Boolean(connectorImport && connectorImport.classList.contains('on'));
}

function postCalls() {
  return calls.filter((c) => c.command === 'post_telemetry_opt_in');
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
  cacheWriteFails = false;
  detectedConnectorCount = 0;
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

describe('US-002 a failed remote write is visible and blocks advance', () => {
  it('opt-in 500 shows a retry affordance and does NOT advance as successful (e2e)', async () => {
    postResult = { mode: 'reject', error: 'HTTP 500: internal server error' };
    await mountAt(3);
    chooseShare();
    await flush();

    primaryContinue().click();
    await settle();
    // Give the cross-fade timer a chance too, so a false "advance" would show.
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    // Did NOT advance to ready.
    expect(readyIsActive()).toBe(false);
    // A retry affordance is shown.
    const retry = consentPanel().querySelector<HTMLButtonElement>(
      '[data-testid="consent-retry"]',
    );
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toMatch(/retry/i);
    // The error is surfaced to the user, not just logged.
    expect(
      consentPanel().querySelector('[data-testid="consent-error"]'),
    ).not.toBeNull();
  });

  it('retry after a failure re-attempts the upload and, on success, advances', async () => {
    postResult = { mode: 'reject', error: 'HTTP 503: service unavailable' };
    await mountAt(3);
    chooseShare();
    await flush();

    primaryContinue().click();
    await settle();
    expect(readyIsActive()).toBe(false);
    const firstAttempts = postCalls().length;
    expect(firstAttempts).toBeGreaterThanOrEqual(1);

    // The server recovers; the retry re-attempts using the cached answer.
    postResult = { mode: 'ok' };
    const retry = consentPanel().querySelector<HTMLButtonElement>(
      '[data-testid="consent-retry"]',
    )!;
    retry.click();
    await settle();
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    expect(postCalls().length).toBeGreaterThan(firstAttempts);
    expect(readyIsActive()).toBe(true);
  });

  it('surfaces the remote result rather than swallowing it', async () => {
    // On a clean success the step advances (the result said uploaded:true).
    await mountAt(3);
    chooseShare();
    await flush();
    primaryContinue().click();
    await settle();
    await new Promise((r) => setTimeout(r, 400));
    await flush();
    expect(readyIsActive()).toBe(true);
  });
});

describe('US-002 deliberate cache-before-upload ordering (regression)', () => {
  it('caches locally BEFORE the remote POST, even when the POST fails', async () => {
    postResult = { mode: 'reject', error: 'HTTP 500' };
    await mountAt(3);
    chooseShare();
    await flush();
    primaryContinue().click();
    await settle();

    const order = calls
      .map((c) => c.command)
      .filter(
        (c) => c === 'write_menubar_telemetry_pref' || c === 'post_telemetry_opt_in',
      );
    // The local cache write comes first, and still runs despite the failed POST.
    expect(order[0]).toBe('write_menubar_telemetry_pref');
    expect(order).toContain('post_telemetry_opt_in');
  });
});

describe('US-002 AC1 — person entity exists before the POST', () => {
  it('ensures the person entity before firing the consent POST', async () => {
    await mountAt(3);
    chooseShare();
    await flush();
    primaryContinue().click();
    await settle();

    const ensureIdx = calls.findIndex((c) => c.command === 'ensure_person_entity');
    const postIdx = calls.findIndex((c) => c.command === 'post_telemetry_opt_in');
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThanOrEqual(0);
    // The entity is guaranteed before the POST fires.
    expect(ensureIdx).toBeLessThan(postIdx);
  });
});

describe('US-002 AC4 — offline does not trap the user', () => {
  it('offline: the person can finish setup, and it is NOT a successful server write', async () => {
    postResult = {
      mode: 'reject',
      error: 'error sending request: connection refused (offline)',
    };
    // A locally configured connector keeps the optional panel visible instead
    // of auto-skipping to ready, so this proves the offline route itself.
    detectedConnectorCount = 1;
    await mountAt(3);
    chooseShare();
    await flush();

    primaryContinue().click();
    await settle();

    // Not advanced yet, and NOT reported as a successful upload.
    expect(readyIsActive()).toBe(false);
    expect(
      consentPanel().querySelector('[data-testid="consent-error"]'),
    ).not.toBeNull();

    // An honest way forward is offered: finish now, send later.
    const finishOffline = consentPanel().querySelector<HTMLButtonElement>(
      '[data-testid="consent-finish-offline"]',
    );
    expect(finishOffline).not.toBeNull();

    const postsBefore = postCalls().length;
    finishOffline!.click();
    await settle();
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    // The offline path reaches the same connector-import step as an uploaded
    // answer; it must not bypass the locally available import offer.
    expect(connectorImportIsActive()).toBe(true);
    expect(readyIsActive()).toBe(false);
    // …WITHOUT another opt-in POST being claimed as successful — finishing
    // offline does not re-post nor pretend the server confirmed the write. The
    // cached answer is reconciled later by the consent repair.
    expect(postCalls().length).toBe(postsBefore);
  });
});

describe('US-002 finding #5 — no "finish offline" when the cache write also failed', () => {
  it('offers the offline-finish path when the answer WAS cached', async () => {
    // Baseline: upload fails but the local cache succeeded → there IS an answer
    // to reconcile later, so "finish offline" is honest and offered.
    postResult = {
      mode: 'reject',
      error: 'error sending request: connection refused (offline)',
    };
    cacheWriteFails = false;
    await mountAt(3);
    chooseShare();
    await flush();
    primaryContinue().click();
    await settle();

    expect(
      consentPanel().querySelector('[data-testid="consent-finish-offline"]'),
    ).not.toBeNull();
  });

  it('does NOT offer "finish offline" when BOTH the upload and the cache write failed', async () => {
    // Both writes failed: there is no cached answer to reconcile, so completing
    // setup would lose the choice entirely. The UI must force a retry, not offer
    // an offline finish that silently drops the answer.
    postResult = {
      mode: 'reject',
      error: 'error sending request: connection refused (offline)',
    };
    cacheWriteFails = true;
    await mountAt(3);
    chooseShare();
    await flush();
    primaryContinue().click();
    await settle();
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    // Did NOT advance, no offline-finish escape hatch, retry is the only way.
    expect(readyIsActive()).toBe(false);
    expect(
      consentPanel().querySelector('[data-testid="consent-finish-offline"]'),
    ).toBeNull();
    expect(
      consentPanel().querySelector('[data-testid="consent-retry"]'),
    ).not.toBeNull();
  });
});

describe('US-002 provenance travels with the write', () => {
  it('sends surface=onboarding and the consent version', async () => {
    await mountAt(3);
    chooseShare();
    await flush();
    primaryContinue().click();
    await settle();

    const post = postCalls().at(-1);
    expect(post).toBeDefined();
    expect(post!.args).toMatchObject({
      enabled: true,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
  });
});
