// @vitest-environment happy-dom

// The welcome flow: first-run onboarding and the welcome story as one
// five-screen sequence. (Product decision 2026-09-27: the usage-data question
// is a checkbox on the ready screen, not its own screen.) These tests drive the real wizard through the DOM with
// reduced motion on, so every screen lands on its settled frame at once (the
// same path a person with reduced motion gets) and nothing depends on
// animation timing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return () => events.handlers.delete(name);
  }),
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.10.347') }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: tauri.open }));
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })),
}));

import { flushSync, mount, tick, unmount } from 'svelte';

import OnboardingWizard from './OnboardingWizard.svelte';
import { __resetWizardRouterCompletionForTests } from '../../lib/onboarding-wizard';
import { __resetInstallerStepTelemetryForTests } from '../../lib/installer-step-telemetry';

const TOOLS = {
  claude_cli: false,
  claude_desktop: true,
  codex_cli: false,
  codex_desktop: true,
  grok_cli: false,
  claude_last_used_ms: null,
  codex_last_used_ms: null,
  grok_last_used_ms: null,
  any: true,
};

type Handler = (args?: Record<string, unknown>) => unknown;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let calls: { command: string; args?: Record<string, unknown> }[] = [];

/** Default Tauri surface: every setup stage succeeds unless overridden. */
function stubInvoke(overrides: Record<string, Handler> = {}): void {
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    const override = overrides[command];
    if (override) return override(args);
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/placeholder/hq';
      case 'detect_ai_tools':
        return TOOLS;
      case 'detect_claude_desktop_connectors':
        return { present: false, count: 0, outcome: 'none', inspectedSources: 'unknown' };
      case 'ensure_person_entity':
        return true;
      default:
        return undefined;
    }
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

