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
import {
  READY_STEP_INDEX,
  __resetWizardRouterCompletionForTests,
} from '../../lib/onboarding-wizard';
import {
  READY_CONSENT_DWELL_MS,
  READY_WATCHDOG_MS,
  __setReadyTimingsForTests,
} from '../../lib/welcome-flow';
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
      case 'detect_hq':
        return { exists: false };
      case 'check_writable':
        return true;
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
  // Tests that are not about the ready screen's consent dwell skip it; the
  // "ready screen's waits" tests below run on the real values.
  __setReadyTimingsForTests({ consentDwellMs: 0 });
  localStorage.clear();
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host.remove();
  __setReadyTimingsForTests(null);
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
    expect(card.textContent).toContain('Setting up your workspace');
  });

  it('drives the corner card from the real stage progress, to done', async () => {
    const template = deferred();
    const deps = deferred();
    stubInvoke({
      fetch_and_extract_template: () => template.promise,
      start_install_queue: () => deps.promise,
    });
    mountAt(2);
    await flushUntil(() => commands().includes('fetch_and_extract_template'), 'the first stage');
    const card = () => byId<HTMLElement>('onboarding-setup')!;
    const percent = () =>
      Number(byId<HTMLElement>('onboarding-setup-progress')!.getAttribute('aria-valuenow'));
    expect(card().dataset.state).toBe('running');
    const before = percent();

    template.resolve();
    await flushUntil(() => commands().includes('start_install_queue'), 'the second stage');
    expect(percent()).toBeGreaterThan(before);
    expect(card().textContent).toContain('Installing your tools');
    expect(card().textContent).not.toContain('Step');

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

  // Owner decision (2026-10-15): the ready screen does not open HQ Desktop
  // from a button. It shows honest progress and finishes by itself once the
  // blocking phase (content, git-init, personalize) and the post-ready steps
  // are done. Owner report (2026-10-16): the tool installs, the upload and the
  // index run in the background after that, under the Finishing setup chip;
  // the ready screen does not wait for them.
  const readyTitle = () => host.querySelector('#onboarding-title-ready')?.textContent?.trim();
  const readyLine = () => host.querySelector('[data-scene="ready"] .pl')?.textContent?.trim();
  const queueStatus = (state: string, done: number, total = 12, failed: string[] = []) => ({
    state,
    current: state === 'running' ? 'Claude Code' : null,
    currentId: state === 'running' ? 'claude-code' : null,
    done,
    total,
    failed,
  });
  const progress = (payload: unknown) => events.handlers.get('install-queue:progress')!({ payload });
  /** A host queue item's streaming install, as the wizard sees it. */
  const itemOutput = (handle: string, finished = false) =>
    events.handlers.get('install:progress')!({
      payload: { handle, line: 'installing', finished },
    });
  /** The ready screen while the blocking phase runs: honest progress, no buttons, no finish. */
  const expectWaiting = (onfinish: ReturnType<typeof vi.fn>) => {
    expect(readyTitle()).toBe('Almost ready.');
    expect(readyLine()).not.toBe('Installed and synced across your devices.');
    expect(readyLine()).toBe('Setting up your workspace');
    expect(byId('welcome-ready-substatus')).toBeNull();
    expect(host.querySelector('[data-scene="ready"]')!.textContent).not.toContain('Installed and synced across your devices.');
    expect(byId<HTMLElement>('onboarding-launchers')!.querySelectorAll('button')).toHaveLength(0);
    expect(onfinish).not.toHaveBeenCalled();
    expect(commands()).not.toContain('open_desktop_alt_window');
  };
  const expectReady = () => {
    expect(readyTitle()).toBe('HQ is ready.');
    expect(readyLine()).toBeUndefined();
  };
  /**
   * The ready screen once the blocking phase is done while background work
   * still runs: the heading says HQ is ready, and the progress line still
   * names the running work instead of claiming everything is done.
   */
  const expectReadyWhileBackgroundRuns = () => {
    expect(readyTitle()).toBe('HQ is ready.');
    expect(readyLine()).toMatch(/^Finishing setup: /);
    expect(host.querySelector('[data-scene="ready"]')!.textContent).not.toContain('Step');
    expect(host.querySelector('[data-scene="ready"] .pi')).toBeNull();
    expect(host.querySelector('[data-scene="ready"]')!.textContent).not.toContain('Installed and synced across your devices.');
    expect(byId<HTMLElement>('onboarding-launchers')!.querySelectorAll('button')).toHaveLength(0);
  };

  it('says Almost ready. while the install runs, then HQ is ready. and finishes once it is done', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    const onfinish = mountAt(2);
    await flushUntil(() => commands().includes('fetch_and_extract_template'), 'the install');
    byId('welcome-skip')!.click();
    await flushUntil(() => scene() === 'ready', 'the ready screen');
    await flush();
    expectWaiting(onfinish);

    template.resolve();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expectReady();
  });

  // Regression (owner report 2026-10-16, reversing PR 1656's wait): once the
  // blocking phase is done and the consent dwell has passed, the ready screen
  // finishes by itself while the tool installs and the host queue still run,
  // and neither the finish nor the window closing stops the queue.
  it('finishes after the blocking phase while deps and the queue still run, and does not stop the queue', async () => {
    const template = deferred();
    const deps = deferred();
    stubInvoke({
      fetch_and_extract_template: () => template.promise,
      start_install_queue: () => deps.promise,
    });
    const onfinish = mountAt(2);
    await flushUntil(() => commands().includes('fetch_and_extract_template'), 'the install');
    byId('welcome-skip')!.click();
    await flushUntil(() => scene() === 'ready', 'the ready screen');
    await flush();
    expectWaiting(onfinish);

    template.resolve();
    await flushUntil(() => commands().includes('start_install_queue'), 'the background phase');
    // The queue is installing a tool through a streaming install handle.
    progress(queueStatus('running', 9));
    itemOutput('install-claude-code');
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expect(scene()).toBe('ready');
    expectReadyWhileBackgroundRuns();
    expect(readyLine()).toBe('Finishing setup: installing Claude Code');
    expect(commands()).not.toContain('record_install_complete');
    expect(commands()).not.toContain('cancel_install');

    // A later settle does not finish a second time.
    deps.resolve();
    progress(queueStatus('complete', 12));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(onfinish).toHaveBeenCalledTimes(1);
    expect(readyLine()).toBeUndefined();

    // The welcome window closes: the queue's install is left running.
    await unmount(component!);
    component = null;
    await flush();
    expect(commands()).not.toContain('cancel_install');
  });

  it('leaves the queue running when the window closes while the tool installs are still starting', async () => {
    const deps = deferred();
    stubInvoke({ start_install_queue: () => deps.promise });
    const onfinish = mountAt(2);
    await flushUntil(() => commands().includes('start_install_queue'), 'the background phase');
    itemOutput('install-claude-code');
    await flush();
    expect(onfinish).not.toHaveBeenCalled();
    await unmount(component!);
    component = null;
    deps.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(commands()).not.toContain('cancel_install');
  });

  // A direct mount on the ready step (the window reopened while the desktop's
  // queue runs) has no blocking phase of its own: it finishes once it has
  // read the queue, so the progress line is honest, without waiting for the
  // queue to settle. Before this change it waited for the queue to settle.
  it('finishes after reading a queue this wizard did not start, while that queue still runs', async () => {
    stubInvoke({ get_install_queue_status: () => queueStatus('running', 9) });
    const onfinish = mountAt(READY_STEP_INDEX);
    await flushUntil(() => commands().includes('get_install_queue_status'), 'the queue read');
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expect(commands()).not.toContain('fetch_and_extract_template');
    expectReadyWhileBackgroundRuns();
    expect(commands()).not.toContain('cancel_install');
    expect(commands()).not.toContain('start_install_queue');
  });

  it('does not finish on a direct mount before the queue has been read', async () => {
    const read = deferred<unknown>();
    stubInvoke({ get_install_queue_status: () => read.promise });
    const onfinish = mountAt(READY_STEP_INDEX);
    await flushUntil(() => commands().includes('get_install_queue_status'), 'the queue read');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(onfinish).not.toHaveBeenCalled();

    // A queue that settled with a failed item does not hold the step either:
    // the desktop's own note tells the person what failed.
    read.resolve(queueStatus('attention', 11, 12, ['gh']));
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expectReady();
  });

  // (d) The keyboard cannot finish the ready screen early. The blocking phase
  // is what the step waits for now, so the check holds the template open.
  it('does not finish on Enter or the right arrow while the blocking phase runs', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    const onfinish = mountAt(2);
    await flushUntil(() => commands().includes('fetch_and_extract_template'), 'the install');
    byId('welcome-skip')!.click();
    await flushUntil(() => scene() === 'ready', 'the ready screen');
    await flushUntil(() => readyTitle() === 'Almost ready.', 'the pending state');
    for (const key of ['Enter', 'ArrowRight', ' ']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      host.querySelector('[data-scene="ready"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expectWaiting(onfinish);
    expect(scene()).toBe('ready');

    template.resolve();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    // Enter after the finish does not finish again.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(onfinish).toHaveBeenCalledTimes(1);
  });

  it('does not let a queue read that a progress event overtook bring back a running queue', async () => {
    const read = deferred<unknown>();
    stubInvoke({ get_install_queue_status: () => read.promise });
    const onfinish = mountAt(READY_STEP_INDEX);
    await flushUntil(() => commands().includes('get_install_queue_status'), 'the queue read');
    progress(queueStatus('complete', 12));
    read.resolve(queueStatus('running', 11));
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expectReady();
  });

  // PR 1656 review: a queue item that finishes without its progress event
  // reaching the wizard must not leave the progress line on a running item.
  // The step no longer waits for the queue, so the blocking phase is held
  // open here to keep the screen up while the re-read is checked.
  it('reads the queue again every 10 seconds, so a missed settle event cannot leave the line stale', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const advance = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await flush();
      };
      const statusReads = () => commands().filter((c) => c === 'get_install_queue_status').length;
      const template = deferred();
      let status = queueStatus('running', 11);
      stubInvoke({
        fetch_and_extract_template: () => template.promise,
        get_install_queue_status: () => status,
      });
      const onfinish = mountAt(2);
      for (let i = 0; i < 20 && !commands().includes('fetch_and_extract_template'); i += 1) await advance(5);
      byId('welcome-skip')!.click();
      for (let i = 0; i < 20 && (scene() !== 'ready' || statusReads() === 0); i += 1) await advance(5);
      expectWaiting(onfinish);
      const before = statusReads();

      // The queue settles, but its progress event never reaches the wizard.
      status = queueStatus('attention', 11, 12, ['gh']);
      await advance(9_000);
      expect(statusReads()).toBe(before);
      await advance(1_000);
      expect(statusReads()).toBe(before + 1);

      template.resolve();
      for (let i = 0; i < 40 && onfinish.mock.calls.length === 0; i += 1) await advance(5);
      expect(onfinish).toHaveBeenCalledTimes(1);
      // The re-read cleared the running queue, so nothing is left running.
      expectReady();
      // Nothing stops the queue.
      expect(commands()).not.toContain('cancel_install');
    } finally {
      vi.useRealTimers();
    }
  });

  // (c) A post-ready step that is still to come holds the finish. The
  // blocking phase finishes while the post-setup lookup (which names the company the
  // connector import offers itself for) is still out, so the ready screen is
  // on show with the install done and the post-ready steps not yet known.
  it('does not finish while a post-ready step is pending, and finishes after it hands back', async () => {
    const activeCompany = deferred<string | null>();
    const connectors = deferred<unknown>();
    stubInvoke({
      get_desktop_active_company: () => activeCompany.promise,
      detect_claude_desktop_connectors: () => connectors.promise,
    });
    const onfinish = mountAt(2);
    await flushUntil(() => commands().includes('record_install_complete'), 'the install');
    byId('welcome-skip')!.click();
    await flushUntil(() => scene() === 'ready', 'the ready screen');
    await flushUntil(
      () => commands().includes('get_desktop_active_company'),
      'the post-setup lookup',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    // The install is done, but the post-ready steps are not known yet.
    expect(scene()).toBe('ready');
    expect(onfinish).not.toHaveBeenCalled();
    expect(commands()).not.toContain('open_desktop_alt_window');

    // The lookup names a company: the connector import opens and holds the
    // finish while it looks.
    activeCompany.resolve('placeholder-co');
    await flushUntil(
      () => commands().includes('detect_claude_desktop_connectors'),
      'the connector import',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(onfinish).not.toHaveBeenCalled();
    expect(commands()).not.toContain('open_desktop_alt_window');

    // Nothing to import: the step hands back to the ready screen, which
    // then finishes by itself, once.
    connectors.resolve({ present: false, count: 0, outcome: 'none', inspectedSources: 'unknown' });
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expect(scene()).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(onfinish).toHaveBeenCalledTimes(1);
  });
});

