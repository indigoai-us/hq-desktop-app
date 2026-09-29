// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));
const eventHarness = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn(),
}));
const app = vi.hoisted(() => ({
  getVersion: vi.fn(),
}));
const onboardingFlags = vi.hoisted(() => ({
  firstFolderSyncEnabled: false,
  inviteTeammateEnabled: false,
  setupStageTimeoutFixEnabled: false,
  hasFeature: vi.fn(),
  startSync: vi.fn(),
}));

const httpFetch = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  })),
);

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: eventHarness.listen }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: app.getVersion }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: tauri.open }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));
vi.mock('@hq/platform', () => ({
  SETUP_DIRECTORY_PARENT_FALLBACK_FLAG: 'desktop.setup-directory-parent-fallback',
  SETUP_STAGE_TIMEOUT_FIX_FLAG: 'desktop.setup-stage-timeout-fix-v1',
  FIRST_FOLDER_SYNC_STEP_FLAG: 'desktop.first-folder-sync-step-v1',
  INVITE_TEAMMATE_STEP_FLAG: 'desktop.invite-teammate-step-v1',
  retryThrottled: async <T>(
    attempt: (attemptIndex: number) => Promise<T>,
    classify: (result: T) => { status: number | null },
  ) => {
    let result = await attempt(0);
    for (let attemptIndex = 1; attemptIndex < 4; attemptIndex += 1) {
      const status = classify(result).status;
      if (status !== 429 && status !== 503) return result;
      result = await attempt(attemptIndex);
    }
    return result;
  },
  createSyncPlatformAdapter: vi.fn(() => ({
    identity: {
      hasFeature: (flag: string) => {
        if (
          flag === 'desktop.first-folder-sync-step-v1' ||
          flag === 'desktop.invite-teammate-step-v1' ||
          flag === 'desktop.setup-stage-timeout-fix-v1'
        ) {
          return onboardingFlags.hasFeature(flag);
        }
        if (flag !== 'desktop.setup-directory-parent-fallback') {
          return Promise.resolve({ ok: true, value: false });
        }
        return (async () => {
          try {
            const raw = await tauri.invoke('hq_pro_fetch', {
              url: '/v1/flags/resolve',
              method: 'GET',
              body: null,
            });
            const response =
              raw && typeof raw === 'object'
                ? (raw as { body?: unknown })
                : {};
            const body =
              typeof response.body === 'string' ? JSON.parse(response.body) : null;
            return {
              ok: true,
              value: body?.flags?.[flag] === true,
            };
          } catch {
            return {
              ok: false,
              reason: 'test flag transport unavailable',
              code: 'test-transport-failed',
            };
          }
        })();
      },
    },
    sync: {
      startSync: () => onboardingFlags.startSync(),
    },
  })),
}));

import { flushSync, mount, tick, unmount } from 'svelte';

import { SETUP_DEEP_LINK_PROMPT } from '../../lib/setup-channel';
import OnboardingWizard from './OnboardingWizard.svelte';
import {
  BUILD_STEP_INDEX,
  CONNECTOR_IMPORT_STEP_INDEX,
  CONSENT_STEP_INDEX,
  SETUP_STEP_INDEX,
  TRUST_STEP_INDEX,
  __resetWizardRouterCompletionForTests,
} from '../../lib/onboarding-wizard';
import { __INTERNALS__ } from '../../lib/onboarding-step-telemetry';
import { __resetInstallerStepTelemetryForTests } from '../../lib/installer-step-telemetry';
import { stageTimeoutMs } from '../../lib/onboarding-setup';
import { appendChildFolderPath } from '../../lib/onboarding-path';

const NO_AI_TOOLS = {
  claude_cli: false,
  claude_desktop: false,
  codex_cli: false,
  codex_desktop: false,
  grok_cli: false,
  claude_last_used_ms: null,
  codex_last_used_ms: null,
  grok_last_used_ms: null,
  any: false,
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function primaryButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(
    '[data-testid="onboarding-summary"] .btn-primary',
  );
  if (!button) {
    throw new Error('Expected the onboarding summary primary button to render.');
  }
  return button;
}

/** A button on the ready screen by test id (the tool launchers live under Advanced). */
function readyButton(testId: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`Expected ${testId} to render.`);
  return button;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
  flushSync();
}

function emitTauriEvent(name: string, payload: unknown = {}): void {
  const handler = eventHarness.handlers.get(name);
  if (!handler) throw new Error(`Expected a listener for ${name}.`);
  handler({ payload });
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flush();
    if (predicate()) return;
  }
  throw new Error('Timed out waiting for onboarding launchers to settle.');
}

function mountWizard(
  onfinish = vi.fn(),
  initialStep = CONSENT_STEP_INDEX,
  aiTools = NO_AI_TOOLS,
): ReturnType<typeof vi.fn> {
  tauri.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/test/hq';
      case 'detect_ai_tools':
        return aiTools;
      default:
        return undefined;
    }
  });
  component = mount(OnboardingWizard, {
    target: host,
    props: { initialStep, onfinish },
  });
  return onfinish;
}

function firstFolderSyncActions(): string[] {
  return tauri.invoke.mock.calls.flatMap(([command, rawArgs]) => {
    const args = rawArgs as { eventName?: string; properties?: { step?: string; action?: string } };
    return command === 'emit_desktop_operational_telemetry' &&
      args.eventName === 'desktop_onboarding_step' &&
      args.properties?.step === 'first-folder-sync'
      ? [args.properties.action ?? '']
      : [];
  });
}

const CONTINUATION_CONTEXT = {
  installAttemptId: '11111111-1111-4111-8111-111111111111',
  appVersion: '0.10.229',
  apiBase: 'https://api.placeholder.test',
};

const CONTINUATION_CONFIG = {
  protocolVersion: 1,
  minimumDesktopVersion: '0.10.229',
  variant: 'continuation',
  rolloutPercent: 100,
} as const;

type ContinuationTestOptions = {
  config?: unknown | (() => unknown);
  identity?: unknown | (() => unknown);
  mayStart?: string | null;
  cancel?: undefined | (() => Promise<void>);
  deliver?: (args: { path: string; body: Record<string, string | number> }) => number;
};

/**
 * Native continuation commands are intentionally the only seam the renderer
 * gets. These tests use the exact command names so a first-run integration
 * cannot quietly become a browser-side duplicate of the native flow.
 */
function stubContinuationInvoke({
  config = CONTINUATION_CONFIG,
  identity = { email: 'placeholder account' },
  mayStart = null,
  cancel,
  deliver = () => 200,
}: ContinuationTestOptions = {}) {
  let authenticated = false;
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/placeholder/HQ';
      case 'detect_ai_tools':
        return NO_AI_TOOLS;
      case 'is_first_run':
        return true;
      case 'get_auth_state':
        return { authenticated };
      case 'emit_desktop_operational_telemetry':
        return undefined;
      case 'desktop_continuation_context':
        return CONTINUATION_CONTEXT;
      case 'desktop_continuation_config':
        return typeof config === 'function' ? config() : config;
      case 'desktop_continuation_may_start':
        return mayStart;
      case 'desktop_continuation_start':
        return { attemptId: 'continuation-attempt' };
      case 'desktop_continuation_await_identity':
        return typeof identity === 'function' ? identity() : identity;
      case 'desktop_continuation_confirm':
        authenticated = true;
        return undefined;
      case 'desktop_continuation_cancel':
        if (cancel) return cancel();
        return undefined;
      case 'desktop_continuation_deliver':
        return deliver(args as { path: string; body: Record<string, string | number> });
      case 'start_oauth_login':
        return { authorizeUrl: 'https://placeholder.test/authorize', state: 'oauth-state' };
      case 'oauth_listen_for_code':
        return { code: 'placeholder-code' };
      case 'oauth_exchange_code':
        authenticated = true;
        return { authenticated: true };
      case 'bring_main_window_to_front':
      case 'whoami':
        return undefined;
      default:
        return undefined;
    }
  });
}

function providerButtons(): HTMLButtonElement[] {
  return Array.from(
    host.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding-signin"] .btns .btn'),
  );
}

function stubOAuthAttempts(listenError?: string) {
  const fallbackInvoke = tauri.invoke.getMockImplementation();
  if (!fallbackInvoke) throw new Error('Expected the onboarding invoke stub to be installed.');
  let starts = 0;
  let listens = 0;
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'start_oauth_login') {
      starts += 1;
      return {
        authorizeUrl: `https://placeholder.test/authorize/${starts}`,
        state: `oauth-state-${starts}`,
      };
    }
    if (command === 'oauth_listen_for_code') {
      listens += 1;
      if (listenError) throw new Error(listenError);
      return { code: 'placeholder-code' };
    }
    return fallbackInvoke(command, args);
  });
  return { starts: () => starts, listens: () => listens };
}

async function clickGoogleSignIn(): Promise<void> {
  component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
  await flushUntil(() => providerButtons().length === 2);
  providerButtons()[0]?.click();
}

function expectPreBranchProviderScreen(): void {
  expect(providerButtons().map((button) => button.textContent?.trim())).toEqual([
    'Log in with Google',
    'Log in with Microsoft',
  ]);
  expect(providerButtons().every((button) => !button.disabled)).toBe(true);
  expect(host.querySelector('.inline-note.error')).toBeNull();
  expect(host.textContent).not.toContain('Continue as');
  expect(host.textContent).not.toContain('Use another account');
  expect(host.textContent).not.toContain('Finishing your sign-in in the browser');
}

async function advancePastSignIn(): Promise<void> {
  await vi.advanceTimersByTimeAsync(400);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  tauri.invoke.mockReset();
  tauri.open.mockReset();
  eventHarness.handlers.clear();
  eventHarness.listen.mockReset();
  eventHarness.listen.mockImplementation(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      eventHarness.handlers.set(name, handler);
      return () => {
        eventHarness.handlers.delete(name);
      };
    },
  );
  app.getVersion.mockReset();
  app.getVersion.mockResolvedValue('0.10.271');
  tauri.open.mockResolvedValue(undefined);
  httpFetch.mockReset();
  httpFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  });
  onboardingFlags.firstFolderSyncEnabled = false;
  onboardingFlags.inviteTeammateEnabled = false;
  onboardingFlags.setupStageTimeoutFixEnabled = false;
  onboardingFlags.hasFeature.mockReset().mockImplementation(async (flag: string) => ({
    ok: true,
    value:
      (flag === 'desktop.first-folder-sync-step-v1' &&
        onboardingFlags.firstFolderSyncEnabled) ||
      (flag === 'desktop.invite-teammate-step-v1' &&
        onboardingFlags.inviteTeammateEnabled) ||
      (flag === 'desktop.setup-stage-timeout-fix-v1' &&
        onboardingFlags.setupStageTimeoutFixEnabled),
  }));
  onboardingFlags.startSync.mockReset().mockResolvedValue({
    ok: true,
    value: 'hq-sync',
  });
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The deep link the wizard fires. `q` carries the skill-independent setup
 * prompt rather than the `/setup` slash command — a folder handed to Claude
 * Desktop by a link is untrusted when it scans skills, so HQ's project
 * `/setup` skill does not exist in the session the link opens.
 */
function expectedSetupDeepLink(folder: string): string {
  const params = new URLSearchParams({ q: SETUP_DEEP_LINK_PROMPT });
  params.set('folder', folder);
  return `claude://code/new?${params.toString()}`;
}