async function flushUntil(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await flush();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function mountAt(initialStep: number, props: Record<string, unknown> = {}) {
  const onfinish = vi.fn();
  component = mount(OnboardingWizard, {
    target: host,
    props: { initialStep, onfinish, ...props },
  });
  return onfinish;
}

const root = () => host.querySelector<HTMLElement>('[data-testid="onboarding-wizard"]')!;
const scene = () => root().dataset.currentScene;
const byId = <T extends HTMLElement = HTMLButtonElement>(id: string) =>
  host.querySelector<T>(`[data-testid="${id}"]`);
const forwardIn = (sceneName: string) =>
  host.querySelector<HTMLButtonElement>(`[data-scene="${sceneName}"] .nav .btn-primary`);
const commands = () => calls.map((c) => c.command);

beforeEach(() => {
  calls = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  // Reduced motion: every screen renders its settled frame immediately.
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  tauri.invoke.mockReset();
  tauri.open.mockReset();
  tauri.open.mockResolvedValue(undefined);
  events.handlers.clear();
  __resetWizardRouterCompletionForTests();
  __resetInstallerStepTelemetryForTests();
  localStorage.clear();
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('welcome flow: scene order and gating', () => {
  it('signs in on the welcome and walks folder, cloud, shortcut, ready', async () => {
    stubInvoke({
      is_first_run: () => true,
      start_oauth_login: () => ({ authorizeUrl: 'https://placeholder.test/authorize', state: 's' }),
      oauth_listen_for_code: () => ({ code: 'c' }),
      oauth_exchange_code: () => ({ authenticated: true }),
    });
    mountAt(0);
    await flushUntil(() => scene() === 'welcome', 'the welcome');

    // Sign-in is the way forward on the welcome; there is no Next.
    expect(forwardIn('welcome')).toBeNull();
    await flushUntil(
      () => Boolean(host.querySelector('[data-testid="onboarding-signin"] .btns .btn-primary')),
      'the provider buttons',
    );
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-signin"] .btns .btn-primary')!.click();
    await flushUntil(() => scene() === 'folder', 'the folder screen');
    expect(commands()).toContain('start_oauth_login');
    expect(commands()).toContain('oauth_exchange_code');

    forwardIn('folder')!.click();
    await flushUntil(() => scene() === 'cloud', 'the cloud screen');
    forwardIn('cloud')!.click();
    await flushUntil(() => scene() === 'shortcut', 'the shortcut screen');
    forwardIn('shortcut')!.click();
    await flushUntil(() => scene() === 'ready', 'the ready screen');
    // No consent screen on the way: the question is on the ready screen.
    expect(byId('onboarding-consent')).toBeNull();
    expect(byId<HTMLInputElement>('ready-consent-share')!.checked).toBe(true);
    await flushUntil(() => commands().includes('record_install_complete'), 'the install');
  });

  it('offers Skip intro only on the two explainers, and it jumps to the ready screen', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    mountAt(2);
    await flushUntil(() => scene() === 'cloud', 'the cloud screen');
    expect(byId('welcome-skip')).not.toBeNull();
    byId('welcome-skip')!.click();
    await flushUntil(() => scene() === 'ready', 'the ready screen');
    expect(byId('welcome-skip')).toBeNull();
  });

  it('keeps Install here disabled until the folder resolves', async () => {
    const path = deferred<string>();
    stubInvoke({ resolve_hq_path: () => path.promise });
    mountAt(1);
    await flush();
    expect(byId('welcome-install-here')!.disabled).toBe(true);
    path.resolve('/Users/placeholder/hq');
    await flushUntil(() => !byId('welcome-install-here')!.disabled, 'the resolved folder');
    expect(host.querySelector('[data-scene="folder"] .lpath')?.textContent).toContain('hq');
  });

  it('moves with the keyboard: right arrow forward, left arrow back', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    mountAt(2);
    await flushUntil(() => scene() === 'cloud', 'the cloud screen');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushUntil(() => scene() === 'shortcut', 'the shortcut screen');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await flushUntil(() => scene() === 'cloud', 'back to the cloud screen');
  });
});

describe('welcome flow: the install runs in the background', () => {
  it('starts the install on Install here and moves straight on to the story', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    mountAt(1);
    await flushUntil(() => !byId('welcome-install-here')!.disabled, 'the resolved folder');
    expect(commands()).toContain('set_hq_install_path');
    expect(commands()).not.toContain('fetch_and_extract_template');

    byId('welcome-install-here')!.click();
    await flushUntil(() => commands().includes('fetch_and_extract_template'), 'the install');
    expect(scene()).toBe('cloud');
    const card = byId<HTMLElement>('onboarding-setup')!;
    expect(card.classList.contains('on')).toBe(true);
    expect(card.textContent).toContain('Installing HQ in the background');
    expect(card.textContent).toContain('Step 1 of 5 · Laying the groundwork');
  });

  it('drives the corner card from the real stage progress, to done', async () => {
    const template = deferred();
    const deps = deferred();
    stubInvoke({
      fetch_and_extract_template: () => template.promise,
      install_deps: () => deps.promise,
    });
    mountAt(2);
    await flushUntil(() => commands().includes('fetch_and_extract_template'), 'the first stage');
    const card = () => byId<HTMLElement>('onboarding-setup')!;
    const percent = () =>
      Number(byId<HTMLElement>('onboarding-setup-progress')!.getAttribute('aria-valuenow'));
    expect(card().dataset.state).toBe('running');
    const before = percent();

    template.resolve();
    await flushUntil(() => commands().includes('install_deps'), 'the second stage');
    expect(percent()).toBeGreaterThan(before);
    expect(card().textContent).toMatch(/Step \d of 5 · /);

    deps.resolve();
    await flushUntil(() => card().dataset.state === 'done', 'the finished install');
    expect(card().textContent).toContain('HQ is installed');
    expect(card().textContent).toContain('Keep going, you’re all set.');
    expect(percent()).toBe(100);
  });

  it('shows a stage waiting on its automatic retry, then carries on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let attempts = 0;
    const second = deferred();
    stubInvoke({
      fetch_and_extract_template: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network timeout while fetching the template');
        return second.promise;
      },
    });
    mountAt(2);
    for (let i = 0; i < 10 && byId<HTMLElement>('onboarding-setup')?.dataset.state !== 'retrying'; i += 1) {
      await vi.advanceTimersByTimeAsync(50);
      await flush();
    }
    const card = byId<HTMLElement>('onboarding-setup')!;
    expect(card.dataset.state).toBe('retrying');
    expect(card.classList.contains('retrying')).toBe(true);
    expect(card.querySelector('.ss.live')?.textContent).toContain('Retrying');

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(attempts).toBe(2);
    expect(card.dataset.state).toBe('running');
    vi.useRealTimers();
  });

  it('keeps Open HQ Desktop disabled, and says so, until the install is done', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    mountAt(2);
    await flushUntil(() => commands().includes('fetch_and_extract_template'), 'the install');
    byId('welcome-skip')!.click();
    await flushUntil(() => scene() === 'ready', 'the ready screen');

    const open = () => byId('onboarding-open-desktop')!;
    const title = () => host.querySelector('#onboarding-title-ready')?.textContent?.trim();
    expect(open().disabled).toBe(true);
    expect(open().textContent?.trim()).toBe('Getting ready…');
    expect(title()).toBe('Almost ready.');
    // The Claude Code and Codex options wait with it.
    expect(byId('onboarding-launch-claude')!.disabled).toBe(true);
    expect(byId('onboarding-launch-codex')!.disabled).toBe(true);

    template.resolve();
    await flushUntil(() => !open().disabled, 'Open HQ Desktop');
    expect(open().textContent?.trim()).toBe('Open HQ Desktop');
    expect(title()).toBe('HQ is ready.');
    expect(byId('onboarding-launch-claude')!.disabled).toBe(false);
    expect(byId('onboarding-launch-codex')!.disabled).toBe(false);
  });
});

