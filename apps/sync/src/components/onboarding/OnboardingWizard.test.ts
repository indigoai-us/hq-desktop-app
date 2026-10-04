// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  companyNamePrefillEnabled: false,
  companyRouteLookupRetryEnabled: false,
  hasFeature: vi.fn(),
  resolveFeatureFlagStatus: vi.fn(),
  startSync: vi.fn(),
  refreshFeatureFlags: vi.fn(),
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
  hostComputerNoun: () => 'computer',
  FIRST_FOLDER_SYNC_STEP_FLAG: 'desktop.first-folder-sync-step-v1',
  COMPANY_NAME_PREFILL_FLAG: 'desktop.company-name-prefill-v1',
  FIRST_LAUNCH_JOIN_KEY_FLAG: 'desktop.first-launch-join-key-v1',
  FIRST_LAUNCH_SIGNIN_REACH_FLAG: 'desktop.first-launch-signin-reach-telemetry-v1',
  COMPANY_ROUTE_LOOKUP_RETRY_FLAG: 'desktop.company-route-lookup-retry-v1',
  SETUP_DEPS_TIMEOUT_RETRY_FLAG: 'desktop.setup-deps-timeout-retry-v1',
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
      refreshFeatureFlags: () => onboardingFlags.refreshFeatureFlags(),
      resolveFeatureFlagStatus: (flag: string) => onboardingFlags.resolveFeatureFlagStatus(flag),
      hasFeature: (flag: string) => {
        if (flag === 'desktop.first-folder-sync-step-v1') {
          return onboardingFlags.hasFeature(flag);
        }
        if (
          flag === 'desktop.first-launch-join-key-v1' ||
          flag === 'desktop.first-launch-signin-reach-telemetry-v1' ||
          flag === 'desktop.company-route-lookup-retry-v1' ||
          flag === 'desktop.company-name-prefill-v1'
        ) {
          return onboardingFlags.hasFeature(flag);
        }
        return Promise.resolve({ ok: true, value: false });
      },
    },
    sync: {
      startSync: () => onboardingFlags.startSync(),
    },
  })),
}));

import { flushSync, mount, tick, unmount } from 'svelte';

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

/** The ready screen's HQ Desktop option (Open HQ Desktop). */
function primaryButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(
    '[data-testid="onboarding-summary"] [data-testid="onboarding-open-desktop"]',
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

/**
 * A screen's markup without the parts its entrance animation moves: the
 * motion engines toggle `on` classes and write inline positions on a real
 * animation-frame clock, so two renders of the same screen differ only there.
 */
function stableMarkup(element: HTMLElement | null): string | undefined {
  if (!element) return undefined;
  const clone = element.cloneNode(true) as HTMLElement;
  for (const node of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))]) {
    node.classList?.remove('on');
    if (node.getAttribute('class') === '') node.removeAttribute('class');
    if (!node.closest('.pbar')) node.removeAttribute('style');
  }
  return clone.innerHTML;
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

/**
 * Skip the story explainers to the ready screen, as a person would, and let
 * the post-setup follow-on steps (first-folder sync, teammate invite,
 * connector import) pick up from there.
 */
async function skipToReady(): Promise<void> {
  await flushUntil(() => Boolean(host.querySelector('[data-testid="welcome-skip"]')));
  host.querySelector<HTMLButtonElement>('[data-testid="welcome-skip"]')?.click();
  await vi.advanceTimersByTimeAsync(500);
  await flush();
}

/** The ready screen is on show, carrying the usage-data line. */
function expectReadyWithConsent(): void {
  expect(
    host.querySelector('[data-testid="onboarding-summary"]')?.classList.contains('on'),
  ).toBe(true);
  expect(host.querySelector('[data-testid="ready-consent"]')).not.toBeNull();
  // First-run onboarding has no separate consent screen.
  expect(host.querySelector('[data-testid="onboarding-consent"]')).toBeNull();
}

/** Properties of every `emit_desktop_operational_telemetry` row named `eventName`. */
function operationalRows(eventName: string): Record<string, unknown>[] {
  return tauri.invoke.mock.calls.flatMap(([command, rawArgs]) => {
    const args = rawArgs as { eventName?: string; properties?: Record<string, unknown> };
    return command === 'emit_desktop_operational_telemetry' && args.eventName === eventName
      ? [args.properties ?? {}]
      : [];
  });
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
  // The provider buttons render only once the welcome animation has revealed
  // the sign-in block.
  await revealSignIn();
  providerButtons()[0]?.click();
}

function expectPreBranchProviderScreen(): void {
  expect(providerButtons().map((button) => button.textContent?.trim())).toEqual([
    // Welcome flow copy (designer prototype): same two providers, same flow.
    'Continue with Google',
    'Continue with Microsoft',
  ]);
  expect(providerButtons().every((button) => !button.disabled)).toBe(true);
  expect(host.querySelector('.inline-note.error')).toBeNull();
  expect(host.textContent).not.toContain('Continue as');
  expect(host.textContent).not.toContain('Use another account');
  expect(host.textContent).not.toContain('Finishing your sign-in in the browser');
}

/**
 * Finish the welcome animation the way a person can (Escape), then let the
 * next animation frames run so the mark settles and reveals the sign-in block.
 */
async function revealSignIn(): Promise<void> {
  await flush();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  for (let attempt = 0; attempt < 40 && providerButtons().length < 2; attempt += 1) {
    await vi.advanceTimersByTimeAsync(16);
    await flush();
  }
  expect(providerButtons()).toHaveLength(2);
}

/** Every native command that starts, drives, or tears down a browser continuation. */
const CONTINUATION_ATTEMPT_COMMANDS = [
  'desktop_continuation_config',
  'desktop_continuation_may_start',
  'desktop_continuation_start',
  'desktop_continuation_await_identity',
  'desktop_continuation_confirm',
  'desktop_continuation_cancel',
];

function continuationAttemptCalls(): string[] {
  return tauri.invoke.mock.calls
    .map(([command]) => command as string)
    .filter((command) => CONTINUATION_ATTEMPT_COMMANDS.includes(command));
}

function expectNothingOpenedInBrowser(): void {
  expect(continuationAttemptCalls()).toEqual([]);
  expect(tauri.invoke).not.toHaveBeenCalledWith('start_oauth_login', expect.anything());
  expect(tauri.open).not.toHaveBeenCalled();
}

beforeEach(() => {
  // Timers and the clock are faked; animation frames are not. The welcome
  // flow's motion runs on requestAnimationFrame, and faking it made every
  // advanceTimersByTime(300_000) also simulate ~18,000 frames of orbiting
  // chips that no assertion reads. The behaviour under test (setup, sign-in,
  // telemetry, timeouts) runs on timers and is still fully simulated.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'Date',
    ],
  });
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
  onboardingFlags.companyNamePrefillEnabled = false;
  onboardingFlags.companyRouteLookupRetryEnabled = false;
  onboardingFlags.refreshFeatureFlags.mockReset().mockResolvedValue(undefined);
  onboardingFlags.resolveFeatureFlagStatus.mockReset().mockImplementation(async (flag: string) => {
    const result = await onboardingFlags.hasFeature(flag);
    return result.ok
      ? { ok: true, value: { enabled: result.value, configured: true } }
      : result;
  });
  onboardingFlags.hasFeature.mockReset().mockImplementation(async (flag: string) => ({
    ok: true,
    value: flag === 'desktop.first-folder-sync-step-v1'
      ? onboardingFlags.firstFolderSyncEnabled
      : flag === 'desktop.company-name-prefill-v1'
        ? onboardingFlags.companyNamePrefillEnabled
        : flag === 'desktop.company-route-lookup-retry-v1' &&
        onboardingFlags.companyRouteLookupRetryEnabled,
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

describe('onboarding directory selection', () => {
  // The folder scene shows the chosen location in `.lpath` (full path in its
  // title) and the directory notice in `.notice`; "Install here" is its
  // primary button.
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
          .querySelector('[data-testid="onboarding-directory"] .lpath')
          ?.getAttribute('title') === installPath,
    );

    expect(
      host.querySelector('[data-testid="onboarding-directory"] .lpath')?.getAttribute('title'),
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
          .querySelector('[data-testid="onboarding-directory"] .lpath')
          ?.getAttribute('title') === installPath,
    );

    const selectedFolder = host.querySelector('[data-testid="onboarding-directory"] .lpath');
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
          .querySelector('[data-testid="onboarding-directory"] .lpath')
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
    expect(directory?.querySelector('.notice')?.classList.contains('warning')).toBe(true);
    expect(directory?.querySelector('.notice')?.classList.contains('error')).toBe(false);
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
    await flushUntil(() => host.textContent?.includes('HQ could not check this folder') === true);

    expect(host.textContent).toContain('Choose another location');
    expect(host.textContent).not.toContain(transportError);
    expect(
      host
        .querySelector('[data-testid="onboarding-directory"] .notice')
        ?.classList.contains('warning'),
    ).toBe(true);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="onboarding-directory"] .choose')
        ?.disabled,
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith('onboarding: selected directory could not be checked', expect.any(Error));
  });
});