describe('onboarding directory selection', () => {
  it('moves a populated non-HQ default into a safe child before continuing', async () => {
    const defaultPath = '/Users/test/hq';
    const installPath = `${defaultPath}/hq`;
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'resolve_hq_path':
          return defaultPath;
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'check_writable':
          return true;
        case 'detect_hq':
          return args?.path === defaultPath
            ? { exists: true, isHq: false, nonEmpty: true }
            : { exists: false, isHq: false, nonEmpty: false };
        case 'hq_pro_fetch':
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: { 'desktop.setup-directory-parent-fallback': true },
            }),
          };
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 1 } });
    await flushUntil(() => {
      const directory = host.querySelector('[data-testid="onboarding-directory"]');
      const install = host.querySelector<HTMLButtonElement>(
        '[data-testid="onboarding-directory"] .btn-primary',
      );
      return directory?.classList.contains('on') === true && install !== null && !install.disabled;
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="onboarding-directory"] .btn-primary')
      ?.click();
    await flushUntil(
      () =>
        host
          .querySelector('[data-testid="onboarding-directory"] .lb')
          ?.getAttribute('title') === installPath,
    );

    expect(
      host.querySelector('[data-testid="onboarding-directory"] .lb')?.getAttribute('title'),
    ).toBe(installPath);
    expect(host.textContent).toContain('This location already has files');
    expect(host.querySelector('[data-testid="onboarding-directory"]')?.classList.contains('on'))
      .toBe(true);
  });

  it('puts HQ in a new child folder when the selected Windows location already has files', async () => {
    const selectedPath = 'C:\\Users\\test\\OneDrive - Personal';
    const installPath = `${selectedPath}\\hq`;
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'resolve_hq_path':
          return 'C:\\Users\\test\\hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'pick_folder':
          return selectedPath;
        case 'check_writable':
          return true;
        case 'detect_hq':
          return args?.path === selectedPath
            ? { exists: true, isHq: false, nonEmpty: true }
            : { exists: false, isHq: false, nonEmpty: false };
        case 'hq_pro_fetch':
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: { 'desktop.setup-directory-parent-fallback': true },
            }),
          };
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 1 } });
    await flushUntil(() => {
      const directory = host.querySelector('[data-testid="onboarding-directory"]');
      const choose = host.querySelector<HTMLButtonElement>(
        '[data-testid="onboarding-directory"] .choose',
      );
      return directory?.classList.contains('on') === true && choose !== null && !choose.disabled;
    });

    host
      .querySelector<HTMLButtonElement>('[data-testid="onboarding-directory"] .choose')
      ?.click();
    await flushUntil(
      () =>
        host
          .querySelector('[data-testid="onboarding-directory"] .lb')
          ?.getAttribute('title') === installPath,
    );

    const selectedFolder = host.querySelector('[data-testid="onboarding-directory"] .lb');
    expect(selectedFolder?.getAttribute('title')).toBe(installPath);
    expect(selectedFolder?.textContent).toContain('OneDrive - Personal\\hq');
    expect(tauri.invoke).toHaveBeenCalledWith('check_writable', { path: installPath });
    expect(tauri.invoke).toHaveBeenCalledWith('detect_hq', { path: installPath });
    expect(host.textContent).toContain('This location already has files');
  });

  it('keeps the selected replacement folder during completed-install recovery', async () => {
    const oldRoot = '/Users/test/previous-hq';
    const replacementRoot = '/Users/test/replacement-hq';
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'resolve_hq_path':
          return oldRoot;
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'pick_folder':
          return replacementRoot;
        case 'check_writable':
          return true;
        case 'detect_hq':
          return { exists: false, isHq: false, nonEmpty: false };
        case 'hq_pro_fetch':
          return {
            status: 200,
            body: JSON.stringify({ version: 1, flags: {} }),
          };
        case 'read_install_manifest':
          return {
            installPath: oldRoot,
            completedAt: '2026-01-01T00:00:00Z',
            steps: {},
          };
        case 'configure_claude_settings_path':
          return undefined;
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 1, recoveringMissingRoot: true },
    });
    await flushUntil(() => {
      const directory = host.querySelector('[data-testid="onboarding-directory"]');
      const choose = host.querySelector<HTMLButtonElement>(
        '[data-testid="onboarding-directory"] .choose',
      );
      return directory?.classList.contains('on') === true && choose !== null && !choose.disabled;
    });

    host
      .querySelector<HTMLButtonElement>('[data-testid="onboarding-directory"] .choose')
      ?.click();
    await flushUntil(
      () =>
        host
          .querySelector('[data-testid="onboarding-directory"] .lb')
          ?.getAttribute('title') === replacementRoot,
    );
    host
      .querySelector<HTMLButtonElement>('[data-testid="onboarding-directory"] .btn-primary')
      ?.click();

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, callArgs]) =>
          command === 'configure_claude_settings_path' &&
          (callArgs as Record<string, unknown> | undefined)?.hqPath === replacementRoot,
      ),
    );
    expect(tauri.invoke).not.toHaveBeenCalledWith('read_install_manifest');
    const configureCall = tauri.invoke.mock.calls.find(
      ([command]) => command === 'configure_claude_settings_path',
    );
    expect(configureCall?.[1]).toMatchObject({ hqPath: replacementRoot });
  });

  it('gives a next step when the selected folder cannot be written', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'pick_folder':
          return '/Users/test/Documents';
        case 'check_writable':
          return false;
        case 'detect_hq':
          return { exists: true, isHq: false, nonEmpty: true };
        case 'hq_pro_fetch':
          return {
            status: 200,
            body: JSON.stringify({
              version: 1,
              flags: { 'desktop.setup-directory-parent-fallback': true },
            }),
          };
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 1 } });
    await flushUntil(() => {
      const directory = host.querySelector('[data-testid="onboarding-directory"]');
      const choose = host.querySelector<HTMLButtonElement>(
        '[data-testid="onboarding-directory"] .choose',
      );
      return directory?.classList.contains('on') === true && choose !== null && !choose.disabled;
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="onboarding-directory"] .choose')
      ?.click();
    await flushUntil(() => host.textContent?.includes('privacy settings') === true);

    expect(host.textContent).toContain('Choose another location');
    expect(host.textContent).toContain('privacy settings');
    expect(host.textContent).not.toContain('Permission denied');
    const directory = host.querySelector('[data-testid="onboarding-directory"]');
    expect(directory?.querySelector('.inline-note')?.classList.contains('warning')).toBe(true);
    expect(directory?.querySelector('.inline-note')?.classList.contains('error')).toBe(false);
  });

  it('keeps directory check details in the log and leaves a recovery choice', async () => {
    const transportError = 'Permission denied: /private/Users/test/Documents';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'pick_folder':
          return '/Users/test/Documents';
        case 'detect_hq':
          return { exists: true, isHq: false, nonEmpty: false };
        case 'check_writable':
          throw new Error(transportError);
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 1 } });
    await flushUntil(() => {
      const directory = host.querySelector('[data-testid="onboarding-directory"]');
      const choose = host.querySelector<HTMLButtonElement>(
        '[data-testid="onboarding-directory"] .choose',
      );
      return directory?.classList.contains('on') === true && choose !== null && !choose.disabled;
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="onboarding-directory"] .choose')
      ?.click();
    await flushUntil(() => host.textContent?.includes('The folder could not be checked') === true);

    expect(host.textContent).toContain('Choose another location');
    expect(host.textContent).not.toContain(transportError);
    expect(
      host
        .querySelector('[data-testid="onboarding-directory"] .inline-note')
        ?.classList.contains('warning'),
    ).toBe(true);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="onboarding-directory"] .choose')
        ?.disabled,
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith('onboarding: selected directory could not be checked', expect.any(Error));
  });
});