describe('welcome flow: the usage-data answer on the ready screen', () => {
  /** Skip from the first explainer to the ready screen while the install runs. */
  async function skipToReady() {
    await flushUntil(() => commands().includes('fetch_and_extract_template'), 'the install');
    byId('welcome-skip')!.click();
    await flushUntil(() => scene() === 'ready', 'the ready screen');
  }

  async function uncheckShare() {
    const box = byId<HTMLInputElement>('ready-consent-share')!;
    box.click();
    await flush();
    expect(box.checked).toBe(false);
  }

  it('records nothing while the install runs, then records the answer when the person finishes', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    const onfinish = vi.fn();
    mountAt(2, { onfinish });
    await skipToReady();
    await uncheckShare();

    expect(commands()).not.toContain('write_menubar_telemetry_pref');
    expect(commands()).not.toContain('post_telemetry_opt_in');

    template.resolve();
    await flushUntil(() => !byId('onboarding-open-desktop')!.disabled, 'Open HQ Desktop');
    // Still nothing: the answer is recorded on finish, not on install.
    expect(commands()).not.toContain('post_telemetry_opt_in');

    byId('onboarding-open-desktop')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    const order = commands();
    expect(order.indexOf('record_install_complete')).toBeLessThan(
      order.indexOf('post_telemetry_opt_in'),
    );
    expect(order.indexOf('ensure_person_entity')).toBeLessThan(
      order.indexOf('post_telemetry_opt_in'),
    );
    expect(calls.find((c) => c.command === 'write_menubar_telemetry_pref')?.args).toMatchObject({
      enabled: false,
      surface: 'onboarding',
    });
    expect(calls.find((c) => c.command === 'post_telemetry_opt_in')?.args).toMatchObject({
      enabled: false,
      surface: 'onboarding',
    });
  });

  it('surfaces a server failure honestly and finishes only once a retry succeeds', async () => {
    let fail = true;
    const template = deferred();
    stubInvoke({
      fetch_and_extract_template: () => template.promise,
      post_telemetry_opt_in: () => {
        if (fail) throw 'HTTP 500: internal server error';
        return undefined;
      },
    });
    const onfinish = vi.fn();
    mountAt(2, { onfinish });
    await skipToReady();
    template.resolve();
    await flushUntil(() => !byId('onboarding-open-desktop')!.disabled, 'Open HQ Desktop');

    byId('onboarding-open-desktop')!.click();
    await flushUntil(() => Boolean(byId('consent-error')), 'the failure');
    expect(onfinish).not.toHaveBeenCalled();
    expect(byId('consent-finish-offline')).toBeNull();

    fail = false;
    byId('consent-retry')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expect(byId('consent-error')).toBeNull();
  });

  it('never traps an offline person: the answer waits on this machine and they can finish', async () => {
    const template = deferred();
    stubInvoke({
      fetch_and_extract_template: () => template.promise,
      post_telemetry_opt_in: () => {
        throw new Error('error sending request: connection refused (offline)');
      },
    });
    const onfinish = vi.fn();
    mountAt(2, { onfinish });
    await skipToReady();
    template.resolve();
    await flushUntil(() => !byId('onboarding-open-desktop')!.disabled, 'Open HQ Desktop');
    byId('onboarding-open-desktop')!.click();
    await flushUntil(() => Boolean(byId('consent-error')), 'the offline note');
    expect(byId('consent-error')!.textContent).toContain('saved on this machine');
    expect(onfinish).not.toHaveBeenCalled();
    byId('consent-finish-offline')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expect(calls.filter((c) => c.command === 'post_telemetry_opt_in')).toHaveLength(1);
  });
});