describe('first-run sign-in screen', () => {
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

  it("says who is already signed in on this machine before anything is created, and can switch", async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    const fallback = tauri.invoke.getMockImplementation();
    let signedIn = true;
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_auth_state') {
        return signedIn ? { authenticated: true, email: 'old@previous.com' } : { authenticated: false };
      }
      if (command === 'sign_out') {
        signedIn = false;
        return undefined;
      }
      return fallback?.(command, args);
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-signed-in-as"]')));
    expect(host.querySelector('[data-testid="onboarding-signed-in-as"]')?.textContent).toContain(
      "You're signed in as old@previous.com.",
    );
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'run_card_action')).toBe(false);
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-signed-in-as-switch"]')?.click();
    await flushUntil(() => !host.querySelector('[data-testid="onboarding-signed-in-as"]'));
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'sign_out')).toBe(true);
  });

  it('continues with the session already on this machine', async () => {
    stubContinuationInvoke({ config: { ...CONTINUATION_CONFIG, variant: 'control' } });
    const fallback = tauri.invoke.getMockImplementation();
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_auth_state') return { authenticated: true, email: 'me@acme.com' };
      return fallback?.(command, args);
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-signed-in-as-continue"]')));
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-signed-in-as-continue"]')?.click();
    await flushUntil(() => host.querySelector('.hq-welcome')?.getAttribute('data-current-scene') !== 'welcome');
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'sign_out')).toBe(false);
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

  it('opens nothing in the browser on mount or while the welcome animation plays', async () => {
    // Regression: on a fresh machine the wizard used to start a browser
    // session continuation as soon as it mounted, so the browser opened on the
    // raw Cognito provider list before the welcome animation had played.
    // The stub keeps every continuation precondition eligible.
    stubContinuationInvoke();
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'desktop_continuation_deliver'),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();

    expect(host.querySelector('.hq-welcome')?.getAttribute('data-current-scene')).toBe('welcome');
    expect(providerButtons()).toHaveLength(0);
    expect(host.querySelector('[data-testid="onboarding-signin"] .signin')?.classList.contains('on')).toBe(
      false,
    );
    expectNothingOpenedInBrowser();
  });

  it('shows the provider buttons once the welcome animation reveals the sign-in block', async () => {
    stubContinuationInvoke();
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await revealSignIn();

    expect(host.querySelector('[data-testid="onboarding-signin"] .signin')?.classList.contains('on')).toBe(
      true,
    );
    expectPreBranchProviderScreen();
    expect(host.querySelector('[data-testid="onboarding-continue-as"]')).toBeNull();
    expectNothingOpenedInBrowser();
  });

  it('shows the provider buttons on the settled screen under Reduce Motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    stubContinuationInvoke();
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });

    await flushUntil(() => providerButtons().length === 2);

    expectPreBranchProviderScreen();
    expectNothingOpenedInBrowser();
  });

  it('opens the browser only when Google is clicked, with no continuation to wait on', async () => {
    stubContinuationInvoke();
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
    await revealSignIn();
    expectNothingOpenedInBrowser();

    providerButtons()[0]?.click();
    flushSync();

    // The click starts OAuth synchronously: nothing is awaited before it.
    expect(tauri.invoke).toHaveBeenCalledWith('start_oauth_login', { provider: 'Google' });
    expect(providerButtons()[0]?.disabled).toBe(true);
    expect(host.textContent).toContain('A browser window opened for Google sign-in.');

    await flushUntil(() => tauri.open.mock.calls.length > 0);
    expect(tauri.open).toHaveBeenCalledTimes(1);
    expect(tauri.open.mock.calls[0]?.[0]).toBe('https://placeholder.test/authorize');
    expect(continuationAttemptCalls()).toEqual([]);

    await flushUntil(
      () =>
        host.querySelector('[data-testid="onboarding-directory"]')?.classList.contains('on') ===
        true,
    );
    expect(tauri.invoke).toHaveBeenCalledWith('oauth_exchange_code', { code: 'placeholder-code' });
  });

  it('starts Microsoft sign-in with the Microsoft provider', async () => {
    stubContinuationInvoke();
    component = mount(OnboardingWizard, { target: host, props: { initialStep: 0 } });
    await revealSignIn();

    providerButtons()[1]?.click();
    flushSync();

    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'start_oauth_login',
      expect.objectContaining({ provider: 'Microsoft' }),
    );
    const email = host.querySelector<HTMLInputElement>('[data-testid="microsoft-email"]');
    expect(email).not.toBeNull();
    email!.value = 'scottallen@dim6fitness.com';
    email!.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="microsoft-email-continue"]')?.click();
    flushSync();

    expect(tauri.invoke).toHaveBeenCalledWith('start_oauth_login', {
      provider: 'Microsoft',
      email: 'scottallen@dim6fitness.com',
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith('start_oauth_login', { provider: 'Google' });
  });

  it('records completion without abandonment when finishing unmounts the wizard', async () => {
    const onfinish = vi.fn(async () => {
      if (component === null) throw new Error('Expected the wizard to be mounted before finish.');
      await unmount(component);
      component = null;
    });
    mountWizard(onfinish, CONNECTOR_IMPORT_STEP_INDEX);
    await flush();

    primaryButton().click();
    // Finishing records the usage-data answer first (its own `consent`
    // completion), then the finish itself.
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { action?: string } }).properties?.action === 'completed' &&
          (args as { properties?: { outcome?: string } }).properties?.outcome === 'finished',
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
    mountWizard(onfinish, CONNECTOR_IMPORT_STEP_INDEX);
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
    await revealSignIn();

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
    await revealSignIn();
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
    mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX, { ...NO_AI_TOOLS, claude_desktop: true, any: true });
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

    // The inline launch error gives the next step. Product decision
    // (2026-09-27): no Advanced section or manual tools any more, so the
    // message must not point at them.
    const summary = host.querySelector('[data-testid="onboarding-summary"]');
    const escape = host.querySelector('[data-testid="onboarding-escape"]');
    expect(escape).not.toBeNull();
    expect(escape?.textContent).toContain('Open the folder and run /setup');
    expect(escape?.textContent).toContain('HQ Desktop');
    expect(escape?.textContent).not.toMatch(/Reveal|copy the command|below/i);
    expect(summary?.querySelector('[data-testid="onboarding-advanced"]')).toBeNull();
    expect(summary?.textContent).not.toContain('Reveal folder');
    expect(summary?.textContent).not.toContain('Copy /setup');
    // HQ Desktop is still there to finish with.
    expect(readyButton('onboarding-open-desktop').disabled).toBe(false);
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

  it('offers HQ Desktop as the primary card and installed tools as smaller buttons under it', async () => {
    // Product decision (2026-09-27): HQ Desktop is the large white card.
    // Claude Code and Codex are smaller secondary pill buttons under it, and
    // only for tools detection says are installed. Same test ids, same
    // handoff. There is no Advanced section.
    mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX, {
      ...NO_AI_TOOLS,
      claude_desktop: true,
      codex_cli: true,
      grok_cli: true,
      any: true,
    });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-codex"]')),
    );
    expect(host.querySelector('[data-testid="onboarding-summary"]')?.textContent).not.toContain(
      'Complete setup in your AI tool',
    );

    const row = host.querySelector('[data-testid="onboarding-launchers"]');
    expect(row).not.toBeNull();
    const desktop = row!.querySelector<HTMLButtonElement>('.tool-card')!;
    expect(row!.querySelectorAll('.tool-card')).toHaveLength(1);
    expect(desktop.dataset.testid).toBe('onboarding-open-desktop');
    expect(desktop.classList.contains('tool-card-desktop')).toBe(true);
    expect(desktop.querySelector('.tc-name')?.textContent?.trim()).toBe('HQ Desktop');
    expect(desktop.querySelector('.tc-line')?.textContent?.trim()).toBe('Use HQ’s own app');

    // The installed tools (never Grok), as secondary pills, in this order.
    const pills = Array.from(row!.querySelectorAll<HTMLButtonElement>('.tool-pill'));
    expect(pills.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Open in Claude Code',
      'Open in Codex',
    ]);
    expect(pills.map((button) => button.textContent?.trim())).toEqual(['Claude Code', 'Codex']);
    for (const pill of pills) expect(pill.querySelector('svg')).not.toBeNull();
    expect(row!.textContent).not.toMatch(/\bFinish\b/);
    // No Advanced section and no install links on the ready screen.
    expect(host.querySelector('[data-testid="onboarding-advanced"]')).toBeNull();
    expect(host.querySelector('[data-testid^="onboarding-install-"]')).toBeNull();
    // The usage-data line comes after the options.
    const consent = host.querySelector('[data-testid="ready-consent"]')!;
    expect(row!.compareDocumentPosition(consent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no tool button and no install link when neither tool is installed', async () => {
    mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'detect_ai_tools'),
    );
    await flush();
    await flush();

    const row = host.querySelector('[data-testid="onboarding-launchers"]')!;
    expect(row.querySelectorAll('.tool-pill')).toHaveLength(0);
    expect(row.querySelector('.tool-pills')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-launch-claude"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-launch-codex"]')).toBeNull();
    expect(host.querySelector('[data-testid^="onboarding-install-"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-launch-download"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-advanced"]')).toBeNull();
    // HQ Desktop and the usage-data line are still offered.
    expect(primaryButton().getAttribute('aria-label')).toBe('Open HQ Desktop');
    expect(host.querySelector('[data-testid="ready-consent"]')).not.toBeNull();
  });

  it('shows only the installed tool when just one is installed', async () => {
    mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX, { ...NO_AI_TOOLS, codex_desktop: true, any: true });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-codex"]')),
    );
    const pills = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding-launchers"] .tool-pill'),
    );
    expect(pills.map((pill) => pill.dataset.testid)).toEqual(['onboarding-launch-codex']);
    // No button and no install link for the uninstalled tool.
    expect(host.querySelector('[data-testid="onboarding-launch-claude"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-install-claude"]')).toBeNull();
  });

  it('shows no tool buttons while detection is still pending', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return new Promise<never>(() => {});
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: CONNECTOR_IMPORT_STEP_INDEX } });
    await flush();
    await flush();
    expect(host.querySelectorAll('[data-testid="onboarding-launchers"] .tool-pill')).toHaveLength(0);
    expect(host.querySelector('[data-testid^="onboarding-install-"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-launch-download"]')).toBeNull();
    expect(primaryButton()).not.toBeNull();
  });

  it('adds a tool button once a re-check finds the tool installed', async () => {
    let tools = NO_AI_TOOLS;
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return tools;
        default:
          return undefined;
      }
    });
    component = mount(OnboardingWizard, { target: host, props: { initialStep: CONNECTOR_IMPORT_STEP_INDEX } });
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'detect_ai_tools'),
    );
    await flush();
    expect(host.querySelector('[data-testid="onboarding-launch-claude"]')).toBeNull();

    tools = { ...NO_AI_TOOLS, claude_desktop: true, any: true };
    // The ready screen re-probes every 3s while no tool is installed.
    await vi.advanceTimersByTimeAsync(3000);
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-claude"]')),
    );
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

  it('starts the usage data checkbox on Share, so finishing works without a click', async () => {
    // Product decision (2026-09-27): the question is a checkbox on the ready
    // screen, checked (Share) by default.
    mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX, NO_AI_TOOLS);
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="ready-consent-share"]')),
    );
    const share = host.querySelector<HTMLInputElement>('[data-testid="ready-consent-share"]');
    expect(share?.checked).toBe(true);
    expect(host.querySelector('[data-testid="onboarding-consent"]')).toBeNull();
    expect(primaryButton().disabled).toBe(false);
  });

  it('renders the same seamless completion screen after a failed required stage as after a clean run', async () => {
    const claudeDesktopOnly = {
      ...NO_AI_TOOLS,
      claude_desktop: true,
      any: true,
    };
    mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX, claudeDesktopOnly);
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-claude"]')),
    );
    const cleanCompletion = stableMarkup(
      host.querySelector<HTMLElement>('[data-testid="onboarding-summary"]'),
    );
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

    // The install runs in the background while the person is on the story
    // screens. Let it settle (the failed stage is recorded, not shown), then
    // skip on to the ready screen, as a person would.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="welcome-skip"]')?.click();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() =>
      Boolean(
        host.querySelector('[data-testid="onboarding-summary"]')?.classList.contains('on') &&
          host.querySelector('[data-testid="onboarding-launch-claude"]'),
      ),
    );

    const summary = host.querySelector<HTMLElement>('[data-testid="onboarding-summary"]');
    const launchClaude = host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-launch-claude"]',
    );
    // Same screen, byte for byte, apart from where its entrance animation is.
    expect(stableMarkup(summary)).toBe(cleanCompletion);
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
    expect(tauri.invoke).toHaveBeenCalledWith('record_install_complete');

    launchClaude?.click();
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    // Finishing records the usage-data answer before the handoff.
    await flushUntil(() => onfinish.mock.calls.length > 0);

    expect(tauri.invoke).toHaveBeenCalledWith('open_claude_code_link', expect.any(Object));
    expect(onfinish).toHaveBeenCalledOnce();
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
      Boolean(host.querySelector('[data-testid="welcome-skip"]')),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="welcome-skip"]')?.click();
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
    mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX, {
      ...NO_AI_TOOLS,
      codex_desktop: true,
      any: true,
    });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-codex"]')),
    );

    expect(host.querySelector('[data-testid="onboarding-install-codex"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-launch-claude"]')).toBeNull();
  });

  it('opens Codex from its own button when Claude is also installed', async () => {
    const onfinish = mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX, {
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

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string } }).properties?.step === 'connector-import',
      ),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-import"]')?.click();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string; action?: string } }).properties?.step ===
            'connector-import' &&
          (args as { properties?: { action?: string } }).properties?.action === 'failed',
      ),
    );

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

    await flushUntil(() =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { step?: string } }).properties?.step === 'connector-import',
      ).length >= 2,
    );

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
      ) as { pending?: Array<{ event: { properties: { step: string } } }> };
      return !(pending.pending ?? []).some(
        (record) => record.event.properties.step === 'connector-import',
      );
    });

    const stored = JSON.parse(localStorage.getItem(__INTERNALS__.STORAGE_KEY) ?? '{}') as {
      pending?: Array<{ event: { properties: { step: string; action: string } } }>;
    };
    expect(
      (stored.pending ?? [])
        .filter((record) => record.event.properties.step === 'connector-import')
        .map((record) => record.event.properties.action),
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

  it('uses the persisted install id for the anonymous ping and onboarding session when the first-launch flag is on', async () => {
    const installAttemptId = '22222222-2222-4222-8222-222222222222';
    onboardingFlags.hasFeature.mockResolvedValue({ ok: true, value: true });
    stubOnboardingInvoke({
      is_first_run: () => true,
      desktop_install_attempt_id: () => installAttemptId,
    });
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 0 },
    });

    await flushUntil(() => httpFetch.mock.calls.length > 0);

    const init = (httpFetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body)) as { installSessionId: string };
    const onboardingEvent = tauri.invoke.mock.calls
      .filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { eventName?: string }).eventName === 'desktop_onboarding_step',
      )
      .map(([, args]) => args as { sessionId: string })[0];
    expect(body.installSessionId).toBe(installAttemptId);
    expect(onboardingEvent?.sessionId).toBe(installAttemptId);
    const welcomeEntries = tauri.invoke.mock.calls.filter(
      ([command, args]) =>
        command === 'emit_desktop_operational_telemetry' &&
        (args as {
          eventName?: string;
          properties?: { step?: string; action?: string; outcome?: string };
        }).eventName === 'desktop_onboarding_step' &&
        (args as {
          properties?: { step?: string; action?: string; outcome?: string };
        }).properties?.step === 'welcome-signin' &&
        (args as {
          properties?: { step?: string; action?: string; outcome?: string };
        }).properties?.action === 'entered',
    );
    expect(welcomeEntries).toHaveLength(1);
    expect((welcomeEntries[0]![1] as { properties: { outcome?: string } }).properties.outcome)
      .toBe('reached-signin');
    expect(onboardingFlags.hasFeature).toHaveBeenCalledWith(
      'desktop.first-launch-signin-reach-telemetry-v1',
    );
    expect(onboardingFlags.hasFeature).toHaveBeenCalledWith(
      'desktop.first-launch-join-key-v1',
    );
  });

  it('keeps both welcome-signin entered rows on first launch when the join-key flag is off', async () => {
    onboardingFlags.hasFeature.mockResolvedValue({ ok: true, value: false });
    stubContinuationInvoke();
    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 0 },
    });

    await flushUntil(() =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as {
            eventName?: string;
            properties?: { step?: string; action?: string };
          }).eventName === 'desktop_onboarding_step' &&
          (args as {
            properties?: { step?: string; action?: string };
          }).properties?.step === 'welcome-signin' &&
          (args as {
            properties?: { step?: string; action?: string };
          }).properties?.action === 'entered',
      ).length === 2,
    );

    const welcomeEntries = tauri.invoke.mock.calls
      .filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as {
            eventName?: string;
            properties?: { step?: string; action?: string };
          }).eventName === 'desktop_onboarding_step' &&
          (args as {
            properties?: { step?: string; action?: string };
          }).properties?.step === 'welcome-signin' &&
          (args as {
            properties?: { step?: string; action?: string };
          }).properties?.action === 'entered',
      )
      .map(([, args]) => args as { properties: { flow?: string; outcome?: string } });
    expect(welcomeEntries.map((entry) => entry.properties.flow)).toEqual([
      'first_install',
      'first_launch',
    ]);
    expect(welcomeEntries.map((entry) => entry.properties.outcome)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('emits the flag-off welcome step before continuation identity preparation finishes', async () => {
    onboardingFlags.hasFeature.mockResolvedValue({ ok: true, value: false });
    stubContinuationInvoke();
    let resolveContinuationContext!: (context: typeof CONTINUATION_CONTEXT) => void;
    const unresolvedContext = new Promise<typeof CONTINUATION_CONTEXT>((resolve) => {
      resolveContinuationContext = resolve;
    });
    const invoke = tauri.invoke.getMockImplementation();
    if (!invoke) throw new Error('Expected the continuation invoke stub to be installed.');
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === 'desktop_continuation_context'
        ? unresolvedContext
        : invoke(command, args),
    );

    component = mount(OnboardingWizard, {
      target: host,
      props: { initialStep: 0 },
    });

    await flushUntil(() =>
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as {
            eventName?: string;
            properties?: { step?: string; action?: string };
          }).eventName === 'desktop_onboarding_step' &&
          (args as {
            properties?: { step?: string; action?: string };
          }).properties?.step === 'welcome-signin' &&
          (args as {
            properties?: { step?: string; action?: string };
          }).properties?.action === 'entered',
      ),
    );
    expect(
      tauri.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'emit_desktop_operational_telemetry' &&
          (args as { properties?: { flow?: string } }).properties?.flow !== 'first_launch',
      ),
    ).toHaveLength(1);

    resolveContinuationContext(CONTINUATION_CONTEXT);
  });

  it('persists queued step telemetry synchronously on pagehide while identity is unresolved', async () => {
    const unresolvedIdentity = new Promise<unknown>(() => undefined);
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'is_first_run':
          return unresolvedIdentity;
        case 'emit_desktop_operational_telemetry':
          return unresolvedIdentity;
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
      props: { initialStep: 0 },
    });

    await flush();
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    await flush();

    const stored = JSON.parse(localStorage.getItem(__INTERNALS__.STORAGE_KEY) ?? '{}') as {
      pending?: Array<{ event: { properties: { step: string; action: string } } }>;
    };
    expect(stored.pending).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          properties: expect.objectContaining({
            step: 'welcome-signin',
            action: 'entered',
          }),
        }),
      }),
    );
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
    const onfinish = mountWizard(vi.fn(), CONNECTOR_IMPORT_STEP_INDEX, { ...NO_AI_TOOLS, claude_desktop: true, any: true });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-open-desktop"]')));

    readyButton('onboarding-open-desktop').click();
    // Finishing records the usage-data answer first.
    await flushUntil(() => onfinish.mock.calls.length > 0);

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

  /** Back to the folder choice from the first explainer (the flow's Back). */
  function clickBack(): void {
    const button = host.querySelector<HTMLButtonElement>('[data-testid="welcome-back"]');
    if (!button) throw new Error('Expected the welcome flow Back button.');
    button.click();
  }

  /** Leave the setup step, then come back through Install here. */
  async function leaveAndReturn(): Promise<void> {
    clickBack();
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
    clickBack();
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
        case 'detect_hq':
          return { exists: false, isHq: false, nonEmpty: false };
        case 'check_writable':
          return true;
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
        case 'detect_hq':
          return { exists: false, isHq: false, nonEmpty: false };
        case 'check_writable':
          return true;
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
        case 'detect_hq':
          return { exists: false, isHq: false, nonEmpty: false };
        case 'check_writable':
          return true;
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
  // The install runs in the background while the person walks the story. The
  // optional follow-on steps are offered once the install is done AND the
  // person has reached the ready screen, which is also where the usage-data
  // question now lives (there is no separate consent screen in first run).
  async function reachPostSetupStep(enabled: boolean): Promise<void> {
    onboardingFlags.firstFolderSyncEnabled = enabled;
    mountWizard(vi.fn(), SETUP_STEP_INDEX);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
    await skipToReady();
  }

  it('keeps the passed setup flow on the ready screen (with its consent line) when the flag is off', async () => {
    await reachPostSetupStep(false);

    expect(host.querySelector('[data-testid="onboarding-first-folder-sync"]')).toBeNull();
    expectReadyWithConsent();
    expect(firstFolderSyncActions()).toEqual([]);
    expect(onboardingFlags.startSync).not.toHaveBeenCalled();
  });

  it('shows the gated step once and lets the person skip to the ready screen and its consent line', async () => {
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

    expectReadyWithConsent();
    expect(firstFolderSyncActions()).toEqual(['entered', 'skipped']);
    expect(onboardingFlags.startSync).not.toHaveBeenCalled();
  });

  it('waits for the ready screen before offering the step, so the story is never interrupted', async () => {
    onboardingFlags.firstFolderSyncEnabled = true;
    mountWizard(vi.fn(), SETUP_STEP_INDEX);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    // The install finished while the person is still on the explainers.
    expect(host.querySelector('.hq-welcome')?.getAttribute('data-current-scene')).toBe('cloud');
    expect(
      host.querySelector('[data-testid="onboarding-first-folder-sync"]')?.classList.contains('on'),
    ).toBe(false);
    expect(firstFolderSyncActions()).toEqual([]);

    await skipToReady();
    expect(host.querySelector('.hq-welcome')?.getAttribute('data-current-scene')).toBe(
      'first-folder',
    );
    expect(firstFolderSyncActions()).toEqual(['entered']);
  });

  it('offers the connector import only after the first-folder step, then settles on ready', async () => {
    await reachPostSetupStep(true);
    const connectorChecks = () =>
      tauri.invoke.mock.calls.filter(
        ([command]) => command === 'detect_claude_desktop_connectors',
      ).length;
    expect(connectorChecks()).toBe(0);

    host.querySelector<HTMLButtonElement>(
      '[data-testid="onboarding-first-folder-sync-skip"]',
    )?.click();
    await flushUntil(() => connectorChecks() > 0);
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expectReadyWithConsent();
    // Each follow-on step is offered once: back on ready, nothing reopens.
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(firstFolderSyncActions()).toEqual(['entered', 'skipped']);
    expect(host.querySelector('.hq-welcome')?.getAttribute('data-current-scene')).toBe('ready');
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

  function stubProvisioning(answer: { ok: boolean; bucketName?: string; error?: string }, gate?: Promise<void>): void {
    const fallback = tauri.invoke.getMockImplementation();
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'activate_company_cloud') {
        if (gate) await gate;
        if (!answer.ok) throw new Error(answer.error ?? 'failed');
        return { bucketName: answer.bucketName };
      }
      return fallback?.(command, args);
    });
  }

  const missingBucket = 'Entity cmp_01ABC (newco) has no bucket provisioned. Run VLT-2 bucket provisioning first.';

  it('self-heals a company with no bucket: "Finishing setup…", provisions, then syncs again', async () => {
    await reachPostSetupStep(true);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubProvisioning({ ok: true, bucketName: 'hq-vault-newco' }, gate);
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-first-folder-sync-start"]')?.click();
    await flush();
    emitTauriEvent('sync:error', { company: 'newco', path: '(company)', message: missingBucket });
    emitTauriEvent('sync:all-complete', { companiesAttempted: 1, filesDownloaded: 0, bytesDownloaded: 0, errors: [] });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-first-folder-finishing-setup"]')));
    expect(host.textContent).toContain('Finishing setup…');
    expect(host.textContent).not.toContain('has no bucket provisioned');
    release();
    await flushUntil(() => (onboardingFlags.startSync as ReturnType<typeof vi.fn>).mock.calls.length === 2);
    expect(tauri.invoke).toHaveBeenCalledWith('activate_company_cloud', { companyUid: 'cmp_01ABC' });
    emitTauriEvent('sync:all-complete', { companiesAttempted: 1, filesDownloaded: 1, bytesDownloaded: 1, errors: [] });
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    const heal = tauri.invoke.mock.calls.flatMap(([command, raw]) => {
      const args = raw as { eventName?: string; properties?: Record<string, unknown> };
      return command === 'emit_desktop_operational_telemetry' && args.properties?.selfHeal ? [args.properties] : [];
    });
    expect(heal.map((row) => row.selfHeal)).toEqual(['triggered', 'succeeded']);
    expect(heal[0]?.companyUid).toBe('cmp_01ABC');
    expect(firstFolderSyncActions()).toContain('completed');
  });

  it('shows "Finishing setup…" while provisioning and keeps Try again working when it fails', async () => {
    await reachPostSetupStep(true);
    stubProvisioning({ ok: false, error: '[server_error] Request failed (status 500)' });
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-first-folder-sync-start"]')?.click();
    await flush();
    emitTauriEvent('sync:all-complete', {
      companiesAttempted: 1,
      filesDownloaded: 0,
      bytesDownloaded: 0,
      errors: [{ company: 'newco', message: missingBucket }],
    });
    await flushUntil(() => Boolean(host.querySelector('[role="alert"]')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not sync this folder');
    expect(host.textContent).not.toContain('VLT-2');
    const failed = tauri.invoke.mock.calls.flatMap(([command, raw]) => {
      const args = raw as { properties?: Record<string, unknown> };
      return command === 'emit_desktop_operational_telemetry' && args.properties?.selfHeal === 'failed' ? [args.properties] : [];
    });
    expect(failed[0]).toMatchObject({ provisioningStep: 'activate-cloud:server_error', companyUid: 'cmp_01ABC' });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="onboarding-first-folder-sync-start"]');
    expect(button?.disabled).toBe(false);
    button?.click();
    await flush();
    expect(onboardingFlags.startSync).toHaveBeenCalledTimes(2);
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

    expectReadyWithConsent();
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
    // A paid company skips the company step (look before create), so these
    // scenarios go straight to the follow-on steps they exercise.
    teamPlanEnabled: true,
  };

  async function reachInviteScenario(options: {
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
    await skipToReady();
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

  it('shows the invite step for a one-member company without a feature flag', async () => {
    await reachInviteScenario();

    expect(host.querySelector('[data-testid="onboarding-invite-teammate"]')).not.toBeNull();
    expect(onboardingFlags.hasFeature).toHaveBeenCalledWith(
      'desktop.first-folder-sync-step-v1',
    );
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
      host.querySelector('[data-testid="onboarding-summary"]')?.classList.contains('on'),
    ).toBe(false);
  });

  it('lets Skip continue to the ready screen and its consent line immediately', async () => {
    await reachInviteScenario();

    clickInviteControl('onboarding-invite-skip');
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expectReadyWithConsent();
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
    await flushUntil(() => operationalRows('desktop_invite_sent').length > 0);
    expect(operationalRows('desktop_invite_sent')).toEqual([{ count: 1 }]);
    expect(operationalRows('desktop_invite_failed')).toEqual([]);
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
          row.action === 'failed' && row.errorKind === 'email_delivery_failed',
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

  async function submitInvite(): Promise<void> {
    const email = host.querySelector<HTMLInputElement>(
      '[data-testid="onboarding-invite-email"]',
    );
    if (!email) throw new Error('Expected the invite email field.');
    email.value = inviteEmail;
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="onboarding-invite-send"]')?.click();
  }

  function inviteRequestBodies(): Array<Record<string, unknown>> {
    return tauri.invoke.mock.calls
      .filter(
        ([command, args]) =>
          command === 'hq_pro_fetch' &&
          (args as { url?: string })?.url === '/membership/invite',
      )
      .map(([, args]) => JSON.parse((args as { body: string }).body));
  }

  it('resends instead of failing when the address already has a pending invite (409)', async () => {
    await reachInviteScenario({
      inviteResponses: [
        {
          status: 409,
          body: { error: 'Membership already exists', code: 'MEMBERSHIP_ALREADY_EXISTS' },
        },
        { status: 200, body: { resent: true, emailSent: true, emailSkipped: false } },
      ],
    });
    await submitInvite();
    await flushUntil(() =>
      host.textContent?.includes('This person was already invited. HQ sent the invitation again.') ===
      true,
    );

    expect(host.textContent).not.toContain('HQ could not send the invitation');
    expect(host.querySelector('[data-testid="onboarding-invite-error"]')).toBeNull();
    const bodies = inviteRequestBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ sendEmail: true });
    expect(bodies[1]).toMatchObject({
      companyUid: 'cmp_demo',
      inviteeEmail: inviteEmail,
      resend: true,
    });
    expect(bodies[1]).not.toHaveProperty('sendEmail');
    const rows = inviteStepRows();
    expect(rows.some((row) => row.action === 'failed')).toBe(false);
    expect(rows.some((row) => row.action === 'completed' && row.outcome === 'resent')).toBe(true);
  });

  it('says the person is already a member when the 409 has no pending invite to resend', async () => {
    await reachInviteScenario({
      inviteResponses: [
        { status: 409, body: { code: 'MEMBERSHIP_ALREADY_EXISTS' } },
        { status: 404, body: { code: 'INVITE_NOT_PENDING' } },
      ],
    });
    await submitInvite();
    await flushUntil(() =>
      host.querySelector('[data-testid="onboarding-invite-error"]') !== null,
    );

    expect(host.textContent).toContain('This person is already a member of your company.');
    expect(
      inviteStepRows().some(
        (row) =>
          row.action === 'failed' && row.errorKind === 'already_member' && row.statusCode === 404,
      ),
    ).toBe(true);
  });

  it('names a plan limit and records its errorKind and HTTP status', async () => {
    await reachInviteScenario({
      inviteResponses: [{ status: 402, body: { error: 'plan limit', code: 'PLAN_LIMIT' } }],
    });
    await submitInvite();
    await flushUntil(() =>
      host.querySelector('[data-testid="onboarding-invite-error"]') !== null,
    );

    expect(host.textContent).toContain('Your plan has no free seats for another teammate.');
    expect(host.textContent).not.toContain('HQ could not send the invitation.');
    expect(inviteRequestBodies()).toHaveLength(1);
    expect(
      inviteStepRows().some(
        (row) =>
          row.action === 'failed' && row.errorKind === 'plan_limit' && row.statusCode === 402,
      ),
    ).toBe(true);
    expect(operationalRows('desktop_invite_failed')).toEqual([
      { count: 1, errorClass: 'plan_limit' },
    ]);
    expect(operationalRows('desktop_invite_sent')).toEqual([]);
  });

  it('names an invalid email address', async () => {
    await reachInviteScenario({
      inviteResponses: [{ status: 400, body: { error: 'Invalid inviteeEmail' } }],
    });
    await submitInvite();
    await flushUntil(() =>
      host.querySelector('[data-testid="onboarding-invite-error"]') !== null,
    );
    expect(host.textContent).toContain('HQ could not use that email address.');
    expect(
      inviteStepRows().some((row) => row.errorKind === 'invalid_email' && row.statusCode === 400),
    ).toBe(true);
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
    expect(rows.find((row) => row.action === 'completed')?.invitesSent).toBe(1);
    expect(rows.some((row) => 'email' in row || 'inviteeEmail' in row)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(inviteEmail);
  });

  it('records a skipped invite step with its company scope', async () => {
    await reachInviteScenario();
    clickInviteControl('onboarding-invite-skip');
    await flush();

    const rows = inviteStepRows();
    expect(rows.map((row) => row.action)).toEqual(['entered', 'skipped']);
    expect(rows.every((row) => row.companyUid === 'cmp_demo')).toBe(true);
  });

  it('records a failed invite step with its company scope', async () => {
    await reachInviteScenario({
      inviteResponses: [{ status: 500, body: { error: 'temporary failure' } }],
    });
    await submitInvite();
    await flushUntil(() => host.querySelector('[data-testid="onboarding-invite-error"]') !== null);

    const rows = inviteStepRows();
    expect(rows.map((row) => row.action)).toEqual(['entered', 'failed']);
    expect(rows.every((row) => row.companyUid === 'cmp_demo')).toBe(true);
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

  it('renews the deps inactivity timeout for installer output', async () => {
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

  it('renews the deps inactivity timeout for matching preflight installer output', async () => {
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

    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps') - 1);
    emitTauriEvent('install:progress', {
      handle: 'preflight',
      setupRunId: installArgs.failureScope.setupRunId,
      line: '[node] downloading installer',
    });
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps') - 1);
    await flush();

    expect(timeoutFailures()).toHaveLength(0);
    resolveInstall?.();
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
  });

  it('renews the content inactivity timeout for download progress', async () => {
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

  it('renews the indexing inactivity timeout for reindex output', async () => {
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

  it('continues timing out at the hard elapsed ceiling despite ongoing progress', async () => {
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
    // The timed-out stage does not hold the flow: the install settles in the
    // background and the person reaches the ready screen (which carries the
    // usage-data line; first run has no separate consent screen).
    await skipToReady();
    expectReadyWithConsent();
  });

  function sampleProgress(): ProgressSample {
    const panel = host.querySelector('[data-testid="onboarding-setup"]');
    const elapsed = host.querySelector(
      '[data-testid="onboarding-setup-elapsed"]',
    )?.textContent;
    const seconds = elapsed?.match(/(\d+)s/)?.[1];
    return {
      // Layout change: the ring's percent label became the install card's bar,
      // which carries the same tracked percent as its progressbar value.
      percent: Number.parseInt(
        host
          .querySelector('[data-testid="onboarding-setup-progress"]')
          ?.getAttribute('aria-valuenow') ?? '',
        10,
      ),
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

describe('company onboarding step', () => {
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

  async function reachCompanyScenario(options: {
    memberships?: Array<Record<string, unknown>>;
    companyMembers?: Array<Record<string, unknown>>;
    membershipFailures?: number;
    companyRouteLookupRetryEnabled?: boolean;
    /** Keep the install running (initial sync never finishes) and stop on the explainers. */
    holdInstall?: boolean;
    /** Delay, in ms, before GET /membership/me answers. */
    membershipDelayMs?: number;
    pendingInvites?: Array<{ slug: string; displayName: string }>;
    checkout?: { status: number; body: unknown };
    /** Whether GET /entity/cmp_new reports the new company provisioned. */
    provisioned?: boolean;
    /** Polls of GET /entity/cmp_new that answer "provisioning" before it is ready. */
    pendingPolls?: number;
    /** Every GET /entity/cmp_new answers failed at this step (until a provision call). */
    failedStep?: string;
    /** Extra GET /entity/{uid} answers keyed by uid. */
    entities?: Record<string, Record<string, unknown>>;
    pendingByEmail?: Array<Record<string, unknown>>;
    claimResult?: Record<string, unknown>;
    anonId?: string | null;
    anonLookup?: Record<string, unknown>;
    createError?: string;
    signedInEmail?: string;
    /** Extra top-level fields on GET /membership/me (e.g. a plan picked on the website). */
    membershipExtra?: Record<string, unknown>;
    /** Answer for check_company_slug; defaults to every handle free. */
    slugAnswer?: (slug: string) => Record<string, unknown>;
    companyNamePrefillEnabled?: boolean;
  } = {}): Promise<void> {
    onboardingFlags.firstFolderSyncEnabled = false;
    onboardingFlags.companyNamePrefillEnabled = options.companyNamePrefillEnabled ?? false;
    onboardingFlags.companyRouteLookupRetryEnabled = options.companyRouteLookupRetryEnabled ?? false;
    let entityPolls = 0;
    let provisionCalled = false;
    let activations = 0;
    let membershipReads = 0;
    mountWizard(vi.fn(), SETUP_STEP_INDEX);
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'resolve_hq_path':
          return '/Users/test/hq';
        case 'detect_ai_tools':
          return NO_AI_TOOLS;
        case 'list_syncable_workspaces':
          return {
            workspaces: (options.pendingInvites ?? []).map((invite) => ({
              ...invite,
              kind: 'company',
              state: 'cloud-only',
              membershipStatus: 'pending',
              cloudUid: `cmp_${invite.slug}`,
            })),
          };
        case 'claim_pending_company_invite':
          return options.claimResult ?? { ok: true, claimedSlugs: [args?.companySlug], message: 'Joined' };
        case 'web_visitor_anon_id':
          return options.anonId ?? null;
        case 'start_initial_cloud_sync':
          return options.holdInstall ? new Promise<never>(() => {}) : undefined;
        case 'activate_company_cloud':
          activations += 1;
          // The create flow's own activation happens once; only a retry flips the entity.
          if (activations > 1 || !options.failedStep) provisionCalled = activations > 1;
          return { activated: true };
        case 'get_auth_state':
          return options.signedInEmail
            ? { authenticated: true, email: options.signedInEmail }
            : { authenticated: false };
        case 'run_card_action':
          if (args?.cardId === 'companies_summary') {
            throw new Error('[not_found] Request failed (status 404)');
          }
          if (options.createError && args?.cardId === 'card_create_company') {
            throw new Error(options.createError);
          }
          return { state: 'done', companyUid: 'cmp_new', companyChannelId: 'ch_new' };
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
        case 'check_company_slug':
          return (
            options.slugAnswer?.(String(args?.slug ?? '')) ?? {
              valid: true,
              available: true,
              normalized: args?.slug,
              suggestion: null,
              reasons: [],
            }
          );
        case 'run_company_tab_action':
          return { state: 'done' };
        case 'hq_pro_fetch': {
          if (args?.url === '/membership/me') {
            membershipReads += 1;
            if (options.membershipDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, options.membershipDelayMs));
            }
            if (membershipReads <= (options.membershipFailures ?? 0)) {
              throw new Error('temporary membership lookup failure');
            }
            return {
              status: 200,
              body: JSON.stringify({ ...(options.membershipExtra ?? {}), memberships: options.memberships ?? [] }),
            };
          }
          if (typeof args?.url === 'string' && args.url.startsWith('/membership/me?anonId=')) {
            return { status: 200, body: JSON.stringify(options.anonLookup ?? { memberships: [] }) };
          }
          if (args?.url === '/membership/company/cmp_demo' && options.companyMembers) {
            return { status: 200, body: JSON.stringify({ members: options.companyMembers }) };
          }
          if (args?.url === '/membership/pending-by-email') {
            return { status: 200, body: JSON.stringify({ invites: options.pendingByEmail ?? [] }) };
          }
          if (typeof args?.url === 'string' && args.url.startsWith('/entity/') && args.url !== '/entity/cmp_new') {
            const uid = args.url.slice('/entity/'.length);
            const entity = options.entities?.[uid];
            if (entity) {
              const ready = provisionCalled || entityPolls++ >= (options.pendingPolls ?? 0);
              return {
                status: 200,
                body: JSON.stringify({ entity: ready ? { ...entity, status: 'active', bucketName: 'hq-vault-x' } : entity }),
              };
            }
            return { status: 404, body: '{}' };
          }
          if (args?.url === '/entity/cmp_new' && options.failedStep && !provisionCalled) {
            return {
              status: 200,
              body: JSON.stringify({
                entity: { uid: 'cmp_new', provisioningStatus: 'failed', provisioningFailedStep: options.failedStep },
              }),
            };
          }
          if (args?.url === '/entity/cmp_new') {
            const pendingPoll = entityPolls++ < (options.pendingPolls ?? 0);
            const ready = (options.provisioned ?? true) && !pendingPoll;
            return {
              status: 200,
              body: JSON.stringify({
                entity: {
                  uid: 'cmp_new',
                  status: ready ? 'active' : 'provisioning',
                  bucketName: ready ? 'hq-vault-cmp-new' : '',
                },
              }),
            };
          }
          if (args?.url === '/v1/billing/checkout/team') {
            const answer = options.checkout ?? {
              status: 200,
              body: { url: 'https://checkout.stripe.com/c/pay/cs_test' },
            };
            return { status: answer.status, body: JSON.stringify(answer.body) };
          }
          return { status: 200, body: '{}' };
        }
        default:
          return undefined;
      }
    });

    await vi.advanceTimersByTimeAsync(1_000);
    if (options.holdInstall) {
      await flushUntil(() =>
        tauri.invoke.mock.calls.some(([command]) => command === 'start_initial_cloud_sync'),
      );
      return;
    }
    await flushUntil(() =>
      tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete'),
    );
    await skipToReady();
  }

  /** Next on the screen that is on show. */
  async function nextOnScreen(): Promise<void> {
    const button = [...host.querySelectorAll<HTMLButtonElement>('.scene.on button.btn-primary')].find(
      (candidate) => candidate.textContent?.trim() === 'Next',
    );
    if (!button) throw new Error('Expected a Next button on the screen on show.');
    button.click();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
  }

  function onScreen(sceneId: string): boolean {
    return host.querySelector(`.scene[data-scene="${sceneId}"]`)?.classList.contains('on') ?? false;
  }

  /** Steps in the order they were entered, from step telemetry. */
  function enteredSteps(): string[] {
    return tauri.invoke.mock.calls.flatMap(([command, rawArgs]) => {
      const args = rawArgs as { eventName?: string; properties?: Record<string, unknown> };
      return command === 'emit_desktop_operational_telemetry' &&
        args.eventName === 'desktop_onboarding_step' &&
        args.properties?.action === 'entered'
        ? [String(args.properties.step)]
        : [];
    });
  }

  it('runs the company step after the setup explainers and before the ready screen, while the install runs', async () => {
    await reachCompanyScenario({ holdInstall: true });
    expect(onScreen('cloud')).toBe(true);
    await nextOnScreen();
    expect(onScreen('shortcut')).toBe(true);
    await nextOnScreen();
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));

    // The install is still running, and "Open HQ Desktop" has not been shown.
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete')).toBe(false);
    expect(onScreen('company')).toBe(true);
    expect(onScreen('ready')).toBe(false);
    expect(enteredSteps()).not.toContain('ready');

    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')));
    click('onboarding-plan-choose-starter');
    await settle();

    // Then the ready screen, still waiting on the install.
    expect(onScreen('ready')).toBe(true);
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    const steps = enteredSteps();
    expect(steps.indexOf('company')).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf('company')).toBeLessThan(steps.indexOf('ready'));
  });

  it('hands over from the ready screen to the company step when the lookup answers late', async () => {
    await reachCompanyScenario({ holdInstall: true, membershipDelayMs: 5_000 });
    await nextOnScreen();
    await nextOnScreen();
    // Leaving the explainers waits a short while, then shows ready.
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(onScreen('ready')).toBe(true);

    await vi.advanceTimersByTimeAsync(3_000);
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    expect(onScreen('company')).toBe(true);
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'record_install_complete')).toBe(false);
  });

  it('does not show the company step to a member of a company, before or after ready', async () => {
    await reachCompanyScenario({
      holdInstall: true,
      memberships: [
        { companyUid: 'cmp_demo', companySlug: 'demo', personUid: 'prs_me', status: 'active', role: 'member' },
      ],
    });
    await nextOnScreen();
    await nextOnScreen();
    await settle();
    expect(onScreen('ready')).toBe(true);
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
  });

  function companyRows(): Array<Record<string, unknown>> {
    return tauri.invoke.mock.calls.flatMap(([command, rawArgs]) => {
      const args = rawArgs as { eventName?: string; properties?: Record<string, unknown> };
      return command === 'emit_desktop_operational_telemetry' &&
        args.eventName === 'desktop_onboarding_step' &&
        args.properties?.step === 'company'
        ? [args.properties]
        : [];
    });
  }

  function typeInto(testId: string, value: string): void {
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`);
    if (!input) throw new Error(`Expected ${testId} to render.`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function click(testId: string): void {
    const button = host.querySelector<HTMLButtonElement | HTMLInputElement>(`[data-testid="${testId}"]`);
    if (!button) throw new Error(`Expected ${testId} to render.`);
    if (button.disabled) throw new Error(`${testId} is disabled.`);
    button.click();
  }

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(400);
    await flush();
  }

  it('prefills a new company name through the user-edit path so the slug is ready', async () => {
    await reachCompanyScenario({
      signedInEmail: 'founder@acme.io',
      companyNamePrefillEnabled: true,
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    await settle();

    expect(host.querySelector<HTMLInputElement>('[data-testid="onboarding-company-field-name"]')?.value).toBe('Acme');
    // The handle field is not shown; the handle made from the prefilled name is checked and submitted.
    expect(host.querySelector('[data-testid="onboarding-company-field-slug"]')).toBeNull();
    expect(tauri.invoke).toHaveBeenCalledWith('check_company_slug', { slug: 'acme' });
    expect(host.querySelector<HTMLButtonElement>('[data-testid="onboarding-company-create"]')?.disabled).toBe(false);
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')));
    const submit = tauri.invoke.mock.calls.find(
      ([command, args]) =>
        command === 'run_card_action' && (args as { cardId?: string }).cardId === 'card_create_company',
    );
    expect((submit?.[1] as { values: Record<string, string> }).values).toMatchObject({ name: 'Acme', slug: 'acme' });
  });

  it('refreshes the hq-flags snapshot before resolving prefill on a create route after sign-in', async () => {
    await reachCompanyScenario({
      signedInEmail: 'founder@acme.io',
      companyNamePrefillEnabled: true,
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));

    expect(onboardingFlags.refreshFeatureFlags).toHaveBeenCalledTimes(1);
    const refreshIndex = onboardingFlags.refreshFeatureFlags.mock.invocationCallOrder[0];
    const prefillRead = onboardingFlags.hasFeature.mock.invocationCallOrder.find((order, index) =>
      onboardingFlags.hasFeature.mock.calls[index]?.[0] === 'desktop.company-name-prefill-v1');
    expect(prefillRead).toBeGreaterThan(refreshIndex);
  });

  it('skips the step for a person who already joined a company and selects it', async () => {
    await reachCompanyScenario({
      memberships: [
        { companyUid: 'cmp_demo', companySlug: 'demo', personUid: 'prs_me', status: 'active', role: 'member' },
      ],
    });
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'run_card_action')).toBe(false);
    expect(tauri.invoke).toHaveBeenCalledWith('set_desktop_active_company', { companySlug: 'demo' });
    const route = companyRows().find((row) => row.decision === 'joined_existing');
    expect(route).toMatchObject({ action: 'skipped', existingCompanies: 1, paidCompany: false, pendingInvites: 0, companyUid: 'cmp_demo' });
  });

  it('retries one membership lookup failure when the default-off flag is enabled', async () => {
    await reachCompanyScenario({
      membershipFailures: 1,
      companyRouteLookupRetryEnabled: true,
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));

    expect(
      tauri.invoke.mock.calls.filter(
        ([command, args]) => command === 'hq_pro_fetch' && (args as { url?: string })?.url === '/membership/me',
      ),
    ).toHaveLength(2);
    expect(host.querySelector('[data-testid="onboarding-company-field-name"]')).not.toBeNull();
    expect(onboardingFlags.hasFeature).toHaveBeenCalledWith('desktop.company-route-lookup-retry-v1');
  });

  it('uses the recovered membership read to resolve the teammate-invite step', async () => {
    await reachCompanyScenario({
      memberships: [
        { companyUid: 'cmp_demo', companySlug: 'demo', personUid: 'prs_me', status: 'active', role: 'owner', bucketName: 'b' },
      ],
      companyMembers: [{ companyUid: 'cmp_demo', personUid: 'prs_me', status: 'active' }],
      membershipFailures: 1,
      companyRouteLookupRetryEnabled: true,
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-invite-teammate"]')));

    expect(
      tauri.invoke.mock.calls.filter(
        ([command, args]) => command === 'hq_pro_fetch' && (args as { url?: string })?.url === '/membership/me',
      ),
    ).toHaveLength(2);
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) => command === 'hq_pro_fetch' && (args as { url?: string })?.url === '/membership/company/cmp_demo',
      ),
    ).toBe(true);
  });

  it('records lookup_failed after the retry and leaves the existing setup recovery as the path', async () => {
    await reachCompanyScenario({
      membershipFailures: 2,
      companyRouteLookupRetryEnabled: true,
    });
    await flushUntil(() => companyRows().some((row) => row.decision === 'lookup_failed'));

    expect(
      tauri.invoke.mock.calls.filter(
        ([command, args]) => command === 'hq_pro_fetch' && (args as { url?: string })?.url === '/membership/me',
      ),
    ).toHaveLength(2);
    expect(companyRows()).toContainEqual(expect.objectContaining({
      action: 'started',
      outcome: 'route_lookup_failed',
      decision: 'lookup_failed',
    }));
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-summary"]')?.classList.contains('on')).toBe(true);
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) => command === 'run_card_action' && (args as { cardId?: string })?.cardId === 'card_create_company',
      ),
    ).toBe(false);
  });

  it('omits unknown membership counts from lookup-failure telemetry', async () => {
    await reachCompanyScenario({
      membershipFailures: 2,
      companyRouteLookupRetryEnabled: true,
    });
    await flushUntil(() => companyRows().some((row) => row.decision === 'lookup_failed'));

    const row = companyRows().find((candidate) => candidate.decision === 'lookup_failed');
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('existingCompanies');
    expect(row).not.toHaveProperty('paidCompany');
    expect(row).not.toHaveProperty('pendingInvites');
  });

  it('keeps the original one-read behavior when the company-route retry flag is off', async () => {
    await reachCompanyScenario({ membershipFailures: 1 });

    expect(
      tauri.invoke.mock.calls.filter(
        ([command, args]) => command === 'hq_pro_fetch' && (args as { url?: string })?.url === '/membership/me',
      ),
    ).toHaveLength(1);
    expect(companyRows().some((row) => row.decision === 'lookup_failed')).toBe(false);
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    expect(onboardingFlags.hasFeature).toHaveBeenCalledWith('desktop.company-route-lookup-retry-v1');
  });

  it('skips "Name your company" for a paid company and selects it', async () => {
    await reachCompanyScenario({
      memberships: [
        { companyUid: 'cmp_paid', companySlug: 'paid', status: 'active', role: 'owner', planTier: 'team', bucketName: 'b' },
      ],
    });
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    expect(host.textContent).not.toContain('Name your company');
    expect(tauri.invoke).toHaveBeenCalledWith('set_desktop_active_company', { companySlug: 'paid' });
    expect(companyRows().find((row) => row.decision === 'paid_existing')).toMatchObject({ paidCompany: true });
  });

  it('offers "Use <name>" by default for an owned company, or "Create another"', async () => {
    await reachCompanyScenario({
      memberships: [
        { companyUid: 'cmp_mine', companySlug: 'mine', companyName: 'Mine Co', status: 'active', role: 'owner', bucketName: 'b' },
      ],
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-use-existing"]')));
    expect(host.querySelector('[data-testid="onboarding-company-use-existing"]')?.textContent).toContain('Use Mine Co');
    expect(host.querySelector('[data-testid="onboarding-company-create-another"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Name your company');
    click('onboarding-company-use-existing');
    await settle();
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    expect(tauri.invoke).toHaveBeenCalledWith('set_desktop_active_company', { companySlug: 'mine' });
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'run_card_action')).toBe(false);
    expect(
      companyRows().some((row) => row.action === 'completed' && row.decision === 'used_existing' && row.companyUid === 'cmp_mine'),
    ).toBe(true);
  });

  it('opens the create form from "Create another"', async () => {
    await reachCompanyScenario({
      memberships: [{ companyUid: 'cmp_mine', companyName: 'Mine Co', status: 'active', role: 'owner', bucketName: 'b' }],
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-create-another"]')));
    click('onboarding-company-create-another');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    expect(companyRows().some((row) => row.decision === 'created_another')).toBe(true);
  });

  it('shows "Setting up your company…" and sends invites only once provisioning is ready', async () => {
    localStorage.removeItem('hq.pendingCompanyInvites.v1');
    await reachCompanyScenario({ pendingPolls: 3 });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme Studio');
    typeInto('onboarding-company-invites', 'pat@acme.com');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-provisioning"]')));
    expect(host.textContent).toContain('Setting up your company…');
    expect(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')).toBeNull();
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'run_company_tab_action')).toBe(false);
    expect(companyRows().some((row) => row.outcome === 'company_created')).toBe(false);
    for (let i = 0; i < 10 && !host.querySelector('[data-testid="onboarding-plan-choose-starter"]'); i += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      await flush();
    }
    expect(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')).not.toBeNull();
    expect(tauri.invoke).toHaveBeenCalledWith(
      'run_company_tab_action',
      expect.objectContaining({ companyUid: 'cmp_new', values: expect.objectContaining({ email: 'pat@acme.com' }) }),
    );
    const rows = companyRows();
    expect(rows.some((row) => row.outcome === 'provisioning_wait')).toBe(true);
    expect(rows.some((row) => row.outcome === 'provisioning_ready')).toBe(true);
    expect(rows.find((row) => row.outcome === 'company_created')?.companyUid).toBe('cmp_new');
    // Only the create flow's own activation ran; no extra provisioning call.
    expect(tauri.invoke.mock.calls.filter(([command]) => command === 'activate_company_cloud')).toHaveLength(1);
    localStorage.removeItem('hq.pendingCompanyInvites.v1');
  });

  it('reports a failed provisioning step and retries provisioning, not create', async () => {
    await reachCompanyScenario({ failedStep: 'kms-create' });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-provisioning-retry"]')));
    expect(host.textContent).toContain('step: kms-create');
    expect(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')).toBeNull();
    expect(companyRows().find((row) => row.outcome === 'provisioning_failed')).toMatchObject({
      action: 'failed',
      provisioningStep: 'kms-create',
    });
    const creates = () =>
      tauri.invoke.mock.calls.filter(
        ([command, args]) => command === 'run_card_action' && (args as { cardId?: string }).cardId === 'card_create_company',
      ).length;
    expect(creates()).toBe(1);
    click('onboarding-company-provisioning-retry');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')));
    expect(tauri.invoke.mock.calls.filter(([command]) => command === 'activate_company_cloud')).toEqual([
      ['activate_company_cloud', { companyUid: 'cmp_new' }],
      ['activate_company_cloud', { companyUid: 'cmp_new' }],
    ]);
    expect(creates()).toBe(1);
  });

  it('resumes a half-finished company at "Setting up…" instead of creating a second one', async () => {
    await reachCompanyScenario({
      memberships: [{ companyUid: 'cmp_half', companySlug: 'half', companyName: 'Half', status: 'active', role: 'owner' }],
      entities: { cmp_half: { uid: 'cmp_half', status: 'provisioning' } },
      pendingPolls: 2,
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-provisioning"]')));
    expect(host.textContent).not.toContain('Name your company');
    for (let i = 0; i < 10 && !host.querySelector('[data-testid="onboarding-plan-choose-starter"]'); i += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      await flush();
    }
    expect(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')).not.toBeNull();
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) => command === 'run_card_action' && (args as { cardId?: string }).cardId === 'card_create_company',
      ),
    ).toBe(false);
    expect(companyRows().find((row) => row.decision === 'resume_setup')).toMatchObject({ existingCompanies: 1 });
  });

  it('offers to switch account when the website visitor made a company under another email', async () => {
    await reachCompanyScenario({
      signedInEmail: 'corey@gmail.com',
      anonId: 'vyg-anon-1',
      anonLookup: { memberships: [], webIdentity: { maskedEmail: 'c•••@acme.com', companyName: 'Acme' } },
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-other-account"]')));
    expect(host.textContent).toContain('Your company Acme is on c•••@acme.com.');
    expect(host.textContent).not.toContain('Name your company');
    expect(tauri.invoke).toHaveBeenCalledWith('hq_pro_fetch', expect.objectContaining({ url: '/membership/me?anonId=vyg-anon-1' }));
    expect(companyRows().find((row) => row.decision === 'company_other_account')).toBeTruthy();
    click('onboarding-company-create-here');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
  });

  it('shows the upgrade prompt inline when create hits the free plan limit', async () => {
    await reachCompanyScenario({
      createError: '[plan-limit url=https://hq.computer/billing/upgrade] Starter includes one company.',
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Second');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-plan-limit"]')));
    expect(host.textContent).toContain('Starter includes one company.');
    expect(host.querySelector('[data-testid="onboarding-company-error"]')).toBeNull();
    click('onboarding-company-plan-upgrade');
    await flush();
    expect(tauri.open).toHaveBeenCalledWith('https://hq.computer/billing/upgrade');
    expect(companyRows().some((row) => row.outcome === 'company_create_plan_limit')).toBe(true);
  });

  it('does not double "(optional)" when the server label already includes it', async () => {
    const website = createCompanyCard.fields[2];
    const original = website.label;
    website.label = "Website (optional) — we'll use its icon for your company";
    try {
      await reachCompanyScenario();
      await flushUntil(() =>
        Boolean(host.querySelector('[data-testid="onboarding-company-field-website"]')),
      );
      const websiteLabel = host.querySelector('label[for="onboarding-company-website"]')?.textContent?.trim();
      expect(websiteLabel).toBe("Website (optional) — we'll use its icon for your company");
      expect(websiteLabel?.match(/\(optional\)/g)).toHaveLength(1);
      const inviteLabel = host.querySelector('label[for="onboarding-company-invites"]')?.textContent?.trim();
      expect(inviteLabel).toBe('Invite teammates (optional)');
    } finally {
      website.label = original;
    }
  });

  it('names a company, invites a teammate, and starts on Starter', async () => {
    await reachCompanyScenario();
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')),
    );

    typeInto('onboarding-company-field-name', 'Acme Studio');
    typeInto('onboarding-company-invites', 'pat@acme.com');
    await settle();
    // No handle field: the handle is made from the name and checked quietly.
    expect(host.querySelector('[data-testid="onboarding-company-field-slug"]')).toBeNull();
    expect(host.querySelector('label[for="onboarding-company-slug"]')).toBeNull();
    expect(host.textContent).not.toContain('Company handle');
    expect(host.textContent).not.toContain('is available');
    expect(tauri.invoke).toHaveBeenCalledWith('check_company_slug', { slug: 'acme-studio' });

    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')));

    const submit = tauri.invoke.mock.calls.find(
      ([command, args]) =>
        command === 'run_card_action' && (args as { cardId?: string }).cardId === 'card_create_company',
    );
    expect((submit?.[1] as { values: Record<string, string> }).values).toEqual({
      name: 'Acme Studio',
      slug: 'acme-studio',
      website: '',
    });
    expect(tauri.invoke).toHaveBeenCalledWith(
      'run_company_tab_action',
      expect.objectContaining({
        companyUid: 'cmp_new',
        tab: 'team',
        cardId: 'team:invite',
        values: { email: 'pat@acme.com', role: 'member', inviteSurface: 'desktop' },
      }),
    );

    click('onboarding-plan-choose-starter');
    await settle();
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'hq_pro_fetch' && (args as { url?: string }).url === '/v1/billing/checkout/team',
      ),
    ).toBe(false);
    const rows = companyRows();
    expect(rows.find((row) => row.outcome === 'company_created')?.companyUid).toBe('cmp_new');
    expect(rows.some((row) => row.outcome === 'plan_starter')).toBe(true);
    expect(operationalRows('desktop_plan_selected')).toEqual([{ plan: 'starter' }]);
    expect(rows.some((row) => row.action === 'completed' && row.outcome === 'created_starter')).toBe(true);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain('pat@acme.com');
      expect(JSON.stringify(row)).not.toContain('Acme Studio');
    }
  });

  it('moves to the suggested handle by itself when the name is taken', async () => {
    await reachCompanyScenario({
      slugAnswer: (slug) =>
        slug === 'acme'
          ? { valid: true, available: false, normalized: 'acme', suggestion: 'acme-hq', reasons: ['taken'] }
          : { valid: true, available: true, normalized: slug, suggestion: null, reasons: [] },
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    await settle(); // the taken answer starts a second debounced check
    expect(tauri.invoke).toHaveBeenCalledWith('check_company_slug', { slug: 'acme' });
    expect(tauri.invoke).toHaveBeenCalledWith('check_company_slug', { slug: 'acme-hq' });
    expect(host.textContent).not.toContain('taken');
    expect(host.querySelector('[data-testid="onboarding-company-name-problem"]')).toBeNull();

    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')));
    const submit = tauri.invoke.mock.calls.find(
      ([command, args]) =>
        command === 'run_card_action' && (args as { cardId?: string }).cardId === 'card_create_company',
    );
    expect((submit?.[1] as { values: Record<string, string> }).values.slug).toBe('acme-hq');
  });

  it('adds a number to a taken handle when the server offers no suggestion', async () => {
    await reachCompanyScenario({
      slugAnswer: (slug) =>
        slug === 'acme'
          ? { valid: true, available: false, normalized: 'acme', suggestion: null, reasons: ['taken'] }
          : { valid: true, available: true, normalized: slug, suggestion: null, reasons: [] },
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    await settle(); // the taken answer starts a second debounced check
    expect(tauri.invoke).toHaveBeenCalledWith('check_company_slug', { slug: 'acme-2' });
    expect(host.querySelector<HTMLButtonElement>('[data-testid="onboarding-company-create"]')?.disabled).toBe(false);
  });

  it('asks for a different name, not a handle, when no handle can be made from it', async () => {
    await reachCompanyScenario();
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', '!!!');
    await settle();
    expect(host.querySelector('[data-testid="onboarding-company-name-problem"]')?.textContent).toContain(
      'at least one letter or number',
    );
    expect(host.querySelector('[data-testid="onboarding-company-field-name"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="onboarding-company-create"]')?.disabled).toBe(true);

    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    expect(host.querySelector('[data-testid="onboarding-company-name-problem"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="onboarding-company-create"]')?.disabled).toBe(false);
  });

  it('keeps the form, plan cards and buttons on one centered column', async () => {
    await reachCompanyScenario();
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    const actions = host.querySelector('[data-testid="onboarding-company-actions"]');
    expect(actions?.classList.contains('company-actions')).toBe(true);
    expect(actions?.classList.contains('split')).toBe(false);
    expect(host.querySelector('form.company-form')).not.toBeNull();

    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')));
    // The website's two cards, each with its own CTA and footnote; no radio
    // and no separate Continue.
    const cards = [...host.querySelectorAll('[data-testid="onboarding-plan-options"] .plan-card')];
    expect(cards.map((card) => card.querySelector('.plan-name')?.textContent)).toEqual(['Starter', 'Workforce']);
    expect(host.querySelector('[data-testid="onboarding-plan-options"] input')).toBeNull();
    expect(host.querySelector('[data-testid="onboarding-plan-continue"]')).toBeNull();
  });

  it('shows the website plan cards: price, pitch, marked rows, badge, CTAs and footnotes', async () => {
    await reachCompanyScenario();
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')));

    expect(host.querySelector('[data-testid="onboarding-company"] [data-scene-heading]')?.textContent).toBe('Choose how your HQ runs.');
    const starter = host.querySelector('[data-testid="onboarding-plan-card-starter"]')!;
    const workforce = host.querySelector('[data-testid="onboarding-plan-card-workforce"]')!;
    expect(starter.querySelector('.plan-price')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('$0 / mo');
    expect(workforce.querySelector('.plan-price')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('$500 / mo flat');
    expect(starter.querySelector('.plan-blurb')?.textContent).toBe('The shared brain for your team.');
    expect(workforce.querySelector('[data-testid="onboarding-plan-badge"]')?.textContent).toBe('Most popular');
    expect(starter.querySelector('[data-testid="onboarding-plan-badge"]')).toBeNull();
    // One mark per row, meaning what it means on the website.
    expect([...starter.querySelectorAll('.plan-row')].map((row) => row.getAttribute('data-state'))).toEqual([
      'capped',
      'off',
      'on',
      'capped',
    ]);
    expect([...workforce.querySelectorAll('.plan-row')].every((row) => row.getAttribute('data-state') === 'on')).toBe(true);
    expect(starter.querySelector('.plan-row')?.textContent).toContain('included with limits');
    expect(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')?.textContent).toBe('Get started free');
    expect(host.querySelector('[data-testid="onboarding-plan-choose-workforce"]')?.textContent).toBe('Get started');
    expect(starter.querySelector('.plan-cta-note')?.textContent).toBe('No card required to start');
    expect(workforce.querySelector('.plan-cta-note')?.textContent).toBe('Month to month · cancel anytime');

    click('onboarding-plan-book-call');
    await flush();
    expect(tauri.open).toHaveBeenCalledWith('https://hqforwork.com/call#book');
    // Booking a call leaves the person on the plan screen.
    expect(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')).not.toBeNull();
  });

  it('shows "Choose a plan" when no plan was picked on the website', async () => {
    await reachCompanyScenario();
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')));
    expect(host.textContent).toContain('Choose how your HQ runs.');
  });

  it('skips "Choose a plan" and starts on Starter when Starter was picked on the website', async () => {
    await reachCompanyScenario({ membershipExtra: { planIntent: 'free' } });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => host.querySelector('[data-testid="onboarding-company"]') === null);
    await settle();
    expect(host.textContent).not.toContain('Choose how your HQ runs.');
    expect(
      tauri.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'hq_pro_fetch' && (args as { url?: string }).url === '/v1/billing/checkout/team',
      ),
    ).toBe(false);
    const rows = companyRows();
    expect(rows.some((row) => row.outcome === 'plan_starter')).toBe(true);
    expect(rows.some((row) => row.action === 'completed' && row.outcome === 'created_starter')).toBe(true);
  });

  it('skips "Choose a plan" and opens checkout when Workforce was picked on the website', async () => {
    await reachCompanyScenario({
      anonId: 'anon_123',
      anonLookup: { memberships: [], webIdentity: { samePerson: true, plan: 'team' } },
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-checkout-done"]')));
    expect(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')).toBeNull();
    expect(tauri.open).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test');
  });

  it('falls back to the plan screen when checkout for a website-picked Workforce plan fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reachCompanyScenario({
      membershipExtra: { planIntent: 'workforce' },
      checkout: { status: 503, body: { code: 'team_signup_disabled' } },
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')));
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-error"]')));
    expect(host.querySelector('[data-testid="onboarding-plan-choose-starter"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="onboarding-company-error"]')?.textContent).toContain(
      'Workforce sign-up is paused',
    );
    warn.mockRestore();
  });

  it('opens Workforce checkout in the browser and finishes on the checkout return', async () => {
    await reachCompanyScenario();
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')),
    );
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-workforce"]')));

    click('onboarding-plan-choose-workforce');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-checkout-done"]')));

    expect(tauri.invoke).toHaveBeenCalledWith('hq_pro_fetch', {
      url: '/v1/billing/checkout/team',
      method: 'POST',
      body: JSON.stringify({
        companyUid: 'cmp_new',
        successUrl: 'hq-desktop://setup?checkout=done&company=cmp_new',
        cancelUrl: 'hq-desktop://setup',
      }),
    });
    expect(tauri.open).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test');

    // A return for some other company is not this checkout.
    emitTauriEvent('messages:open-setup', { companyUid: 'cmp_other', checkout: 'done' });
    await flush();
    expect(host.querySelector('[data-testid="onboarding-checkout-done"]')).not.toBeNull();

    emitTauriEvent('messages:open-setup', { companyUid: 'cmp_new', checkout: 'done' });
    await settle();
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    const rows = companyRows();
    expect(rows.some((row) => row.outcome === 'checkout_opened' && row.companyUid === 'cmp_new')).toBe(true);
    expect(rows.some((row) => row.outcome === 'checkout_returned' && row.companyUid === 'cmp_new')).toBe(true);
    expect(rows.some((row) => row.action === 'completed' && row.outcome === 'workforce_paid')).toBe(true);
  });

  it('keeps the person on the plan screen with a plain reason when checkout is paused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reachCompanyScenario({
      checkout: { status: 503, body: { code: 'team_signup_disabled' } },
    });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-company-field-name"]')),
    );
    typeInto('onboarding-company-field-name', 'Acme');
    await settle();
    click('onboarding-company-create');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-plan-choose-workforce"]')));
    click('onboarding-plan-choose-workforce');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-error"]')));

    expect(host.querySelector('[data-testid="onboarding-company-error"]')?.textContent).toContain(
      'Workforce sign-up is paused',
    );
    expect(tauri.open).not.toHaveBeenCalled();
    expect(companyRows().some((row) => row.action === 'failed' && row.outcome === 'checkout_failed')).toBe(true);
    warn.mockRestore();
  });

  it('lets an invited person join instead of creating a company', async () => {
    await reachCompanyScenario({ pendingInvites: [{ slug: 'acme', displayName: 'Acme' }] });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-join"]')));
    expect(host.querySelector('[data-testid="onboarding-company-join"]')?.textContent).toContain('Join Acme');

    click('onboarding-company-join');
    await settle();
    expect(tauri.invoke).toHaveBeenCalledWith('claim_pending_company_invite', {
      companySlug: 'acme',
      route: 'onboarding',
    });
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'run_card_action')).toBe(false);
    const done = companyRows().find((row) => row.action === 'completed' && row.outcome === 'joined_invite');
    expect(done).toMatchObject({ decision: 'joined_invite', companyUid: 'cmp_acme' });
    expect(tauri.invoke).toHaveBeenCalledWith('set_desktop_active_company', { companySlug: 'acme' });
    expect(host.textContent).not.toContain('Name your company');
  });

  it('never offers "Name your company" to an invited person', async () => {
    await reachCompanyScenario({ pendingInvites: [{ slug: 'acme', displayName: 'Acme' }] });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-join"]')));
    expect(host.querySelector('[data-testid="onboarding-company-create-instead"]')).toBeNull();
    expect(host.textContent).not.toContain('Name your company');
    expect(companyRows().find((row) => row.decision === 'join_invite')).toMatchObject({ pendingInvites: 1 });
  });

  it('says the invite went to a different email and offers to switch account', async () => {
    await reachCompanyScenario({
      signedInEmail: 'me@other.com',
      pendingInvites: [{ slug: 'acme', displayName: 'Acme' }],
      claimResult: { ok: true, claimedSlugs: [], message: 'No email-keyed pending invite for acme.' },
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-join"]')));
    click('onboarding-company-join');
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-invite-other-email"]')));
    expect(host.textContent).toContain('Your invite was sent to a different email.');
    click('onboarding-company-switch-account');
    await settle();
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'sign_out')).toBe(true);
    expect(host.querySelector('[data-testid="onboarding-signin"]')?.classList.contains('on')).toBe(true);
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
  });

  it('routes an invite addressed to another email straight to the switch prompt', async () => {
    await reachCompanyScenario({
      signedInEmail: 'me@other.com',
      pendingByEmail: [{ companyUid: 'cmp_acme', companyName: 'Acme', inviteeEmail: 'me@acme.com' }],
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-invite-other-email"]')));
    expect(companyRows().find((row) => row.decision === 'invite_other_email')).toBeTruthy();
  });

  it('asks the inviter to resend an expired invite', async () => {
    await reachCompanyScenario({
      pendingByEmail: [
        { companyUid: 'cmp_acme', companyName: 'Acme', inviterName: 'Pat', expiresAt: '2020-01-01T00:00:00.000Z' },
      ],
    });
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-invite-expired"]')));
    expect(host.textContent).toContain('Your invite to Acme has expired. Ask Pat to resend it');
    expect(host.textContent).not.toContain('Name your company');
    expect(companyRows().find((row) => row.decision === 'invite_expired')).toBeTruthy();
  });

  it('can be skipped', async () => {
    await reachCompanyScenario();
    await flushUntil(() => Boolean(host.querySelector('[data-testid="onboarding-company-skip"]')));
    click('onboarding-company-skip');
    await settle();
    expect(host.querySelector('[data-testid="onboarding-company"]')).toBeNull();
    expect(companyRows().some((row) => row.action === 'skipped')).toBe(true);
  });
});

describe('first-launch sign-in reach stays independent from the join-key rollout', () => {
  it('does not seed shared onboarding telemetry identity from the reach-only flag', () => {
    const source = readFileSync(join(__dirname, 'OnboardingWizard.svelte'), 'utf8');
    const reachBlock = source.slice(
      source.indexOf('if (signInReachEnabled)'),
      source.indexOf('const firstLaunchReceiptRecorded'),
    );

    expect(reachBlock).not.toContain('onboardingTelemetry.setInstallAttemptId(');
    expect(reachBlock).toContain('receiptReachOutcome ? reachInstallAttemptId ?? undefined : undefined');
  });

  it('does not use the standalone reporter when the native CI suppression marker is set', () => {
    const source = readFileSync(join(__dirname, 'OnboardingWizard.svelte'), 'utf8');
    const reachBlock = source.slice(
      source.indexOf('if (signInReachOutcome && context?.suppressFirstLaunchTelemetry !== true)'),
      source.indexOf('return { context, firstLaunchReceiptRecorded, installAttemptId }'),
    );

    expect(reachBlock).toContain('context?.suppressFirstLaunchTelemetry !== true');
  });
});