describe('first-run browser session continuation', () => {
  it('records one launch receipt and retries the same receipt after a resumed wizard', async () => {
    const deliveredLaunches: Array<Record<string, string | number>> = [];
    stubContinuationInvoke({
      config: { ...CONTINUATION_CONFIG, variant: 'control' },
      deliver: ({ path, body }) => {
        if (path === '/v1/desktop/onboarding/launch') {
          deliveredLaunches.push(body);
          return deliveredLaunches.length === 1 ? 503 : 200;
        }
        return 200;
      },
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() => deliveredLaunches.length === 1);
    await flush();
    await flush();
    expect(deliveredLaunches).toHaveLength(1);

    await unmount(component);
    component = null;
    host.replaceChildren();
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 0, onboardingFlow: 'resume' },
    });

    await flushUntil(() => deliveredLaunches.length === 2);
    expect(deliveredLaunches[1]).toEqual(deliveredLaunches[0]);
    expect(localStorage.getItem(__INTERNALS__.STORAGE_KEY)).toContain('"firstLaunchRecorded":true');
  });

  it('starts provider OAuth and renders loading while rollout preparation is unresolved', async () => {
    let resolveConfig!: (value: unknown) => void;
    const config = new Promise<unknown>((resolve) => {
      resolveConfig = resolve;
    });
    stubContinuationInvoke({ config: () => config });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await vi.advanceTimersByTimeAsync(1_500);
    await flushUntil(() => providerButtons().length === 2);
    providerButtons()[0]?.click();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('start_oauth_login', { provider: 'Google' });
    expect(providerButtons()[0]?.disabled).toBe(true);
    expect(host.textContent).toContain('A browser window opened for Google sign-in.');

    resolveConfig({ ...CONTINUATION_CONFIG, variant: 'control' });
  });

  it('restarts sign-in once after an expired OAuth attempt', async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    const attempts = stubOAuthAttempts('Timed out waiting for sign-in (5 minutes).');

    await clickGoogleSignIn();
    await flushUntil(
      () =>
        attempts.starts() === 2 &&
        host.textContent?.includes('Sign-in took too long. Choose a provider to try again.') === true &&
        providerButtons().every((button) => !button.disabled),
    );

    expect(attempts.starts()).toBe(2);
    expect(attempts.listens()).toBe(2);
    expect(tauri.open).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Sign-in took too long. Choose a provider to try again.');
    expect(providerButtons().every((button) => !button.disabled)).toBe(true);
  });

  it('restarts sign-in once after an OAuth state mismatch', async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    const attempts = stubOAuthAttempts('OAuth state mismatch — possible CSRF, aborting.');

    await clickGoogleSignIn();
    await flushUntil(
      () =>
        attempts.starts() === 2 &&
        host.textContent?.includes('That sign-in attempt no longer matches. Choose a provider to start again.') ===
          true &&
        providerButtons().every((button) => !button.disabled),
    );

    expect(attempts.starts()).toBe(2);
    expect(attempts.listens()).toBe(2);
    expect(tauri.open).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(
      'That sign-in attempt no longer matches. Choose a provider to start again.',
    );
    expect(providerButtons().every((button) => !button.disabled)).toBe(true);
  });

  it('keeps the successful provider sign-in path to one browser attempt', async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    const attempts = stubOAuthAttempts();

    await clickGoogleSignIn();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'oauth_exchange_code'),
    );

    expect(attempts.starts()).toBe(1);
    expect(attempts.listens()).toBe(1);
    expect(tauri.open).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith('oauth_listen_for_code', {
      state: 'oauth-state-1',
    });
  });

  it('automatically signs in an eligible browser session without rendering a prompt or click', async () => {
    stubContinuationInvoke();
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_confirm'),
    );
    await advancePastSignIn();

    expect(tauri.invoke).toHaveBeenCalledWith('desktop_continuation_confirm', {
      attemptId: 'continuation-attempt',
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith('start_oauth_login', expect.anything());
    expect(host.textContent).not.toContain('Continue as');
    expect(host.textContent).not.toContain('Use another account');
    expect(host.textContent).not.toContain('Finishing your sign-in in the browser');
    expect(providerButtons()).toHaveLength(0);
    expect(
      host.querySelector('[data-testid="onboarding-directory"]')?.classList.contains('on'),
    ).toBe(true);
  });

  it('fails open to the pre-branch provider screen when config is the control arm', async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() => providerButtons().length === 2);

    expectPreBranchProviderScreen();
    expect(tauri.invoke).not.toHaveBeenCalledWith('desktop_continuation_start');
  });

  it('fails open to the pre-branch provider screen when config is unavailable', async () => {
    stubContinuationInvoke({
      config: () => {
        throw new Error('network unavailable');
      },
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() => providerButtons().length === 2);

    expectPreBranchProviderScreen();
    expect(host.textContent).not.toContain('network unavailable');
  });

  it('fails open to the pre-branch provider screen when config is malformed', async () => {
    stubContinuationInvoke({ config: { status: 'not a rollout document' } });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() => providerButtons().length === 2);

    expectPreBranchProviderScreen();
  });

  it('fails open to the pre-branch provider screen when the minimum build is newer', async () => {
    stubContinuationInvoke({
      config: { ...CONTINUATION_CONFIG, minimumDesktopVersion: '999.999.999' },
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() => providerButtons().length === 2);

    expectPreBranchProviderScreen();
  });

  it('fails open to the pre-branch provider screen when native eligibility refuses continuation', async () => {
    stubContinuationInvoke({ mayStart: 'CONTINUATION_REFUSED_NOT_FIRST_LAUNCH' });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() => providerButtons().length === 2);

    expectPreBranchProviderScreen();
    expect(tauri.invoke).not.toHaveBeenCalledWith('desktop_continuation_start');
  });

  it('reveals providers after 1.5 seconds but completes a continuation that returns later', async () => {
    let resolveIdentity!: (value: unknown) => void;
    const identity = new Promise<unknown>((resolve) => {
      resolveIdentity = resolve;
    });
    stubContinuationInvoke({ identity: () => identity });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_await_identity'),
    );
    expect(providerButtons()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    await flushUntil(() => providerButtons().length === 2);

    expectPreBranchProviderScreen();
    expect(tauri.invoke).not.toHaveBeenCalledWith('desktop_continuation_cancel', expect.anything());

    resolveIdentity({ email: 'placeholder account' });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_confirm'),
    );
    await advancePastSignIn();

    expect(
      host.querySelector('[data-testid="onboarding-directory"]')?.classList.contains('on'),
    ).toBe(true);
  });

  it('cancels the live continuation when a provider is chosen after reveal', async () => {
    let resolveIdentity!: (value: unknown) => void;
    const identity = new Promise<unknown>((resolve) => {
      resolveIdentity = resolve;
    });
    stubContinuationInvoke({ identity: () => identity });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_await_identity'),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await flushUntil(() => providerButtons().length === 2);

    providerButtons()[0]?.click();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('start_oauth_login', { provider: 'Google' });
    expect(tauri.invoke).toHaveBeenCalledWith('desktop_continuation_cancel', {
      attemptId: 'continuation-attempt',
    });
    expect(providerButtons()[0]?.disabled).toBe(true);
    expect(host.textContent).toContain('A browser window opened for Google sign-in.');

    resolveIdentity({ email: 'placeholder account' });
  });

  it('cancels a live continuation when the wizard unmounts', async () => {
    let resolveIdentity!: (value: unknown) => void;
    const identity = new Promise<unknown>((resolve) => {
      resolveIdentity = resolve;
    });
    stubContinuationInvoke({ identity: () => identity });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_await_identity'),
    );
    await unmount(component);
    component = null;

    expect(tauri.invoke).toHaveBeenCalledWith('desktop_continuation_cancel', {
      attemptId: 'continuation-attempt',
    });
    resolveIdentity({ email: 'placeholder account' });
  });

  it('records completion without abandonment when finishing unmounts the wizard', async () => {
    const onfinish = vi.fn(async () => {
      if (component === null) throw new Error('Expected the wizard to be mounted before finish.');
      await unmount(component);
      component = null;
    });
    mountWizard(onfinish, 4);
    await flush();

    primaryButton().click();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string } }).properties?.action === 'completed',
      ),
    );

    const completed = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string; outcome?: string } }).properties?.action ===
          'completed' &&
        (args as { properties?: { outcome?: string } }).properties?.outcome === 'finished',
    );
    const abandoned = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string } }).properties?.action === 'abandoned',
    );

    expect(onfinish).toHaveBeenCalledOnce();
    expect(completed).toHaveLength(1);
    expect(abandoned).toHaveLength(0);
  });

  it('does not record abandonment when the wizard is destroyed within the minimum visible window', async () => {
    mountWizard(vi.fn(), 0);
    await flush();
    await vi.advanceTimersByTimeAsync(11);
    if (component === null) throw new Error('Expected the wizard to be mounted before destruction.');
    await unmount(component);
    component = null;
    await flush();

    const abandoned = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string } }).properties?.action === 'abandoned',
    );
    expect(abandoned).toHaveLength(0);
  });

  it('records abandonment with the visible duration after a step stays on screen for 5 seconds', async () => {
    mountWizard(vi.fn(), 0);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    if (component === null) throw new Error('Expected the wizard to be mounted before destruction.');
    await unmount(component);
    component = null;
    await flush();

    const abandoned = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string } }).properties?.action === 'abandoned',
    );
    expect(abandoned).toHaveLength(1);
    expect((abandoned[0]?.[1] as { properties: { durationMs?: number } }).properties.durationMs).toBe(
      5000,
    );
  });

  it('records abandonment when finishing fails before the wizard is destroyed', async () => {
    const onfinish = vi.fn().mockRejectedValue(new Error('tray handoff unavailable'));
    mountWizard(onfinish, 4);
    await flush();

    primaryButton().click();
    await flushUntil(() => Boolean(host.querySelector('[data-testid="launcher-finish-error"]')));
    await vi.advanceTimersByTimeAsync(5000);
    if (component === null) throw new Error('Expected the wizard to remain mounted after a failed finish.');
    await unmount(component);
    component = null;
    await flush();

    const abandoned = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string } }).properties?.action === 'abandoned',
    );
    expect(onfinish).toHaveBeenCalledOnce();
    expect(abandoned).toHaveLength(1);
  });

  it('does not record abandonment when the window goes away inside the minimum visible window', async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
    await flushUntil(() => providerButtons().length === 2);

    await vi.advanceTimersByTimeAsync(11);
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    await flush();

    const abandoned = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string } }).properties?.action === 'abandoned',
    );
    expect(abandoned).toHaveLength(0);
  });

  it('resets the abandonment timer when the current step changes', async () => {
    mountWizard(vi.fn(), TRUST_STEP_INDEX);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);

    const continueButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-trust"] .btn-primary',
    );
    if (!continueButton) throw new Error('Expected the trust step continue button to render.');
    continueButton.click();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);

    if (component === null) throw new Error('Expected the wizard to be mounted before destruction.');
    await unmount(component);
    component = null;
    await flush();

    const abandoned = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string } }).properties?.action === 'abandoned',
    );
    expect(abandoned).toHaveLength(0);
  });

  it('adds app version and normalized setup failure fields when native detail is absent', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/placeholder/HQ';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'install_deps':
          throw new Error('dependency installation failed');
        case 'take_onboarding_failure_detail':
          return undefined;
        case 'emit_desktop_operational_telemetry':
          return undefined;
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string } }).properties
            ?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage === 'deps',
      ),
    );
    const failure = tauri.invoke.mock.calls.find(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { failureStage?: string } }).properties?.failureStage === 'deps',
    )?.[1] as { properties: Record<string, unknown> };
    expect(failure.properties).toMatchObject({
      appVersion: '0.10.271',
      errorCategory: 'unknown',
      failureStage: 'deps',
      failedDependency: 'unknown',
    });
  });

  it('forwards scoped native content error kinds into setup failure telemetry', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/placeholder/HQ';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'fetch_and_extract_template':
          throw new Error('template setup failed');
        case 'take_onboarding_failure_detail':
          return {
            errorCategory: 'spawn-failed',
            errorKind: 'content_symlink_helper_spawn_failed',
            errorOperation: 'create_junction',
            errorIoKind: 'other',
            errorCode: 1,
          };
        case 'emit_desktop_operational_telemetry':
          return undefined;
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string } }).properties
            ?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'content',
      ),
    );

    const failure = tauri.invoke.mock.calls.find(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
          'content',
    )?.[1] as { properties: Record<string, unknown> };
    expect(failure.properties).toMatchObject({
      failureStage: 'content',
      errorCategory: 'spawn-failed',
      errorKind: 'content_symlink_helper_spawn_failed',
      errorOperation: 'create_junction',
      errorIoKind: 'other',
      errorCode: 1,
    });

    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-summary"]')));
    expect(
      host.querySelector('[data-testid="onboarding-completion-success-indicator"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="onboarding-completion-warning-indicator"]'),
    ).toBeNull();
  });

  it('records an OAuth failure with the continuation error kind', async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
    await flushUntil(() => providerButtons().length === 2);
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_oauth_login') throw new Error('CONTINUATION_OFFLINE');
      if (command === 'emit_desktop_operational_telemetry') return undefined;
      if (command === 'resolve_hq_path') return '/Users/placeholder/HQ';
      if (command === 'detect_ai_tools') return NO_AI_TOOLS;
      return undefined;
    });

    providerButtons()[0]?.click();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { outcome?: string } }).properties?.outcome === 'oauth_failed',
      ),
    );
    const failure = tauri.invoke.mock.calls.find(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { outcome?: string } }).properties?.outcome === 'oauth_failed',
    )?.[1] as { properties: Record<string, unknown> };
    expect(failure.properties.errorKind).toBe('offline');
  });

  it('keeps the welcome-signin step event in control and continuation arms', async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string; action?: string } }).properties?.step ===
            'welcome-signin',
      ),
    );
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string; action?: string } }).properties?.step ===
            'welcome-signin' &&
          (args as { properties?: { action?: string } }).properties?.action === 'entered',
      ),
    ).toBe(true);

    await unmount(component!);
    component = null;
    host.replaceChildren();
    tauri.invoke.mockClear();
    stubContinuationInvoke();
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string; action?: string } }).properties?.step ===
            'welcome-signin',
      ),
    );
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string; action?: string } }).properties?.step ===
            'welcome-signin' &&
          (args as { properties?: { action?: string } }).properties?.action === 'entered',
      ),
    ).toBe(true);
  });
});