describe('welcome flow: Claude Code and Codex on the ready screen', () => {
  it('offers both as large options with an Advanced disclosure under them', async () => {
    stubInvoke();
    mountAt(5);
    await flushUntil(() => Boolean(byId('onboarding-launch-codex')), 'the tool options');

    const launchers = byId<HTMLElement>('onboarding-launchers')!;
    const cards = Array.from(launchers.querySelectorAll<HTMLButtonElement>('.tool-card'));
    expect(cards.map((card) => card.querySelector('.tc-name')?.textContent?.trim())).toEqual([
      'Claude Code',
      'Codex',
    ]);
    // Each card is icon + name + one short line.
    for (const card of cards) {
      expect(card.querySelector('.tc-icon svg')).not.toBeNull();
      expect(card.querySelector('.tc-line')?.textContent?.trim()).toBeTruthy();
    }
    // The primary way on stays Open HQ Desktop.
    expect(forwardIn('ready')!.textContent?.trim()).toBe('Open HQ Desktop');

    // Advanced sits under the options: collapsed, with the folder and copy tools.
    const advanced = byId<HTMLDetailsElement>('onboarding-advanced')!;
    expect(launchers.contains(advanced)).toBe(true);
    expect(
      cards.every((card) => card.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(advanced.open).toBe(false);
    expect(advanced.textContent).toContain('Reveal folder');
    expect(advanced.textContent).toContain('Copy /setup');
    expect(advanced.textContent).toContain('Copy /import-claude');
  });

  it('opens Claude Code the way the ready screen always did, then finishes', async () => {
    stubInvoke();
    const onfinish = mountAt(5);
    await flushUntil(() => Boolean(byId('onboarding-launch-claude')), 'the Claude Code option');
    byId('onboarding-launch-claude')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expect(commands()).toContain('open_claude_code_link');
  });
});

describe('welcome flow: replay', () => {
  it('shows only the four story screens and closes on Done', async () => {
    stubInvoke();
    const onfinish = mountAt(0, { mode: 'replay' });
    await flushUntil(() => scene() === 'welcome', 'the welcome');

    // No sign-in, folder choice, install, consent or ready.
    expect(host.querySelector('[data-testid="onboarding-signin"] .btns')).toBeNull();
    expect(host.querySelector('[data-scene="folder"] .loc')).toBeNull();
    expect(byId('onboarding-setup')).toBeNull();
    expect(byId('onboarding-consent')).toBeNull();
    expect(byId('onboarding-summary')).toBeNull();

    const walked: string[] = [];
    for (const expected of ['welcome', 'folder', 'cloud', 'shortcut']) {
      await flushUntil(() => scene() === expected, expected);
      walked.push(scene()!);
      const next = forwardIn(expected)!;
      expect(next.textContent?.trim()).toBe(expected === 'shortcut' ? 'Done' : 'Next');
      next.click();
    }
    await flushUntil(() => onfinish.mock.calls.length === 1, 'Done');
    expect(walked).toEqual(['welcome', 'folder', 'cloud', 'shortcut']);
    // Nothing of setup ran.
    for (const command of [
      'resolve_hq_path',
      'start_oauth_login',
      'fetch_and_extract_template',
      'write_menubar_telemetry_pref',
      'emit_desktop_operational_telemetry',
    ]) {
      expect(commands()).not.toContain(command);
    }
  });

  it('can be left at any point with Escape or Skip intro', async () => {
    stubInvoke();
    const onfinish = mountAt(0, { mode: 'replay' });
    await flushUntil(() => scene() === 'welcome', 'the welcome');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushUntil(() => onfinish.mock.calls.length === 1, 'Escape');
  });
});

describe('welcome flow: the backdrop', () => {
  const WALLPAPER = 'data:image/jpeg;base64,/9j/';

  it('paints the wallpaper full-bleed behind the veil when there is one', async () => {
    stubInvoke();
    mountAt(0, { wallpaper: WALLPAPER });
    await flushUntil(() => scene() === 'welcome', 'the welcome');

    const layer = byId<HTMLDivElement>('welcome-wallpaper');
    expect(layer).not.toBeNull();
    expect(layer!.style.backgroundImage).toContain(WALLPAPER);
    expect(root().classList.contains('has-wallpaper')).toBe(true);
    // Behind the veil: the veil blurs and dims it.
    const veil = root().querySelector('.veil')!;
    expect(layer!.compareDocumentPosition(veil) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stays transparent over the native blur when there is no wallpaper', async () => {
    stubInvoke();
    mountAt(0);
    await flushUntil(() => scene() === 'welcome', 'the welcome');

    expect(byId('welcome-wallpaper')).toBeNull();
    expect(root().classList.contains('has-wallpaper')).toBe(false);
  });
});
