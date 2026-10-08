// @vitest-environment happy-dom
//
// US-001 — The usage-data consent question, answered and recorded honestly.
//
// Product decision (2026-09-27): in first-run onboarding the question is no
// longer a screen of its own. It is one quiet checkbox line on the final
// (ready) screen, "Share anonymous usage data", checked by default, with a
// "What's collected" link. The answer is recorded when the person finishes
// from that screen, whichever way they finish (Open HQ Desktop, or opening HQ
// in Claude Code or Codex), with the same payload as before: surface
// "onboarding" and the consent version. Nothing is posted before they finish,
// and a decline is recorded as enabled:false with nothing withheld.
//
// The consent-only runs (the US-005 re-prompt, an installed machine missing
// its answer) keep their own blocking consent screen; the full disclosure is
// asserted there. These tests mount the real OnboardingWizard and drive it
// through the DOM.

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
const syncAppSource = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let onfinish: ReturnType<typeof vi.fn>;

const READY_STEP = WIZARD_STEPS.find((s) => s.id === 'ready')!.index;
const CONSENT_STEP = WIZARD_STEPS.find((s) => s.id === 'consent')!.index;

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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Default invoke stub: resolve the handful of onMount commands the wizard fires. */
function stubInvoke() {
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/test/hq';
      case 'detect_ai_tools':
        return { any: true, claude_cli: false, claude_desktop: true, codex_desktop: true };
      case 'ensure_person_entity':
        return true;
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

function readyScreen(): HTMLElement {
  const ready = byId<HTMLElement>('onboarding-summary');
  if (!ready) throw new Error('ready screen not found');
  return ready;
}

function shareBox(): HTMLInputElement {
  const box = byId<HTMLInputElement>('ready-consent-share');
  if (!box) throw new Error('usage data checkbox not found');
  return box;
}

function commands(): string[] {
  return invoke.mock.calls.map((c) => String(c[0]));
}

function optInPosts() {
  return invoke.mock.calls.filter((c) => c[0] === 'post_telemetry_opt_in');
}

async function decline() {
  const box = shareBox();
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
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
  it('keeps company, first-folder, invite, consent and connector import between setup and ready in the step model', () => {
    // The step model is unchanged underneath: the consent-only runs still use
    // the consent step, and step telemetry keeps its ids.
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
    expect(CONSENT_STEP).toBe(6);
    expect(WIZARD_STEPS.find((s) => s.id === 'connector-import')?.index).toBe(7);
    expect(READY_STEP).toBe(8);
  });

  it('gates the consent step until the question is answered', () => {
    const base = { installPath: '/tmp/hq' };
    expect(getStepValidity(CONSENT_STEP, { ...base, consentAnswered: false })).toBe(false);
    expect(getStepValidity(CONSENT_STEP, { ...base, consentAnswered: true })).toBe(true);
  });
});

describe('US-001 the question on the ready screen', () => {
  it('has no consent screen in first-run onboarding: the consent step lands on ready', async () => {
    await mountAt(CONSENT_STEP);
    expect(byId('onboarding-consent')).toBeNull();
    expect(readyScreen().classList.contains('on')).toBe(true);
    expect(shareBox()).not.toBeNull();
  });

  it('is one checkbox line, checked (Share) by default, and focuses nothing (AC 1)', async () => {
    await mountAt(READY_STEP);
    const line = byId<HTMLElement>('ready-consent')!;
    expect(line.textContent).toContain('Share anonymous usage data');
    const shareLine = [...line.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Share anonymous usage data'),
    );
    expect(shareLine).toBeDefined();
    expect(shareLine!.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(line.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(shareBox().checked).toBe(true);
    expect(shareBox().disabled).toBe(false);

    const active = document.activeElement;
    expect(active === null || active === document.body).toBe(true);
    expect(line.contains(active)).toBe(false);
  });

  it('keeps every finish action enabled whichever way the box is set (AC 2)', async () => {
    await mountAt(READY_STEP);
    await flushUntil(() => Boolean(byId('onboarding-launch-claude')), 'the tool options');
    expect(byId('onboarding-open-desktop')!.disabled).toBe(false);
    await decline();
    expect(shareBox().checked).toBe(false);
    expect(byId('onboarding-open-desktop')!.disabled).toBe(false);
    expect(byId('onboarding-launch-claude')!.disabled).toBe(false);
    expect(byId('onboarding-launch-codex')!.disabled).toBe(false);
  });

  it('links to what is collected via the system browser (AC 4)', async () => {
    await mountAt(READY_STEP);
    const link = byId<HTMLElement>('ready-consent')!.querySelector<HTMLButtonElement>('.consent-link');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('What’s collected');
    link!.click();
    await flush();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0][0]).toBe('https://hq.computer/privacy');
  });

  it('the consent-only screen still states plainly what IS and is NOT collected (AC 3)', async () => {
    await mountAt(CONSENT_STEP, 'consent');
    const text = byId<HTMLElement>('onboarding-consent')!.textContent ?? '';
    for (const collected of ['skills', 'model', 'token', 'session', 'repositor', 'branch', 'MCP']) {
      expect(text).toContain(collected);
    }
    for (const notCollected of ['prompt', 'file', 'tool']) {
      expect(text).toContain(notCollected);
    }
    expect(text.toLowerCase()).toContain('never collect');
  });

  it('does not render a telemetry checkbox on the sign-in panel (regression)', async () => {
    await mountAt(0);
    const signin = host.querySelector<HTMLElement>('[data-testid="onboarding-signin"]');
    expect(signin).not.toBeNull();
    const checkboxes = signin!.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(0);
    // The provider buttons render once the welcome animation reveals the
    // sign-in block; Escape finishes the animation.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushUntil(
      () => (signin!.textContent ?? '').includes('Continue with Google'),
      'the provider buttons',
    );
    expect(signin!.textContent).toContain('Continue with Google');
  });
});