describe('onboarding launch handoff', () => {
  it('turns a failed Claude launch into a folder escape path, never a red dump', async () => {
    mountWizard(vi.fn(), 4, { ...NO_AI_TOOLS, claude_desktop: true, any: true });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-claude"]')),
    );

    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return { ...NO_AI_TOOLS, claude_desktop: true, any: true };
        case 'open_claude_code_link':
          throw new Error(
            'HQ folder is not ready for Claude Code Desktop setup repair (core/core.yaml (valid hq-core schema), companies/manifest.yaml) — re-tether in Settings or finish onboarding',
          );
        default:
          return undefined;
      }
    });

    readyButton('onboarding-launch-claude').click();
    await flush();

    const summary = host.querySelector('[data-testid="onboarding-summary"]');
    expect(summary?.textContent).toContain('Open the folder and run /setup');
    expect(summary?.textContent).toContain('Reveal folder');
    expect(summary?.textContent).toContain('Copy /setup');
    expect(summary?.textContent).not.toContain('core/core.yaml');
    expect(summary?.textContent).not.toContain('Could not open Claude Code');
    expect(summary?.querySelector('.inline-note.error')).toBeNull();
  });

  it('retries a failed native handoff without relaunching the AI tool', async () => {
    const onfinish = vi
      .fn()
      .mockRejectedValueOnce(new Error('tray handoff unavailable'))
      .mockResolvedValue(undefined);
    mountWizard(
      onfinish,
      4,
      { ...NO_AI_TOOLS, claude_desktop: true, any: true },
    );
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-claude"]')),
    );

    readyButton('onboarding-launch-claude').click();
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'open_claude_code_link'),
    ).toHaveLength(1);
    const recovery = host.querySelector<HTMLElement>(
      '[data-testid="launcher-finish-error"]',
    );
    expect(recovery?.textContent).toContain(
      'The tool opened. Finish HQ setup here when you’re ready.',
    );
    expect(recovery?.textContent).not.toContain('Could not open Claude Code');

    recovery?.querySelector<HTMLButtonElement>('button')?.click();
    await flush();

    expect(onfinish).toHaveBeenCalledTimes(2);
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'open_claude_code_link'),
    ).toHaveLength(1);
  });

  it('leads with Open HQ Desktop and keeps Claude Code and Codex under Advanced', async () => {
    mountWizard(vi.fn(), 4, {
      ...NO_AI_TOOLS,
      claude_desktop: true,
      codex_cli: true,
      grok_cli: true,
      any: true,
    });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-codex"]')),
    );

    // The one primary action: open HQ Desktop, where the setup bot takes over.
    expect(primaryButton().textContent?.trim()).toBe('Open HQ Desktop');
    expect(primaryButton().dataset.testid).toBe('onboarding-open-desktop');
    expect(host.querySelector('[data-testid="onboarding-summary"]')?.textContent).not.toContain(
      'Complete setup in your AI tool',
    );

    // Advanced holds exactly the two own-tool launchers, none of them primary.
    // It starts open and recommends that path to people who already use those
    // tools, so they do not have to discover the disclosure on their own.
    const advanced = host.querySelector<HTMLDetailsElement>('[data-testid="onboarding-advanced"]');
    expect(advanced).not.toBeNull();
    expect(advanced!.open).toBe(true);
    expect(advanced!.textContent).toContain('Recommended if you already use Claude Code or Codex');
    expect(advanced!.querySelector('summary')?.textContent?.trim()).toBe('Advanced');
    const row = advanced!.querySelector('[data-testid="onboarding-launchers"]');
    expect(row).not.toBeNull();
    const labels = Array.from(row!.querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(['Open in Claude Code', 'Open in Codex']);
    expect(row!.querySelector('.btn-primary')).toBeNull();
    expect(row!.textContent).not.toMatch(/\bFinish\b/);
  });

  it('offers both Claude Code and Codex when no AI tool is installed', async () => {
    // Previously this screen offered "Download Claude" alone, so a machine
    // with neither agent was never told Codex was an option — HQ read as
    // single-vendor at exactly the moment someone picks a tool.
    mountWizard(vi.fn(), 4);
    await flush();

    expect(host.querySelectorAll('[data-testid="onboarding-launchers"] button')).toHaveLength(2);
    expect(host.querySelector('[data-testid="onboarding-install-claude"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="onboarding-install-codex"]')).not.toBeNull();

    // Opening HQ Desktop stays the primary step; the installs sit under Advanced.
    expect(primaryButton().textContent?.trim()).toBe('Open HQ Desktop');
    expect(readyButton('onboarding-install-claude').textContent?.trim()).toBe('Install Claude Code');
  });

  it('restores friendly checklist labels instead of internal setup stage names', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'record_install_complete':
          return new Promise<never>(() => {});
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 2 },
    });

    const friendlyLabels = [
      'Laying the groundwork',
      'Building your workspace',
      'Bringing in your AI workers and workflows',
      'Making it yours',
      'Syncing across your devices',
    ];
    const rawStageLabels = [
      'Downloading HQ template',
      'Installing dependencies',
      'Syncing initial cloud data',
      'Initialising workspace',
      'Preparing personal workspace',
      'Registering for search',
    ];

    await flushUntil(() => {
      const checklist = host.querySelector('[data-testid="onboarding-setup"]');
      return friendlyLabels.every((label) => checklist?.textContent?.includes(label));
    });

    const checklist = host.querySelector('[data-testid="onboarding-setup"]');
    expect(checklist).not.toBeNull();
    for (const label of friendlyLabels) {
      expect(checklist?.textContent).toContain(label);
    }
    for (const label of rawStageLabels) {
      expect(checklist?.textContent).not.toContain(label);
    }
  });

  it('starts the usage data choice on Share, so Continue works without a click', async () => {
    mountWizard(vi.fn(), 2, NO_AI_TOOLS);
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-consent"] input[value="share"]')),
    );
    const share = host.querySelector<HTMLInputElement>(
      '[data-testid="onboarding-consent"] input[value="share"]',
    );
    const decline = host.querySelector<HTMLInputElement>(
      '[data-testid="onboarding-consent"] input[value="decline"]',
    );
    expect(share?.checked).toBe(true);
    expect(decline?.checked).toBe(false);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="consent-continue"]')?.disabled,
    ).toBe(false);
  });

  it('renders the same seamless completion screen after a failed required stage as after a clean run', async () => {
    const claudeDesktopOnly = {
      ...NO_AI_TOOLS,
      claude_desktop: true,
      any: true,
    };
    mountWizard(vi.fn(), 4, claudeDesktopOnly);
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-claude"]')),
    );
    const cleanCompletion = host.querySelector<HTMLElement>(
      '[data-testid="onboarding-summary"]',
    )?.innerHTML;
    expect(cleanCompletion).toBeTruthy();

    await unmount(component!);
    component = null;
    host.replaceChildren();

    const onfinish = vi.fn();
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/placeholder/hq';
        case 'detect_ai_tools':
          return claudeDesktopOnly;
        case 'install_deps':
          throw new Error('dependency installation failed');
        case 'detect_claude_desktop_connectors':
          return { present: false, count: 0, path: '/placeholder/connectors' };
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 2, onfinish },
    });

    // The install runs on its own while the consent card waits. Its Continue
    // is not pressed here: the choice now starts on Share, so pressing it would
    // move the wizard on mid-install, which is not what this test is about.
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-consent"] input[value="decline"]')),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-claude"]')),
    );

    const summary = host.querySelector('[data-testid="onboarding-summary"]');
    const launchClaude = host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-launch-claude"]',
    );
    expect((summary as HTMLElement | null)?.innerHTML).toBe(cleanCompletion);
    expect(summary?.textContent).not.toContain('dependency installation failed');
    expect(summary?.textContent).not.toContain('HQ setup needs attention');
    expect(
      host.querySelector('[data-testid="onboarding-completion-warning-indicator"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="onboarding-completion-success-indicator"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="onboarding-retry-failed-stages"]')).toBeNull();
    expect(launchClaude?.disabled).toBe(false);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="onboarding-install-codex"]')?.disabled,
    ).toBe(false);
    expect(tauri.invoke).toHaveBeenCalledWith('record_install_complete');

    launchClaude?.click();
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(tauri.invoke).toHaveBeenCalledWith('open_claude_code_link', expect.any(Object));
    expect(onfinish).toHaveBeenCalledOnce();
  });

  it('keeps the download handoff enabled after a required setup failure while tool detection is pending', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/placeholder/hq';
        case 'detect_ai_tools':
          return new Promise<never>(() => {});
        case 'install_deps':
          throw new Error('dependency installation failed');
        case 'detect_claude_desktop_connectors':
          return { present: false, count: 0, path: '/placeholder/connectors' };
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 2, onfinish: vi.fn() },
    });

    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-consent"] input[value="decline"]')),
    );
    host
      .querySelector<HTMLInputElement>('[data-testid="onboarding-consent"] input[value="decline"]')
      ?.click();
    host.querySelector<HTMLButtonElement>('[data-testid="consent-continue"]')?.click();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-summary"]')));

    const download = host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-launch-download"]',
    );
    expect(download).not.toBeNull();
    expect(download?.disabled).toBe(false);

    download?.click();
    await flush();
    expect(tauri.open).toHaveBeenCalledWith('https://claude.ai/download');
  });

  it('keeps the success completion indicator after a required setup failure', async () => {
    mountWizard();
    await flush();

    expect(
      host.querySelector('[data-testid="onboarding-completion-success-indicator"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="onboarding-completion-warning-indicator"]'),
    ).toBeNull();

    await unmount(component!);
    component = null;
    host.replaceChildren();

    const claudeDesktopOnly = {
      ...NO_AI_TOOLS,
      claude_desktop: true,
      any: true,
    };
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/placeholder/hq';
        case 'detect_ai_tools':
          return claudeDesktopOnly;
        case 'install_deps':
          throw new Error('dependency installation failed');
        case 'detect_claude_desktop_connectors':
          return { present: false, count: 0, path: '/placeholder/connectors' };
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 2, onfinish: vi.fn() },
    });

    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-consent"] input[value="decline"]')),
    );
    host
      .querySelector<HTMLInputElement>('[data-testid="onboarding-consent"] input[value="decline"]')
      ?.click();
    host.querySelector<HTMLButtonElement>('[data-testid="consent-continue"]')?.click();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-summary"]')));

    expect(
      host.querySelector('[data-testid="onboarding-completion-warning-indicator"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="onboarding-completion-success-indicator"]'),
    ).not.toBeNull();
  });

  it('shows Codex as installed when only the ChatGPT-bundled desktop app is present', async () => {
    // Desktop Codex ships inside ChatGPT.app; the detector reports that as
    // codex_desktop, and the Ready screen must offer to launch it rather than
    // to install something the machine already has.
    mountWizard(vi.fn(), 4, {
      ...NO_AI_TOOLS,
      codex_desktop: true,
      any: true,
    });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-codex"]')),
    );

    expect(host.querySelector('[data-testid="onboarding-install-codex"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-install-claude"]')).not.toBeNull();
  });

  it('opens Codex from its own button when Claude is also installed', async () => {
    const onfinish = mountWizard(vi.fn(), 4, {
      ...NO_AI_TOOLS,
      claude_desktop: true,
      codex_desktop: true,
      any: true,
    });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-codex"]')),
    );

    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-launch-codex"]')?.click();
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(tauri.invoke).toHaveBeenCalledWith('launch_codex_desktop');
    expect(onfinish).toHaveBeenCalledOnce();
  });

  it('keeps final Done pending and guarded until the handoff finishes', async () => {
    let resolveFinish: (() => void) | undefined;
    const onfinish = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFinish = resolve;
        }),
    );
    mountWizard(onfinish, BUILD_STEP_INDEX);
    await flush();

    const done = host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-build"] .btn-primary',
    );
    expect(done).not.toBeNull();
    done?.click();
    await flush();

    expect(onfinish).toHaveBeenCalledOnce();
    expect(done?.textContent).toBe('Finishing…');
    expect(done?.disabled).toBe(true);
    expect(done?.getAttribute('aria-busy')).toBe('true');

    done?.click();
    expect(onfinish).toHaveBeenCalledOnce();

    resolveFinish?.();
    await flush();
    expect(done?.textContent).toBe('Done');
    expect(done?.disabled).toBe(false);
    expect(done?.getAttribute('aria-busy')).toBe('false');
  });

  it('consent-only mode asks just the consent question and finishes on the answer: no sign-in, folder, setup, or Not now', async () => {
    const onfinish = vi.fn(async () => {});
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: CONSENT_STEP_INDEX, mode: 'consent', onfinish },
    });

    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-consent"] input[value="decline"]')),
    );
    // Consent is compulsory here: dismissing is only for the stale re-prompt.
    expect(host.querySelector('[data-testid="consent-dismiss"]')).toBeNull();
    // No setup run was started behind the consent step.
    expect(tauri.invoke.mock.calls.map(([command]) => command)).not.toContain('read_install_manifest');

    host
      .querySelector<HTMLInputElement>('[data-testid="onboarding-consent"] input[value="decline"]')
      ?.click();
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="consent-continue"]')?.click();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() => onfinish.mock.calls.length > 0);

    expect(onfinish).toHaveBeenCalledTimes(1);
    // The wizard closed on the answer: the consent panel is still the one
    // showing, and the ready screen never became the active panel.
    expect(host.querySelector('[data-testid="onboarding-consent"]')?.classList.contains('on')).toBe(true);
    expect(host.querySelector('[data-testid="onboarding-summary"]')?.classList.contains('on')).toBe(false);
    expect(tauri.invoke.mock.calls.map(([command]) => command)).not.toContain('read_install_manifest');
  });

  it('keeps Waiting for Claude visible through not-ready polls, then deep-links once', async () => {
    const onfinish = mountWizard();
    let readyPolls = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'detect_claude_ready':
          readyPolls += 1;
          return readyPolls < 3
            ? { installed: false, logged_in: false }
            : { installed: true, logged_in: true };
        case 'open_claude_code_link':
          return undefined;
        default:
          return undefined;
      }
    });

    await flush();
    readyButton('onboarding-install-claude').click();
    await flush();
    expect(readyButton('onboarding-install-claude').textContent).toBe('Waiting for Claude…');

    await vi.advanceTimersByTimeAsync(3000);
    flushSync();
    expect(readyButton('onboarding-install-claude').textContent).toBe('Waiting for Claude…');

    await vi.advanceTimersByTimeAsync(3000);
    flushSync();
    expect(readyButton('onboarding-install-claude').textContent).toBe('Waiting for Claude…');

    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('open_claude_code_link', {
      url: expectedSetupDeepLink('/Users/test/hq'),
    });
    expect(tauri.invoke.mock.calls.filter(([command]) => command === 'open_claude_code_link'))
      .toHaveLength(1);
    expect(onfinish).toHaveBeenCalledOnce();
  });

  it('opens Claude Desktop after the bounded installed-only fallback', async () => {
    const onfinish = mountWizard();
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'detect_claude_ready':
          return { installed: true, desktop_installed: true, logged_in: false };
        case 'open_claude_code_link':
          return undefined;
        default:
          return undefined;
      }
    });

    await flush();
    readyButton('onboarding-install-claude').click();
    await flush();

    await vi.advanceTimersByTimeAsync(27_000);
    await flush();
    expect(tauri.invoke.mock.calls.filter(([command]) => command === 'open_claude_code_link'))
      .toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('open_claude_code_link', {
      url: expectedSetupDeepLink('/Users/test/hq'),
    });
    expect(onfinish).toHaveBeenCalledOnce();
  });

  it('stops the watcher and surfaces one error after consecutive readiness failures', async () => {
    mountWizard();
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'detect_claude_ready':
          throw new Error('Claude probe unavailable');
        default:
          return undefined;
      }
    });

    await flush();
    readyButton('onboarding-install-claude').click();
    await flush();

    await vi.advanceTimersByTimeAsync(9000);
    await flush();
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'detect_claude_ready'),
    ).toHaveLength(3);
    const escape = host.querySelector('[data-testid="onboarding-escape"]');
    expect(escape?.textContent).toContain('Open the folder yourself');
    expect(escape?.textContent).not.toContain('Claude probe unavailable');
    expect(host.textContent).toContain('Copy /setup');

    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'detect_claude_ready'),
    ).toHaveLength(3);
  });
});

