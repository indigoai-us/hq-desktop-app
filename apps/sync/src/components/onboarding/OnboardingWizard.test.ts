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

const httpFetch = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  })),
);

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: tauri.open }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

import { flushSync, mount, tick, unmount } from 'svelte';

import { SETUP_DEEP_LINK_PROMPT } from '../../lib/setup-channel';
import OnboardingWizard from './OnboardingWizard.svelte';
import { BUILD_STEP_INDEX, CONNECTOR_IMPORT_STEP_INDEX } from '../../lib/onboarding-wizard';
import { __INTERNALS__ } from '../../lib/onboarding-step-telemetry';
import { __resetInstallerStepTelemetryForTests } from '../../lib/installer-step-telemetry';

const wizardSource = readFileSync('src/components/onboarding/OnboardingWizard.svelte', 'utf8');

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

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flush();
    if (predicate()) return;
  }
  throw new Error('Timed out waiting for onboarding launchers to settle.');
}

function mountWizard(
  onfinish = vi.fn(),
  initialStep = 3,
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
  tauri.open.mockResolvedValue(undefined);
  httpFetch.mockReset();
  httpFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
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

  it('finishes onboarding after each supported launcher opens', () => {
    // Every exit routes through one guarded recovery boundary. Launcher errors
    // and native handoff errors must never be conflated.
    expect(wizardSource.match(/await onfinish\?\.\(\);/g)).toHaveLength(1);
    expect(wizardSource).toContain('async function finishWithRecovery()');
    expect(wizardSource).not.toContain('advanceTo(4)');
    expect(wizardSource).not.toContain('Could not open Claude Code:');
    expect(wizardSource).not.toMatch(/#d04444|#d14343/);
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
    const advanced = host.querySelector<HTMLDetailsElement>('[data-testid="onboarding-advanced"]');
    expect(advanced).not.toBeNull();
    expect(advanced!.open).toBe(false);
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

    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-consent"] input[value="decline"]')),
    );
    host
      .querySelector<HTMLInputElement>('[data-testid="onboarding-consent"] input[value="decline"]')
      ?.click();
    host.querySelector<HTMLButtonElement>('[data-testid="consent-continue"]')?.click();
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
      props: { initialStep: 3, mode: 'consent', onfinish },
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

  it('copies a user-facing path, stripping Windows verbatim prefixes', () => {
    expect(wizardSource).toContain('toUserFacingPath');
    expect(wizardSource).toContain('userFacingInstallPath');
    expect(wizardSource).toMatch(
      /runCopyAction\(\s*'path',\s*userFacingInstallPath \?\? '~\/hq'/,
    );
    expect(wizardSource).toContain('readyCommandFor(userFacingInstallPath, aiTools)');
  });

  it('uses the injected timer cadence for download watching and deep-linking', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ installed: true, logged_in: true });
    const interval = setInterval(() => void poll(), 3000);
    await vi.advanceTimersByTimeAsync(3000);
    clearInterval(interval);
    expect(poll).toHaveBeenCalledOnce();
    expect(wizardSource).toContain("invoke<ClaudeReady>('detect_claude_ready')");
    expect(wizardSource).toContain("invoke('open_claude_code_link', { url })");
    // The deep link must NOT pre-type the `/setup` slash command: Claude
    // Desktop scans skills before a link-opened folder is trusted, so HQ's
    // project skill is not registered in the session the link creates.
    expect(wizardSource).toMatch(
      /buildClaudeCodeUrl\(\{\s+folder: installPath \?\? '',\s+prompt: SETUP_DEEP_LINK_PROMPT,\s+\}\)/,
    );
    vi.useRealTimers();
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

  it('threads whoami personUid into later pings after sign-in succeeds', async () => {
    expect(wizardSource).toContain('resolveInstallerPersonUid');
    expect(wizardSource).toContain("invokeCommand<{ personUid?: string | null }>('whoami')");
    expect(wizardSource).toContain('onboardingTelemetry.setPersonUid(uid)');
    expect(wizardSource).toContain('void resolveInstallerPersonUid()');
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