describe('US-001 recording the answer when the person finishes', () => {
  it('posts nothing before the person finishes, even after changing the box', async () => {
    await mountAt(READY_STEP);
    await decline();
    const box = shareBox();
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(commands()).not.toContain('post_telemetry_opt_in');
    expect(commands()).not.toContain('write_menubar_telemetry_pref');
    expect(onfinish).not.toHaveBeenCalled();
  });

  it('records share with surface=onboarding and the consent version, then finishes (AC 6)', async () => {
    await mountAt(READY_STEP);
    byId('onboarding-open-desktop')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');

    expect(optInPosts()).toHaveLength(1);
    expect(optInPosts()[0][1]).toMatchObject({
      enabled: true,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
    const cache = invoke.mock.calls.find((c) => c[0] === 'write_menubar_telemetry_pref');
    expect(cache?.[1]).toMatchObject({ enabled: true, surface: 'onboarding' });
    // The answer is recorded before the window is handed off.
    const order = commands();
    expect(order.indexOf('ensure_person_entity')).toBeLessThan(order.indexOf('post_telemetry_opt_in'));
    // The box locks on the recorded answer.
    expect(shareBox().disabled).toBe(true);
  });

  it('records a decline as enabled:false and finishes with nothing withheld (AC 5)', async () => {
    await mountAt(READY_STEP);
    await decline();
    byId('onboarding-open-desktop')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');

    expect(optInPosts()).toHaveLength(1);
    expect(optInPosts()[0][1]).toMatchObject({
      enabled: false,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
    expect(readyScreen().textContent).toContain('HQ is ready');
  });

  it('records the answer when the person finishes by opening Codex instead', async () => {
    await mountAt(READY_STEP);
    await flushUntil(() => Boolean(byId('onboarding-launch-codex')), 'the Codex option');
    await decline();
    byId('onboarding-launch-codex')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');

    expect(commands()).toContain('launch_codex_desktop');
    expect(optInPosts()).toHaveLength(1);
    expect(optInPosts()[0][1]).toMatchObject({ enabled: false, surface: 'onboarding' });
  });

  it('emits operational setup telemetry while declining and no skill telemetry (AC 5)', async () => {
    // A decline must not block the operational onboarding trace, but it must
    // not reach the consent-gated skill telemetry command.
    await mountAt(READY_STEP);
    await decline();
    byId('onboarding-open-desktop')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');

    const operationalEmits = invoke.mock.calls.filter(
      (c) => c[0] === 'emit_desktop_operational_telemetry',
    );
    const skillEmits = invoke.mock.calls.filter(
      (c) => c[0] === 'emit_desktop_telemetry_if_opted_in',
    );
    expect(operationalEmits.length).toBeGreaterThanOrEqual(1);
    expect(skillEmits).toHaveLength(0);
  });
});

describe('US-001 source regressions', () => {
  it('no longer posts opt-in from the sign-in handler', () => {
    // The fire-and-forget postOptIn moved out of handleSignIn; the sign-in
    // success path must not touch telemetry.
    const signInBlock = wizardSource.slice(
      wizardSource.indexOf('if (result.authenticated)'),
      wizardSource.indexOf('\n  function detectLooksLikeHq'),
    );
    expect(signInBlock).not.toContain('postOptIn');
    expect(signInBlock).not.toContain('emitDesktopTelemetry');
  });

  it('keeps the tri-state choice, starting on Share', () => {
    expect(wizardSource).not.toContain('telemetryEnabled');
    expect(wizardSource).toContain(
      "let telemetryChoice = $state<'share' | 'decline' | null>('share');",
    );
  });
});