describe('onboarding connector telemetry', () => {
  it('forwards connector source and failure category through the wizard adapter', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'detect_claude_desktop_connectors':
          return {
            present: true,
            count: 1,
            outcome: 'servers_detected',
            inspectedSources: 'claude_desktop_config',
          };
        case 'import_claude_desktop_connectors':
          return { ok: false, message: 'import failed', errorCategory: 'exit-nonzero' };
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: CONNECTOR_IMPORT_STEP_INDEX },
    });

    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-import"]')?.click();
    await flush();

    const connectorEvents = tauri.invoke.mock.calls
      .filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string } }).properties?.step === 'connector-import',
      )
      .map(([, args]) => (args as { properties: Record<string, unknown> }).properties);
    expect(connectorEvents).toContainEqual(
      expect.objectContaining({
        action: 'failed',
        detectedToolCount: 1,
        detectedSourceSet: 'claude_desktop_config',
        outcome: 'import_failed',
        errorCategory: 'exit-nonzero',
      }),
    );
  });

  it('delivers each auto-skip terminal outcome once and drains its delivery queue', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'detect_claude_desktop_connectors':
          return { present: false, count: 0, path: '/config' };
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: CONNECTOR_IMPORT_STEP_INDEX },
    });

    await flush();

    const connectorActions = tauri.invoke.mock.calls
      .filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string } }).properties?.step === 'connector-import',
      )
      .map(([, args]) => (args as { properties: { action: string } }).properties.action);
    expect(connectorActions).toEqual(['entered', 'skipped']);

    await flushUntil(() => {
      const pending = JSON.parse(
        localStorage.getItem(__INTERNALS__.STORAGE_KEY) ?? '{}',
      ) as { pending?: Array<{ properties: { step: string } }> };
      return !(pending.pending ?? []).some(
        (event) => event.properties.step === 'connector-import',
      );
    });

    const stored = JSON.parse(localStorage.getItem(__INTERNALS__.STORAGE_KEY) ?? '{}') as {
      pending?: Array<{ properties: { step: string; action: string } }>;
    };
    expect(
      (stored.pending ?? [])
        .filter((event) => event.properties.step === 'connector-import')
        .map((event) => event.properties.action),
    ).toEqual([]);
  });
});

describe('anonymous installer step pings', () => {
  function stubOnboardingInvoke(
    extras: Record<string, (args?: Record<string, unknown>) => unknown> = {},
  ) {
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command in extras) return extras[command]!(args);
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'device_fingerprint':
          return 'hashed-mac-test';
        case 'get_auth_state':
          return { authenticated: false };
        case 'is_first_run':
          return false;
        case 'emit_desktop_operational_telemetry':
          return undefined;
        default:
          return undefined;
      }
    });
  }

  it('posts /v1/installer/step with no auth and the same sessionId as desktop_onboarding_step', async () => {
    stubOnboardingInvoke();
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 0 },
    });

    await flushUntil(() => httpFetch.mock.calls.length > 0);

    const call = httpFetch.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://telemetry.hq.computer/v1/installer/step');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(
      (init.headers as Record<string, string> | undefined)?.Authorization,
    ).toBeUndefined();

    const body = JSON.parse(String(init.body)) as {
      installSessionId: string;
      step: string;
      personUid?: string;
      deviceId?: string;
    };
    const stored = JSON.parse(localStorage.getItem(__INTERNALS__.STORAGE_KEY) ?? '{}') as {
      sessionId?: string;
    };
    expect(body.installSessionId).toBe(stored.sessionId);
    expect(typeof body.installSessionId).toBe('string');
    expect(body.installSessionId.length).toBeGreaterThan(0);
    expect(body.personUid).toBeUndefined();
    expect(body.deviceId).toBe('hashed-mac-test');

    const operational = tauri.invoke.mock.calls.filter(
      ([command]) => command === 'emit_desktop_operational_telemetry',
    );
    expect(operational.length).toBeGreaterThan(0);
    const envelope = operational[0]![1] as {
      eventName: string;
      sessionId: string;
      properties: { step: string; action: string };
    };
    expect(envelope.eventName).toBe('desktop_onboarding_step');
    expect(envelope.sessionId).toBe(body.installSessionId);
    expect(envelope.properties.step).toBe('welcome-signin');
    expect(envelope.properties.action).toBe('entered');
  });

  it('leaves the wizard usable when the ping network call fails', async () => {
    httpFetch.mockRejectedValue(new Error('network down'));
    stubOnboardingInvoke();
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 0 },
    });
    await flush();
    await flush();
    expect(host.querySelector('[data-testid="onboarding-signin"]')).toBeTruthy();
    expect(host.textContent).not.toContain('network down');
  });

  it('leaves the wizard usable when device_fingerprint throws', async () => {
    stubOnboardingInvoke({
      device_fingerprint: () => {
        throw new Error('no fingerprint');
      },
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 0 },
    });
    await flushUntil(() => httpFetch.mock.calls.length > 0);
    const init = (httpFetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body)) as {
      deviceId?: string;
    };
    expect(body.deviceId).toBeUndefined();
    expect(host.querySelector('[data-testid="onboarding-signin"]')).toBeTruthy();
    expect(host.textContent).not.toContain('no fingerprint');
  });
});

describe('ready screen: Open HQ Desktop', () => {
  it('finishes onboarding without launching any AI tool', async () => {
    const onfinish = mountWizard(vi.fn(), 4, { ...NO_AI_TOOLS, claude_desktop: true, any: true });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-open-desktop"]')));

    readyButton('onboarding-open-desktop').click();
    await flush();

    expect(onfinish).toHaveBeenCalledOnce();
    const launchCommands = tauri.invoke.mock.calls
      .map(([command]) => command)
      .filter((command) => /^(open_claude_code_link|launch_claude_code|launch_codex_workspace|launch_codex_desktop|launch_cli_in_terminal)$/.test(String(command)));
    expect(launchCommands).toEqual([]);
  });
});