describe('person entity recovery before the company lookup', () => {
  it('retries a failed person write before resolving post-setup company steps', async () => {
    let attempts = 0;
    stubInvoke({
      ensure_person_entity: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary person write failure');
        return true;
      },
      run_initial_sync: () => new Promise(() => {}),
    });
    mountAt(2);
    await flushUntil(() => attempts >= 2, 'the later person entity retry');
    expect(attempts).toBe(2);
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

  it('records nothing while the install runs, then records the answer when the flow finishes', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    const onfinish = vi.fn();
    mountAt(2, { onfinish });
    await skipToReady();
    await uncheckShare();

    expect(commands()).not.toContain('write_menubar_telemetry_pref');
    expect(commands()).not.toContain('post_telemetry_opt_in');

    template.resolve();
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

    await flushUntil(() => Boolean(byId('consent-error')), 'the failure');
    expect(onfinish).not.toHaveBeenCalled();
    expect(byId('consent-finish-offline')).toBeNull();

    fail = false;
    byId('consent-retry')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expect(byId('consent-error')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(onfinish).toHaveBeenCalledTimes(1);
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
    await flushUntil(() => Boolean(byId('consent-error')), 'the offline note');
    expect(byId('consent-error')!.textContent).toContain('saved on this machine');
    expect(onfinish).not.toHaveBeenCalled();
    byId('consent-finish-offline')!.click();
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');
    expect(calls.filter((c) => c.command === 'post_telemetry_opt_in')).toHaveLength(1);
    // The automatic finish that failed on the write does not run again after
    // the person finished from the button.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(onfinish).toHaveBeenCalledTimes(1);
  });
});

describe('welcome flow: the ready screen has no launch buttons', () => {
  // (a) Even with Claude Code and Codex installed and the install settled.
  it('shows no Open HQ Desktop, Claude Code or Codex button, and finishes by itself', async () => {
    const onfinish = vi.fn();
    stubInvoke({ get_install_queue_status: () => queueStatusComplete() });
    // Hold the finish open long enough to inspect the settled screen.
    const finishGate = deferred();
    onfinish.mockImplementation(() => finishGate.promise);
    mountAt(READY_STEP_INDEX, { onfinish });
    await flushUntil(() => commands().includes('detect_ai_tools'), 'the tool probe');
    await flushUntil(() => onfinish.mock.calls.length === 1, 'the finish');

    const launchers = byId<HTMLElement>('onboarding-launchers')!;
    expect(launchers).not.toBeNull();
    expect(launchers.querySelectorAll('button')).toHaveLength(0);
    for (const id of ['onboarding-open-desktop', 'onboarding-launch-claude', 'onboarding-launch-codex']) {
      expect(byId(id)).toBeNull();
    }
    const ready = host.querySelector<HTMLElement>('[data-scene="ready"]')!;
    expect(ready.querySelector('.tool-pill, .tool-card, .tool-card-desktop')).toBeNull();
    expect(ready.textContent).not.toContain('Open HQ Desktop');
    expect(ready.textContent).not.toContain('Claude Code');
    expect(ready.textContent).not.toContain('Codex');
    // The only controls left are the usage-data line (its checkbox and the
    // "What's collected" link) and HQ Anywhere.
    const buttons = Array.from(ready.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['What’s collected']);
    expect(byId('onboarding-advanced')).toBeNull();
    for (const tool of ['Reveal folder', 'Copy path', 'Copy command', 'Copy /setup', 'Copy /import-claude']) {
      expect(ready.textContent).not.toContain(tool);
    }
    expect(byId<HTMLInputElement>('ready-consent-share')).not.toBeNull();
    expect(commands()).not.toContain('open_claude_code_link');
    finishGate.resolve();
  });
});

function queueStatusComplete() {
  return { state: 'complete', current: null, currentId: null, done: 12, total: 12, failed: [] };
}

// PR 1656 review. The usage-data checkbox is ticked by default, so the ready
// screen must not finish (and record "share") before the person could untick
// it, and a ready screen that never finishes by itself must not leave the
// person with no button.
describe("welcome flow: the ready screen's waits", () => {
  beforeEach(() => {
    __setReadyTimingsForTests(null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  };
  const optIns = () => calls.filter((c) => c.command === 'post_telemetry_opt_in');
  const finishNote = () => byId<HTMLElement>('launcher-finish-error');

  async function mountSettledReady(overrides: Record<string, Handler> = {}) {
    stubInvoke({ get_install_queue_status: () => queueStatusComplete(), ...overrides });
    const onfinish = vi.fn();
    mountAt(READY_STEP_INDEX, { onfinish });
    for (let i = 0; i < 40 && !byId('ready-consent-share'); i += 1) await advance(5);
    await advance(5);
    return onfinish;
  }

  it('starts the full consent dwell only after blocking setup is ready', async () => {
    const template = deferred();
    stubInvoke({ fetch_and_extract_template: () => template.promise });
    const onfinish = mountAt(2);
    for (let i = 0; i < 60 && !commands().includes('fetch_and_extract_template'); i++) await advance(5);
    expect(commands()).toContain('fetch_and_extract_template');
    byId('welcome-skip')!.click();
    await advance(5);
    expect(scene()).toBe('ready');
    await advance(10_000);
    expect(host.querySelector('#onboarding-title-ready')?.textContent?.trim()).toBe('Almost ready.');
    expect(onfinish).not.toHaveBeenCalled();
    template.resolve();
    for (let i = 0; i < 60 && host.querySelector('#onboarding-title-ready')?.textContent?.trim() !== 'HQ is ready.'; i++) await advance(5);
    expect(host.querySelector('#onboarding-title-ready')?.textContent?.trim()).toBe('HQ is ready.');
    await advance(2_900);
    expect(onfinish).not.toHaveBeenCalled();
    expect(optIns()).toHaveLength(0);
    await advance(200);
    for (let i = 0; i < 60 && onfinish.mock.calls.length !== 1; i++) await advance(5);
    expect(onfinish).toHaveBeenCalledTimes(1);
  });

  it('stays up for the consent dwell after the checkbox appears, then records the answer and finishes', async () => {
    expect(READY_CONSENT_DWELL_MS).toBe(3_000);
    const onfinish = await mountSettledReady();
    expect(byId<HTMLInputElement>('ready-consent-share')!.checked).toBe(true);

    await advance(READY_CONSENT_DWELL_MS - 200);
    expect(onfinish).not.toHaveBeenCalled();
    expect(optIns()).toHaveLength(0);

    await advance(400);
    for (let i = 0; i < 20 && onfinish.mock.calls.length === 0; i += 1) await advance(5);
    expect(onfinish).toHaveBeenCalledTimes(1);
    expect(optIns()).toHaveLength(1);
    expect(optIns()[0].args).toMatchObject({ enabled: true, surface: 'onboarding' });
  });

  it('starts the wait again when the person touches the checkbox, and records the answer they left', async () => {
    const onfinish = await mountSettledReady();
    await advance(READY_CONSENT_DWELL_MS - 200);
    const box = byId<HTMLInputElement>('ready-consent-share')!;
    box.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    box.click();
    await flush();
    expect(box.checked).toBe(false);

    // The first wait would have run out here: nothing finishes.
    await advance(400);
    expect(onfinish).not.toHaveBeenCalled();
    await advance(READY_CONSENT_DWELL_MS - 800);
    expect(onfinish).not.toHaveBeenCalled();
    expect(optIns()).toHaveLength(0);

    await advance(600);
    for (let i = 0; i < 20 && onfinish.mock.calls.length === 0; i += 1) await advance(5);
    expect(onfinish).toHaveBeenCalledTimes(1);
    expect(optIns()).toHaveLength(1);
    expect(optIns()[0].args).toMatchObject({ enabled: false, surface: 'onboarding' });
  });

  it('finishes by itself once more after a failed write, when the person changes their answer', async () => {
    let fail = true;
    const onfinish = await mountSettledReady({
      post_telemetry_opt_in: () => {
        if (fail) throw 'HTTP 500: internal server error';
        return undefined;
      },
    });
    await advance(READY_CONSENT_DWELL_MS + 100);
    for (let i = 0; i < 20 && !byId('consent-error'); i += 1) await advance(5);
    expect(byId('consent-error')).not.toBeNull();
    expect(onfinish).not.toHaveBeenCalled();

    // A failed write that stays failed does not finish again by itself.
    await advance(READY_CONSENT_DWELL_MS * 2);
    expect(optIns()).toHaveLength(1);

    fail = false;
    byId<HTMLInputElement>('ready-consent-share')!.click();
    await flush();
    expect(byId('consent-error')).toBeNull();
    await advance(READY_CONSENT_DWELL_MS - 200);
    expect(onfinish).not.toHaveBeenCalled();
    await advance(400);
    for (let i = 0; i < 20 && onfinish.mock.calls.length === 0; i += 1) await advance(5);
    expect(onfinish).toHaveBeenCalledTimes(1);
    expect(optIns()).toHaveLength(2);
    expect(optIns()[1].args).toMatchObject({ enabled: false });
  });

  it('shows Finish setup when the ready screen has not finished by itself after the watchdog', async () => {
    // The step no longer waits for a running queue, so what holds it here is
    // a queue read that never comes back.
    stubInvoke({ get_install_queue_status: () => new Promise(() => {}) });
    const onfinish = vi.fn();
    mountAt(READY_STEP_INDEX, { onfinish });
    for (let i = 0; i < 40 && !calls.some((c) => c.command === 'get_install_queue_status'); i += 1) {
      await advance(5);
    }
    await advance(READY_WATCHDOG_MS - 1_000);
    expect(finishNote()).toBeNull();
    expect(onfinish).not.toHaveBeenCalled();

    await advance(1_500);
    const note = finishNote()!;
    expect(note).not.toBeNull();
    const button = note.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent?.trim()).toBe('Finish setup');
    expect(button.disabled).toBe(false);

    button.click();
    for (let i = 0; i < 20 && onfinish.mock.calls.length === 0; i += 1) await advance(5);
    expect(onfinish).toHaveBeenCalledTimes(1);
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

describe("welcome flow: Apple's developer tools", () => {
  const missingTools = { required: true, present: false, installerOpen: false, simulated: false };
  const installerOpen = { ...missingTools, installerOpen: true };
  const toolsReady = { ...missingTools, present: true };

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  }

  it('shows the waiting card before asking macOS to install, then resumes at the same stage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let status: Record<string, boolean> = missingTools;
    let cardUpWhenInstallStarted = false;
    stubInvoke({
      command_line_tools_status: () => status,
      command_line_tools_start_install: () => {
        cardUpWhenInstallStarted = !!byId('onboarding-clt-card');
        status = installerOpen;
        return status;
      },
      command_line_tools_show_installer: () => true,
    });
    mountAt(2);
    for (let i = 0; i < 20 && !commands().includes('command_line_tools_start_install'); i += 1) await advance(20);

    expect(cardUpWhenInstallStarted).toBe(true);
    const card = byId<HTMLElement>('onboarding-clt-card')!;
    expect(card.dataset.phase).toBe('installing');
    expect(card.textContent).toContain("Installing Apple's developer tools");
    expect(card.textContent).toContain('5 to 15 minutes');
    expect(card.textContent).toContain('continues on its own');
    expect(byId('onboarding-clt-progress')).not.toBeNull();
    expect(commands()).toContain('command_line_tools_show_installer');
    expect(commands()).not.toContain('start_install_queue');
    expect(commands()).not.toContain('git_init');

    byId('onboarding-clt-show')!.click();
    await flush();
    expect(commands().filter((c) => c === 'command_line_tools_show_installer').length).toBeGreaterThanOrEqual(2);

    status = toolsReady;
    for (let i = 0; i < 20 && !commands().includes('git_init'); i += 1) await advance(1_000);
    expect(byId('onboarding-clt-card')).toBeNull();
    expect(commands()).toContain('start_install_queue');
    expect(commands()).toContain('git_init');
    expect(commands().filter((c) => c === 'fetch_and_extract_template')).toHaveLength(1);
    expect(commands().filter((c) => c === 'command_line_tools_start_install')).toHaveLength(1);
  });

  it('offers a plain retry when the Apple install is cancelled, and carries on after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let status: Record<string, boolean> = missingTools;
    let starts = 0;
    stubInvoke({
      command_line_tools_status: () => status,
      command_line_tools_start_install: () => {
        starts += 1;
        status = starts === 1 ? installerOpen : toolsReady;
        return status;
      },
      command_line_tools_show_installer: () => true,
    });
    mountAt(2);
    for (let i = 0; i < 20 && starts === 0; i += 1) await advance(20);
    status = missingTools; // the person pressed Cancel or Disagree
    for (let i = 0; i < 20 && byId<HTMLElement>('onboarding-clt-card')?.dataset.phase !== 'cancelled'; i += 1) {
      await advance(1_000);
    }
    const card = byId<HTMLElement>('onboarding-clt-card')!;
    expect(card.dataset.phase).toBe('cancelled');
    expect(card.textContent).toContain("Apple's developer tools are not installed yet");
    expect(card.textContent).not.toMatch(/error|failed|exit|status \d/i);
    expect(commands()).not.toContain('start_install_queue');

    byId('onboarding-clt-retry')!.click();
    for (let i = 0; i < 20 && !commands().includes('start_install_queue'); i += 1) await advance(1_000);
    expect(starts).toBe(2);
    expect(byId('onboarding-clt-card')).toBeNull();
    expect(commands()).toContain('start_install_queue');
  });

  it('shows nothing and never starts an install when the tools are present', async () => {
    stubInvoke({ command_line_tools_status: () => toolsReady });
    mountAt(2);
    await flushUntil(() => commands().includes('git_init'), 'the git stage');
    expect(byId('onboarding-clt-card')).toBeNull();
    expect(commands()).not.toContain('command_line_tools_start_install');
  });
});
