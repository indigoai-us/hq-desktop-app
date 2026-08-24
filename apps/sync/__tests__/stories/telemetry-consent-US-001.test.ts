// @vitest-environment happy-dom
//
// US-001 — Blocking consent step with no pre-ticked default.
//
// The onboarding wizard now asks the telemetry question as its own step AFTER
// setup (index 3), with no pre-selected option and continue disabled until the
// person answers. Declining is first-class. The recorded write carries the
// surface and consent version. These tests mount the real OnboardingWizard
// component and drive it through the DOM.

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

import { flushSync, mount, tick, unmount } from 'svelte';
import OnboardingWizard from '../../src/components/onboarding/OnboardingWizard.svelte';
import {
  __resetWizardRouterCompletionForTests,
  WIZARD_STEPS,
  getStepValidity,
} from '../../src/lib/onboarding-wizard';
import { TELEMETRY_CONSENT_VERSION } from '../../src/lib/consent-version';

const wizardSource = readFileSync(
  resolve(process.cwd(), 'src/components/onboarding/OnboardingWizard.svelte'),
  'utf8',
);

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function flush() {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

/** Default invoke stub: resolve the handful of onMount commands the wizard fires. */
function stubInvoke() {
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/test/hq';
      case 'detect_ai_tools':
        return { any: true, claude_cli: true };
      case 'write_menubar_telemetry_pref':
      case 'post_telemetry_opt_in':
      case 'bring_main_window_to_front':
      case 'set_hq_install_path':
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

function consentRadios(): HTMLInputElement[] {
  return Array.from(
    consentPanel().querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  );
}

function consentContinue(): HTMLButtonElement {
  const btn = consentPanel().querySelector<HTMLButtonElement>('button.btn-primary');
  if (!btn) throw new Error('consent continue button not found');
  return btn;
}

beforeAll(() => {
  // happy-dom lacks matchMedia; the wizard reads prefers-reduced-motion.
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

describe('US-001 wizard step model', () => {
  it('inserts consent and connector import after setup before ready', () => {
    expect(WIZARD_STEPS.slice(0, 6).map((s) => s.id)).toEqual([
      'welcome-signin',
      'directory',
      'setup',
      'consent',
      'connector-import',
      'ready',
    ]);
    expect(WIZARD_STEPS.find((s) => s.id === 'consent')?.index).toBe(3);
    expect(WIZARD_STEPS.find((s) => s.id === 'connector-import')?.index).toBe(4);
    expect(WIZARD_STEPS.find((s) => s.id === 'ready')?.index).toBe(5);
  });

  it('gates the consent step until the question is answered', () => {
    const base = { installPath: '/tmp/hq' };
    expect(getStepValidity(3, { ...base, consentAnswered: false })).toBe(false);
    expect(getStepValidity(3, { ...base, consentAnswered: true })).toBe(true);
  });
});

describe('US-001 consent step UI', () => {
  it('pre-selects neither option and autofocuses nothing (AC 1)', async () => {
    await mountAt(3);

    const radios = consentRadios();
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => !r.checked)).toBe(true);

    // Nothing on the consent panel grabs focus on render.
    const active = document.activeElement;
    expect(active === null || active === document.body).toBe(true);
    expect(consentPanel().contains(active)).toBe(false);
  });

  it('keeps continue disabled until an option is chosen, for BOTH options (AC 2)', async () => {
    await mountAt(3);
    expect(consentContinue().disabled).toBe(true);

    // Share enables continue.
    const [share, decline] = consentRadios();
    share.checked = true;
    share.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(consentContinue().disabled).toBe(false);

    // Decline also enables continue (not just "share").
    decline.checked = true;
    decline.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(consentContinue().disabled).toBe(false);
  });

  it('states plainly what IS and is NOT collected (AC 3)', async () => {
    await mountAt(3);
    const text = consentPanel().textContent ?? '';

    for (const collected of [
      'skills',
      'model',
      'token',
      'session',
      'repositor',
      'branch',
      'MCP',
    ]) {
      expect(text).toContain(collected);
    }
    for (const notCollected of ['prompt', 'file', 'tool']) {
      expect(text).toContain(notCollected);
    }
    expect(text.toLowerCase()).toContain('never collect');
  });

  it('links to a fuller description via the system browser (AC 4)', async () => {
    await mountAt(3);
    const link = consentPanel().querySelector<HTMLButtonElement>('.consent-link');
    expect(link).not.toBeNull();
    link!.click();
    await flush();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0][0]).toMatch(/^https?:\/\//);
  });

  it('does not render a telemetry checkbox on the sign-in panel (regression)', async () => {
    await mountAt(0);
    const signin = host.querySelector<HTMLElement>('[data-testid="onboarding-signin"]');
    expect(signin).not.toBeNull();
    const checkboxes = signin!.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(0);
    // Sign-in still offers its provider buttons.
    expect(signin!.textContent).toContain('Log in with Google');
  });
});

describe('US-001 recording the answer', () => {
  it('records share with surface=onboarding and the consent version (AC 6)', async () => {
    await mountAt(3);
    const [share] = consentRadios();
    share.checked = true;
    share.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    consentContinue().click();
    await flush();
    // submitConsent now awaits ensure_person_entity (US-002 AC1) before the
    // POST, so the upload lands a couple of microtasks later than it used to.
    await flush();
    await flush();

    const post = invoke.mock.calls.find((c) => c[0] === 'post_telemetry_opt_in');
    expect(post).toBeDefined();
    expect(post![1]).toMatchObject({
      enabled: true,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
  });

  it('records decline and reaches the ready step with nothing gated (AC 5)', async () => {
    await mountAt(3);
    const [, decline] = consentRadios();
    decline.checked = true;
    decline.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    consentContinue().click();
    await flush();
    // The panel cross-fade defers activating the next panel by FADE_OUT_MS.
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    // The decline is recorded as a real answer with its provenance.
    const post = invoke.mock.calls.find((c) => c[0] === 'post_telemetry_opt_in');
    expect(post![1]).toMatchObject({
      enabled: false,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });

    // Setup completes normally: the ready screen becomes the active panel and
    // still offers its launch action (nothing withheld for declining). There
    // is no separate "Finish" button for anyone, so its absence here is not a
    // capability withheld from someone who declined.
    const ready = host.querySelector<HTMLElement>('[data-testid="onboarding-summary"]');
    expect(ready).not.toBeNull();
    expect(ready!.classList.contains('on')).toBe(true);
    expect(ready!.textContent).toContain('HQ is ready');
    expect(ready!.textContent).toContain('Open in Claude Code');
    // The launcher is present AND enabled — a decline must not disable it.
    const launch = ready!.querySelector<HTMLButtonElement>('.btns .btn-primary');
    expect(launch).not.toBeNull();
    expect(launch!.disabled).toBe(false);
  });

  it('emits no desktop_setup_completed usage event when declining (AC 5)', async () => {
    // A decline must produce zero usage events. The completion event is only
    // emitted for opted-in users, and it flows through post_telemetry_events /
    // the telemetry emit path — never fired here for a decline.
    await mountAt(3);
    const [, decline] = consentRadios();
    decline.checked = true;
    decline.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    consentContinue().click();
    await flush();

    const eventUploads = invoke.mock.calls.filter(
      (c) =>
        c[0] === 'emit_desktop_telemetry_if_opted_in' ||
        c[0] === 'post_telemetry_events',
    );
    expect(eventUploads).toHaveLength(0);
  });
});

describe('US-001 source regressions', () => {
  it('no longer posts opt-in from the sign-in handler', () => {
    // The fire-and-forget postOptIn moved out of handleSignIn into the consent
    // step; the sign-in success path must not touch telemetry.
    const signInBlock = wizardSource.slice(
      wizardSource.indexOf('if (result.authenticated)'),
      wizardSource.indexOf('\n  function detectLooksLikeHq'),
    );
    expect(signInBlock).not.toContain('postOptIn');
    expect(signInBlock).not.toContain('emitDesktopTelemetry');
  });

  it('drops the pre-ticked telemetry boolean for a tri-state choice', () => {
    expect(wizardSource).not.toContain('telemetryEnabled');
    expect(wizardSource).toContain(
      "let telemetryChoice = $state<'share' | 'decline' | null>(null);",
    );
  });
});