describe('setup restart', () => {
  // The router's "setup is done" gate is module-level and outlives a test, and
  // it refuses to navigate back past the setup step. Clear it so these cases
  // do not depend on which tests ran before them.
  beforeEach(() => {
    __resetWizardRouterCompletionForTests();
  });

  /** Counts every attempt at the first stage's command. */
  function contentAttempts(): number {
    return tauri.invoke.mock.calls.filter(
      ([command]) => command === 'fetch_and_extract_template',
    ).length;
  }

  function clickIn(panel: string, selector: string): void {
    const button = host.querySelector<HTMLButtonElement>(
      `[data-testid="${panel}"] ${selector}`,
    );
    if (!button) throw new Error(`Expected ${selector} inside ${panel}.`);
    if (button.disabled) throw new Error(`${selector} inside ${panel} is disabled.`);
    button.click();
  }

  /** Leave the setup step, then come back through Install. */
  async function leaveAndReturn(): Promise<void> {
    clickIn('onboarding-setup', '.btn-secondary');
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    clickIn('onboarding-directory', '.btn-primary');
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
  }

  async function cancelSetupWithoutFlagSource(): Promise<void> {
    const unavailableFlagSource = new Promise<never>(() => {});
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'hq_pro_fetch':
          return unavailableFlagSource;
        case 'fetch_and_extract_template':
          return new Promise<never>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() => eventHarness.handlers.has('install:progress'));
    emitTauriEvent('install:progress', { handle: 'setup-installer-handle' });
    clickIn('onboarding-setup', '.btn-secondary');
    await flush();
  }

  it('cancels an installer when no feature flag source is available', async () => {
    await cancelSetupWithoutFlagSource();
    const cancelCall = () =>
      tauri.invoke.mock.calls.find(([command]) => command === 'cancel_install');

    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'hq_pro_fetch'),
    ).toHaveLength(0);
    await flushUntil(() => cancelCall() !== undefined);
    expect(cancelCall()?.[1]).toEqual({ handle: 'setup-installer-handle' });
  });

  it('starts over when the person leaves mid-stage and comes back', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'fetch_and_extract_template':
          // Never settles: the stage is still in flight when the person
          // leaves, exactly as a slow download would be.
          return new Promise<never>(() => {});
        case 'record_install_complete':
          return new Promise<never>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(contentAttempts()).toBe(1);

    await leaveAndReturn();

    // The cancelled run still owns its hung stage; the restart must not be
    // swallowed by it, or setup sits at 0% with nothing running.
    expect(contentAttempts()).toBe(2);
  });

  it('starts over after a stage failed and the person came back', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'fetch_and_extract_template':
          throw new Error('template archive is corrupt');
        case 'install_deps':
          return new Promise<never>(() => {});
        case 'record_install_complete':
          return new Promise<never>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const afterFailure = contentAttempts();
    expect(afterFailure).toBeGreaterThanOrEqual(1);

    await leaveAndReturn();

    expect(contentAttempts()).toBeGreaterThan(afterFailure);
  });

  it('leaves no stage waiting on a retry that will never come', async () => {
    let attempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'fetch_and_extract_template':
          attempts += 1;
          // Transient: the stage goes to 'retrying' and waits for its next go.
          if (attempts === 1) throw new Error('network timeout while fetching the template');
          return new Promise<never>(() => {});
        case 'record_install_complete':
          return new Promise<never>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flush();
    // Inside the 1s auto-retry wait: the stage is 'retrying', not running.
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    const subStatus = () =>
      host.querySelector('[data-testid="onboarding-setup-substatus"]')?.textContent ?? '';
    expect(subStatus()).toContain('Retrying');

    // Leaving while the stage waits must not strand it: coming back runs it.
    await leaveAndReturn();

    expect(subStatus()).not.toContain('Retrying');
    // The cancelled run's own retry never fires (it is no longer current), so
    // the second attempt is the restart's.
    expect(attempts).toBe(2);
  });
});

describe('first-folder sync onboarding step', () => {
  async function reachPostSetupStep(enabled: boolean): Promise<void> {
    onboardingFlags.firstFolderSyncEnabled = enabled;
    mountWizard(vi.fn(), SETUP_STEP_INDEX);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
    await vi.advanceTimersByTimeAsync(500);
    await flush();
  }

  it('keeps the passed setup flow on consent when the flag is off', async () => {
    await reachPostSetupStep(false);

    expect(host.querySelector('[data-testid="onboarding-first-folder-sync"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="onboarding-consent"]')?.classList.contains('on'),
    ).toBe(true);
    expect(firstFolderSyncActions()).toEqual([]);
    expect(onboardingFlags.startSync).not.toHaveBeenCalled();
  });

  it('shows the gated step once and lets the person skip to consent', async () => {
    await reachPostSetupStep(true);

    expect(
      host.querySelector('[data-testid="onboarding-first-folder-sync"]')?.classList.contains('on'),
    ).toBe(true);
    expect(firstFolderSyncActions()).toEqual(['entered']);

    host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-first-folder-sync-skip"]',
    )?.click();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(
      host.querySelector('[data-testid="onboarding-consent"]')?.classList.contains('on'),
    ).toBe(true);
    expect(firstFolderSyncActions()).toEqual(['entered', 'skipped']);
    expect(onboardingFlags.startSync).not.toHaveBeenCalled();
  });

  it('does not record completion after a company sync aborts with conflicts', async () => {
    await reachPostSetupStep(true);
    host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-first-folder-sync-start"]',
    )?.click();
    await flush();

    emitTauriEvent('sync:complete', {
      company: 'personal',
      filesDownloaded: 0,
      bytesDownloaded: 0,
      filesSkipped: 0,
      conflicts: 1,
      aborted: true,
    });
    emitTauriEvent('sync:all-complete', {
      companiesAttempted: 1,
      filesDownloaded: 0,
      bytesDownloaded: 0,
      errors: [],
    });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(firstFolderSyncActions()).toEqual(['entered', 'started']);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'could not sync this folder',
    );
    expect(
      host.querySelector('[data-testid="onboarding-first-folder-sync"]')?.classList.contains('on'),
    ).toBe(true);
  });

  it('does not record completion when a sync error precedes an empty aggregate summary', async () => {
    await reachPostSetupStep(true);
    host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-first-folder-sync-start"]',
    )?.click();
    await flush();

    emitTauriEvent('sync:error', {
      company: 'personal',
      path: 'README.md',
      message: 'write failed',
    });
    emitTauriEvent('sync:all-complete', {
      companiesAttempted: 1,
      filesDownloaded: 0,
      bytesDownloaded: 0,
      errors: [],
    });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(firstFolderSyncActions()).toEqual(['entered', 'started']);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'could not sync this folder',
    );
    expect(
      host.querySelector('[data-testid="onboarding-first-folder-sync"]')?.classList.contains('on'),
    ).toBe(true);
  });

  it('shows a retryable error when sync authentication fails without all-complete', async () => {
    await reachPostSetupStep(true);
    const syncButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-first-folder-sync-start"]',
    );
    syncButton?.click();
    await flush();

    emitTauriEvent('sync:auth-error', { message: 'session expired' });
    await flush();

    expect(syncButton?.disabled).toBe(false);
    expect(syncButton?.getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'could not sync this folder',
    );
    expect(firstFolderSyncActions()).toEqual(['entered', 'started']);
    expect(onboardingFlags.startSync).toHaveBeenCalledTimes(1);
  });

  it('starts one sync on repeated clicks and records done only after the runner completes', async () => {
    await reachPostSetupStep(true);
    const syncButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-first-folder-sync-start"]',
    );
    expect(syncButton).not.toBeNull();

    syncButton?.click();
    syncButton?.click();
    await flush();

    expect(onboardingFlags.startSync).toHaveBeenCalledTimes(1);
    expect(syncButton?.disabled).toBe(true);
    expect(syncButton?.getAttribute('aria-busy')).toBe('true');
    expect(firstFolderSyncActions()).toEqual(['entered', 'started']);

    emitTauriEvent('sync:all-complete', {
      companiesAttempted: 1,
      filesDownloaded: 1,
      bytesDownloaded: 1,
      errors: [],
    });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(
      host.querySelector('[data-testid="onboarding-consent"]')?.classList.contains('on'),
    ).toBe(true);
    expect(firstFolderSyncActions()).toEqual(['entered', 'started', 'completed']);
    const firstFolderRow = tauri.invoke.mock.calls.find(([command, rawArgs]) => {
      const args = rawArgs as { eventName?: string; properties?: { step?: string } };
      return command === 'emit_desktop_operational_telemetry' &&
        args.eventName === 'desktop_onboarding_step' &&
        args.properties?.step === 'first-folder-sync';
    });
    const properties = (firstFolderRow?.[1] as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties ?? {}).sort()).toEqual([
      'action',
      'appVersion',
      'flow',
      'platform',
      'step',
      'surface',
    ]);
  });
});

describe('invite teammate onboarding step', () => {
  const inviteEmail = 'teammate@example.com';
  const ownerMembership = {
    companyUid: 'cmp_demo',
    personUid: 'prs_owner',
    status: 'active',
    role: 'owner',
  };

  async function reachInviteScenario(options: {
    flagEnabled?: boolean;
    firstFolderEnabled?: boolean;
    companyMembers?: Array<Record<string, unknown>>;
    fetchResponses?: Record<
      string,
      Array<{ status: number; body: unknown; retryAfter?: string }>
    >;
    inviteResponse?: { status: number; body: unknown };
    inviteResponses?: Array<{ status: number; body: unknown }>;
  } = {}): Promise<void> {
    onboardingFlags.firstFolderSyncEnabled = options.firstFolderEnabled ?? false;
    onboardingFlags.inviteTeammateEnabled = options.flagEnabled ?? true;
    let inviteResponseIndex = 0;
    const fetchResponseIndexes: Record<string, number> = {};
    mountWizard(vi.fn(), SETUP_STEP_INDEX);
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'hq_pro_fetch': {
          const url = args?.url;
          const configuredResponses =
            typeof url === 'string' ? options.fetchResponses?.[url] : undefined;
          const responseIndex =
            typeof url === 'string' ? (fetchResponseIndexes[url] ?? 0) : 0;
          const configuredResponse = configuredResponses?.[responseIndex];
          if (configuredResponse && typeof url === 'string') {
            fetchResponseIndexes[url] = responseIndex + 1;
            return {
              status: configuredResponse.status,
              body: JSON.stringify(configuredResponse.body),
              ...(configuredResponse.retryAfter
                ? { retryAfter: configuredResponse.retryAfter }
                : {}),
            };
          }
          if (url === '/membership/me') {
            return {
              status: 200,
              body: JSON.stringify({ memberships: [ownerMembership] }),
            };
          }
          if (url === '/membership/company/cmp_demo') {
            return {
              status: 200,
              body: JSON.stringify({ members: options.companyMembers ?? [ownerMembership] }),
            };
          }
          if (url === '/membership/invite') {
            const response =
              options.inviteResponses?.[inviteResponseIndex] ??
              options.inviteResponse ?? {
                status: 201,
                body: { membership: { status: 'pending' }, emailSent: true },
              };
            inviteResponseIndex += 1;
            return {
              status: response.status,
              body: JSON.stringify(response.body),
            };
          }
          return { status: 200, body: '{}' };
        }
        default:
          return undefined;
      }
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
    await vi.advanceTimersByTimeAsync(500);
    await flush();
  }

  function inviteStepRows(): Array<Record<string, unknown>> {
    return tauri.invoke.mock.calls.flatMap(([command, rawArgs]) => {
      const args = rawArgs as {
        eventName?: string;
        properties?: Record<string, unknown>;
      };
      return command === 'emit_desktop_operational_telemetry' &&
        args.eventName === 'desktop_onboarding_step' &&
        args.properties?.step === 'invite-teammate'
        ? [args.properties]
        : [];
    });
  }

  function clickInviteControl(testId: string): void {
    const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!button) throw new Error(`Expected ${testId} to render.`);
    if (button.disabled) throw new Error(`${testId} is disabled.`);
    button.click();
  }

  it('fails closed with the flag off and does not read memberships', async () => {
    await reachInviteScenario({ flagEnabled: false });

    expect(onboardingFlags.hasFeature).toHaveBeenCalledWith(
      'desktop.invite-teammate-step-v1',
    );
    expect(host.querySelector('[data-testid="onboarding-invite-teammate"]')).toBeNull();
    expect(
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'hq_pro_fetch' &&
          (args as { url?: string })?.url?.startsWith('/membership/'),
      ),
    ).toEqual([]);
  });

  it('does not show the step when the company has multiple active members', async () => {
    await reachInviteScenario({
      companyMembers: [
        ownerMembership,
        { companyUid: 'cmp_demo', personUid: 'prs_teammate', status: 'active' },
      ],
    });

    expect(host.querySelector('[data-testid="onboarding-invite-teammate"]')).toBeNull();
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'hq_pro_fetch' &&
          (args as { url?: string })?.url === '/membership/company/cmp_demo',
      ),
    ).toBe(true);
  });

  it('ignores non-active roster rows when checking the single active member', async () => {
    await reachInviteScenario({
      companyMembers: [
        ownerMembership,
        { companyUid: 'cmp_demo', personUid: 'prs_invited', status: 'pending' },
      ],
    });

    expect(host.querySelector('[data-testid="onboarding-invite-teammate"]')).not.toBeNull();
  });

  it('retries throttled membership reads using Retry-After before showing the step', async () => {
    await reachInviteScenario({
      fetchResponses: {
        '/membership/me': [
          { status: 503, body: { error: 'busy' }, retryAfter: '0' },
          { status: 200, body: { memberships: [ownerMembership] } },
        ],
        '/membership/company/cmp_demo': [
          { status: 429, body: { error: 'busy' }, retryAfter: '0' },
          { status: 200, body: { members: [ownerMembership] } },
        ],
      },
    });

    expect(host.querySelector('[data-testid="onboarding-invite-teammate"]')).not.toBeNull();
    for (const url of ['/membership/me', '/membership/company/cmp_demo']) {
      expect(
        tauri.invoke.mock.calls.filter(
          ([command, args]) =>
            command === 'hq_pro_fetch' && (args as { url?: string })?.url === url,
        ),
      ).toHaveLength(2);
    }
  });

  it('retries a throttled invite send using Retry-After', async () => {
    await reachInviteScenario({
      fetchResponses: {
        '/membership/invite': [
          { status: 503, body: { error: 'busy' }, retryAfter: '0' },
          {
            status: 201,
            body: { membership: { status: 'pending' }, emailSent: true },
          },
        ],
      },
    });
    const email = host.querySelector<HTMLInputElement>(
      '[data-testid="onboarding-invite-email"]',
    );
    if (!email) throw new Error('Expected the invite email field.');
    email.value = inviteEmail;
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-send"]')?.click();
    await flushUntil(() => host.textContent?.includes('Invitation sent.') === true);

    expect(
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'hq_pro_fetch' &&
          (args as { url?: string })?.url === '/membership/invite',
      ),
    ).toHaveLength(2);
  });

  it('shows after the first-folder step for a single-member company', async () => {
    await reachInviteScenario({ firstFolderEnabled: true });

    expect(
      host.querySelector('[data-testid="onboarding-first-folder-sync"]')?.classList.contains('on'),
    ).toBe(true);
    expect(
      host.querySelector('[data-testid="onboarding-invite-teammate"]')?.classList.contains('on'),
    ).toBe(false);

    clickInviteControl('onboarding-first-folder-sync-skip');
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(
      host.querySelector('[data-testid="onboarding-invite-teammate"]')?.classList.contains('on'),
    ).toBe(true);
    expect(
      host.querySelector('[data-testid="onboarding-consent"]')?.classList.contains('on'),
    ).toBe(false);
  });

  it('lets Skip continue to consent immediately', async () => {
    await reachInviteScenario();

    clickInviteControl('onboarding-invite-skip');
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(
      host.querySelector('[data-testid="onboarding-consent"]')?.classList.contains('on'),
    ).toBe(true);
    expect(inviteStepRows().map((row) => row.action)).toContain('skipped');
  });

  it('sends an invite and shows the success state', async () => {
    await reachInviteScenario();
    const email = host.querySelector<HTMLInputElement>(
      '[data-testid="onboarding-invite-email"]',
    );
    if (!email) throw new Error('Expected the invite email field.');
    email.value = inviteEmail;
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-send"]')?.click();
    await flushUntil(() => host.textContent?.includes('Invitation sent.') === true);

    const request = tauri.invoke.mock.calls.find(([command, args]) =>
      command === 'hq_pro_fetch' &&
      (args as { url?: string })?.url === '/membership/invite',
    );
    expect(request?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse((request?.[1] as { body: string }).body)).toEqual({
      companyUid: 'cmp_demo',
      role: 'member',
      invitedBy: 'prs_owner',
      inviteeEmail: inviteEmail,
      sendEmail: true,
    });
  });

  it('labels the optional action Skip before send and Continue after success', async () => {
    await reachInviteScenario();
    const continueButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-invite-skip"]',
    );
    expect(continueButton?.textContent?.trim()).toBe('Skip');

    const email = host.querySelector<HTMLInputElement>(
      '[data-testid="onboarding-invite-email"]',
    );
    if (!email) throw new Error('Expected the invite email field.');
    email.value = inviteEmail;
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-send"]')?.click();
    await flushUntil(() => host.textContent?.includes('Invitation sent.') === true);

    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-skip"]')
        ?.textContent?.trim(),
    ).toBe('Continue');
  });

  it('shows a safe send error state and keeps Skip available', async () => {
    await reachInviteScenario({
      inviteResponses: [
        {
          status: 201,
          body: {
            membership: { status: 'pending' },
            emailSent: false,
            emailError: 'secret server detail',
          },
        },
        { status: 200, body: { resent: true, emailSent: true } },
      ],
    });
    const email = host.querySelector<HTMLInputElement>(
      '[data-testid="onboarding-invite-email"]',
    );
    if (!email) throw new Error('Expected the invite email field.');
    email.value = inviteEmail;
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-send"]')?.click();
    await flushUntil(() =>
      host.querySelector('[data-testid="onboarding-invite-error"]') !== null,
    );

    expect(host.textContent).toContain(
      'HQ could not confirm that the invitation email was sent. You can try again or skip for now.',
    );
    expect(host.textContent).not.toContain('secret server detail');
    expect(
      inviteStepRows().some(
        (row) =>
          row.action === 'failed' && row.inviteErrorKind === 'email_delivery_failed',
      ),
    ).toBe(true);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-skip"]')?.disabled,
    ).toBe(false);

    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-send"]')?.click();
    await flushUntil(() => host.textContent?.includes('Invitation sent.') === true);
    const requests = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'hq_pro_fetch' &&
        (args as { url?: string })?.url === '/membership/invite',
    );
    expect(JSON.parse((requests[1]?.[1] as { body: string }).body)).toMatchObject({
      companyUid: 'cmp_demo',
      inviteeEmail: inviteEmail,
      resend: true,
    });
  });

  it('records invite shown and sent with companyUid and no email', async () => {
    await reachInviteScenario();
    const email = host.querySelector<HTMLInputElement>(
      '[data-testid="onboarding-invite-email"]',
    );
    if (!email) throw new Error('Expected the invite email field.');
    email.value = inviteEmail;
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-send"]')?.click();
    await flushUntil(() => host.textContent?.includes('Invitation sent.') === true);
    clickInviteControl('onboarding-invite-skip');
    await flush();

    const rows = inviteStepRows();
    expect(rows.map((row) => row.action)).toEqual(['entered', 'completed']);
    expect(rows.every((row) => row.companyUid === 'cmp_demo')).toBe(true);
    expect(rows.some((row) => 'email' in row || 'inviteeEmail' in row)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(inviteEmail);
  });
});

describe('setup progress direction', () => {
  interface ProgressSample {
    percent: number;
    bands: string[];
    subStatus: string;
    elapsedSeconds: number | null;
  }

  const BAND_RANK: Record<string, number> = { pending: 0, active: 1, done: 2 };

  it('keeps initial-sync alive while the native personal first-push reports progress', async () => {
    let resolveInitialSync: (() => void) | undefined;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'start_initial_cloud_sync':
          return new Promise<void>((resolve) => {
            resolveInitialSync = resolve;
          });
        case 'record_step_start':
        case 'record_step_ok':
        case 'record_install_complete':
        case 'emit_desktop_operational_telemetry':
          return undefined;
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 2 },
    });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'start_initial_cloud_sync'),
    );
    const failedInitialSyncEvents = () =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string } }).properties
            ?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'initial-sync',
      );

    await vi.advanceTimersByTimeAsync(300_000);
    emitTauriEvent('sync:personal-first-push-scan');
    await vi.advanceTimersByTimeAsync(300_000);
    emitTauriEvent('sync:personal-first-push-progress');
    await vi.advanceTimersByTimeAsync(300_000);
    await flush();

    expect(stageTimeoutMs('initial-sync')).toBe(390_000);
    expect(failedInitialSyncEvents()).toHaveLength(0);
    resolveInitialSync?.();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
  });

  it('renews the deps timeout only for lock-wait progress from its installer handle', async () => {
    let resolveInstall: (() => void) | undefined;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'install_deps':
          return new Promise<void>((resolve) => {
            resolveInstall = resolve;
          });
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'install_deps') &&
      eventHarness.handlers.has('install:progress') &&
      eventHarness.handlers.has('setup:cli-install-lock-wait'),
    );
    emitTauriEvent('install:progress', { handle: 'setup-installer-handle' });

    const failureEvents = () =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string } }).properties
            ?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'deps',
      );

    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps') - 1);
    emitTauriEvent('setup:cli-install-lock-wait', 'unrelated-installer');
    emitTauriEvent('setup:cli-install-lock-wait', 'setup-installer-handle');
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps') - 1);
    await flush();
    expect(failureEvents()).toHaveLength(0);

    emitTauriEvent('install:progress', {
      handle: 'setup-installer-handle',
      line: '',
      finished: true,
      error: null,
    });
    resolveInstall?.();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
  });

  it('does not renew the deps timeout for another installer handle', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'install_deps':
          return new Promise<void>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'install_deps') &&
      eventHarness.handlers.has('install:progress') &&
      eventHarness.handlers.has('setup:cli-install-lock-wait'),
    );
    emitTauriEvent('install:progress', { handle: 'active-installer' });

    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps') - 1);
    emitTauriEvent('setup:cli-install-lock-wait', 'different-installer');
    await vi.advanceTimersByTimeAsync(1);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string } }).properties
            ?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'deps',
      ),
    );

    const failure = tauri.invoke.mock.calls.find(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string; failureStage?: string } }).properties
          ?.action === 'failed' &&
        (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
          'deps',
    )?.[1] as { properties: Record<string, unknown> };
    expect(failure.properties.errorKind).toBe('setup_stage_timeout');
  });

  it('renews the deps inactivity timeout for installer output when the hq flag is on', async () => {
    onboardingFlags.setupStageTimeoutFixEnabled = true;
    let resolveInstall: (() => void) | undefined;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'install_deps':
          return new Promise<void>((resolve) => {
            resolveInstall = resolve;
          });
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'install_deps') &&
      eventHarness.handlers.has('install:progress'),
    );
    const installArgs = tauri.invoke.mock.calls.find(
      ([command]) => command === 'install_deps',
    )?.[1] as { failureScope: { setupRunId: string } };
    const timeoutFailures = () =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string; errorKind?: string } })
            .properties?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'deps' &&
          (args as { properties?: { errorKind?: string } }).properties?.errorKind ===
            'setup_stage_timeout',
      );

    emitTauriEvent('install:progress', {
      handle: 'setup-installer-handle',
      setupRunId: installArgs.failureScope.setupRunId,
      line: 'Starting installer',
    });
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps') - 1);
    emitTauriEvent('install:progress', {
      handle: 'setup-installer-handle',
      setupRunId: installArgs.failureScope.setupRunId,
      line: 'Installing a package',
    });
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps') - 1);
    await flush();

    expect(timeoutFailures()).toHaveLength(0);
    resolveInstall?.();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
  });

  it('renews the content inactivity timeout for download progress when the hq flag is on', async () => {
    onboardingFlags.setupStageTimeoutFixEnabled = true;
    let resolveContent: (() => void) | undefined;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'fetch_and_extract_template':
          return new Promise<void>((resolve) => {
            resolveContent = resolve;
          });
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'fetch_and_extract_template') &&
      eventHarness.handlers.has('content:progress'),
    );
    const contentArgs = tauri.invoke.mock.calls.find(
      ([command]) => command === 'fetch_and_extract_template',
    )?.[1] as { handle: string };
    const timeoutFailures = () =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string; errorKind?: string } })
            .properties?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'content' &&
          (args as { properties?: { errorKind?: string } }).properties?.errorKind ===
            'setup_stage_timeout',
      );

    emitTauriEvent('content:progress', {
      handle: contentArgs.handle,
      phase: 'download',
      receivedBytes: 1,
    });
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('content') - 1);
    emitTauriEvent('content:progress', {
      handle: contentArgs.handle,
      phase: 'extract',
      receivedBytes: 2,
    });
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('content') - 1);
    await flush();

    expect(timeoutFailures()).toHaveLength(0);
    resolveContent?.();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'install_deps'),
    );
  });

  it('renews the indexing inactivity timeout for reindex output when the hq flag is on', async () => {
    onboardingFlags.setupStageTimeoutFixEnabled = true;
    let resolveReindex: (() => void) | undefined;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'read_install_manifest':
          return {
            installPath: '/Users/test/hq',
            startedAt: '2026-07-28T12:00:00.000Z',
            completedAt: null,
            steps: {
              content: { status: 'ok' },
              deps: { status: 'ok' },
              'initial-sync': { status: 'ok' },
              'git-init': { status: 'ok' },
              personalize: { status: 'ok' },
              indexing: { status: 'pending' },
            },
          };
        case 'register_search_index':
          return new Promise<void>((resolve) => {
            resolveReindex = resolve;
          });
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'register_search_index') &&
      eventHarness.handlers.has('setup:reindex-progress'),
    );
    const reindexArgs = tauri.invoke.mock.calls.find(
      ([command]) => command === 'register_search_index',
    )?.[1] as {
      failureScope: { setupRunId: string };
      activityTimeoutEnabled: boolean;
    };
    expect(reindexArgs.activityTimeoutEnabled).toBe(true);
    const timeoutFailures = () =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string; errorKind?: string } })
            .properties?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'indexing' &&
          (args as { properties?: { errorKind?: string } }).properties?.errorKind ===
            'setup_stage_timeout',
      );

    await vi.advanceTimersByTimeAsync(stageTimeoutMs('indexing') - 1);
    emitTauriEvent('setup:reindex-progress', reindexArgs.failureScope.setupRunId);
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('indexing') - 1);
    await flush();

    expect(timeoutFailures()).toHaveLength(0);
    resolveReindex?.();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
  });

  it('keeps the existing deps timeout when the new hq flag is off', async () => {
    onboardingFlags.setupStageTimeoutFixEnabled = false;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'install_deps':
          return new Promise<void>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'install_deps') &&
      eventHarness.handlers.has('install:progress'),
    );
    emitTauriEvent('install:progress', { handle: 'setup-installer-handle' });
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps'));

    const failure = tauri.invoke.mock.calls.find(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as { properties?: { action?: string; failureStage?: string } }).properties
          ?.action === 'failed' &&
        (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
          'deps',
    )?.[1] as { properties: Record<string, unknown> } | undefined;
    expect(failure?.properties.errorKind).toBe('setup_stage_timeout');
  });

  it('continues timing out at the hard elapsed ceiling despite ongoing progress when the hq flag is on', async () => {
    onboardingFlags.setupStageTimeoutFixEnabled = true;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'install_deps':
          return new Promise<void>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'install_deps') &&
      eventHarness.handlers.has('install:progress'),
    );
    const installArgs = tauri.invoke.mock.calls.find(
      ([command]) => command === 'install_deps',
    )?.[1] as { failureScope: { setupRunId: string } };
    const timeoutFailures = () =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string; errorKind?: string } })
            .properties?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'deps' &&
          (args as { properties?: { errorKind?: string } }).properties?.errorKind ===
            'setup_stage_timeout',
      );

    const inactivityMs = stageTimeoutMs('deps');
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(inactivityMs - 1);
      emitTauriEvent('install:progress', {
        handle: 'setup-installer-handle',
        setupRunId: installArgs.failureScope.setupRunId,
        line: `Installing package ${i + 1}`,
      });
    }
    await vi.advanceTimersByTimeAsync(2);
    expect(timeoutFailures()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushUntil(() => timeoutFailures().length === 1);
    expect(timeoutFailures()).toHaveLength(1);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(
      host.querySelector('[data-testid="onboarding-consent"]')?.classList.contains('on'),
    ).toBe(true);
  });

  it('keeps the content wall-clock timeout when the new hq flag is off', async () => {
    onboardingFlags.setupStageTimeoutFixEnabled = false;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'fetch_and_extract_template':
          return new Promise<void>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'fetch_and_extract_template') &&
      eventHarness.handlers.has('content:progress'),
    );
    const contentArgs = tauri.invoke.mock.calls.find(
      ([command]) => command === 'fetch_and_extract_template',
    )?.[1] as { handle: string };

    await vi.advanceTimersByTimeAsync(stageTimeoutMs('content') - 1);
    emitTauriEvent('content:progress', {
      handle: contentArgs.handle,
      phase: 'download',
      receivedBytes: 1,
    });
    await vi.advanceTimersByTimeAsync(1);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string; errorKind?: string } })
            .properties?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'content' &&
          (args as { properties?: { errorKind?: string } }).properties?.errorKind ===
            'setup_stage_timeout',
      ),
    );
  });

  it('keeps indexing wall-clock timeout and omits activityTimeoutEnabled when the new hq flag is off', async () => {
    onboardingFlags.setupStageTimeoutFixEnabled = false;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'read_install_manifest':
          return {
            installPath: '/Users/test/hq',
            startedAt: '2026-07-28T12:00:00.000Z',
            completedAt: null,
            steps: {
              content: { status: 'ok' },
              deps: { status: 'ok' },
              'initial-sync': { status: 'ok' },
              'git-init': { status: 'ok' },
              personalize: { status: 'ok' },
              indexing: { status: 'pending' },
            },
          };
        case 'register_search_index':
          return new Promise<void>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, { target: host, props: { initialStep: 2 } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'register_search_index') &&
      eventHarness.handlers.has('setup:reindex-progress'),
    );
    const indexingArgs = tauri.invoke.mock.calls.find(
      ([command]) => command === 'register_search_index',
    )?.[1] as { failureScope: { setupRunId: string } };
    expect(indexingArgs).not.toHaveProperty('activityTimeoutEnabled');

    await vi.advanceTimersByTimeAsync(stageTimeoutMs('indexing') - 1);
    emitTauriEvent('setup:reindex-progress', indexingArgs.failureScope.setupRunId);
    await vi.advanceTimersByTimeAsync(1);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string; failureStage?: string; errorKind?: string } })
            .properties?.action === 'failed' &&
          (args as { properties?: { failureStage?: string } }).properties?.failureStage ===
            'indexing' &&
          (args as { properties?: { errorKind?: string } }).properties?.errorKind ===
            'setup_stage_timeout',
      ),
    );
  });

  function sampleProgress(): ProgressSample {
    const panel = host.querySelector('[data-testid="onboarding-setup"]');
    const elapsed = host.querySelector(
      '[data-testid="onboarding-setup-elapsed"]',
    )?.textContent;
    const seconds = elapsed?.match(/(\d+)s/)?.[1];
    return {
      percent: Number.parseInt(host.querySelector('.ppct')?.textContent ?? '', 10),
      bands: [...(panel?.querySelectorAll('[data-band-status]') ?? [])].map(
        (band) => band.getAttribute('data-band-status') ?? '',
      ),
      subStatus:
        host.querySelector('[data-testid="onboarding-setup-substatus"]')
          ?.textContent ?? '',
      elapsedSeconds: seconds ? Number.parseInt(seconds, 10) : null,
    };
  }

  it('never walks the ring or the bands backward while a stage auto-retries', async () => {
    let depsAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'install_deps':
          depsAttempts += 1;
          // The first attempt runs long enough to earn an elapsed clock, then
          // fails transiently so the wizard auto-retries it.
          if (depsAttempts === 1) {
            return new Promise<never>((_resolve, reject) => {
              setTimeout(
                () =>
                  reject(new Error('network timeout while installing dependencies')),
                25_000,
              );
            });
          }
          // The second attempt also takes a while, so the clock it inherited
          // is observable rather than gone in one tick.
          return new Promise<void>((resolve) => {
            setTimeout(resolve, 10_000);
          });
        case 'record_install_complete':
          // Holds the wizard on the setup step so the whole run stays visible.
          return new Promise<never>(() => {});
        default:
          return undefined;
      }
    });

    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 2 },
    });

    const samples: ProgressSample[] = [];
    await flush();
    for (let step = 0; step < 200; step += 1) {
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      const sample = sampleProgress();
      if (Number.isFinite(sample.percent)) samples.push(sample);
    }

    expect(depsAttempts).toBe(2);
    expect(samples.length).toBeGreaterThan(100);
    expect(samples.at(-1)?.percent).toBe(100);

    for (let i = 1; i < samples.length; i += 1) {
      const previous = samples[i - 1]!;
      const current = samples[i]!;
      expect(current.percent).toBeGreaterThanOrEqual(previous.percent);
      for (const [band, status] of current.bands.entries()) {
        expect(BAND_RANK[status]).toBeGreaterThanOrEqual(
          BAND_RANK[previous.bands[band]!]!,
        );
      }
    }

    // The retried stage says so, keeps an active band, and keeps the clock it
    // had already earned instead of restarting from zero.
    const retryIndexes = samples
      .map((sample, index) => (sample.subStatus.includes('Retrying') ? index : -1))
      .filter((index) => index >= 0);
    expect(retryIndexes.length).toBeGreaterThan(0);
    for (const index of retryIndexes) {
      const sample = samples[index]!;
      expect(sample.subStatus).toContain('Retrying — attempt 2 of 2…');
      expect(sample.bands).toContain('active');
      expect(sample.bands).not.toContain('');
      expect(sample.elapsedSeconds ?? 0).toBeGreaterThanOrEqual(25);
    }

    // The attempt that follows inherits that clock: it does not start over.
    const afterRetry = samples[retryIndexes.at(-1)! + 1];
    expect(afterRetry?.subStatus).not.toContain('Retrying');
    expect(afterRetry?.subStatus).not.toBe('');
    expect(afterRetry?.elapsedSeconds ?? 0).toBeGreaterThanOrEqual(25);
  });
});
