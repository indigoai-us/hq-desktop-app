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

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: tauri.open }));

import { flushSync, mount, tick, unmount } from 'svelte';
import OnboardingWizard from './OnboardingWizard.svelte';

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

describe('onboarding launch handoff', () => {
  it('finishes onboarding after each supported launcher opens', () => {
    // Every exit routes through one guarded recovery boundary. Launcher errors
    // and native handoff errors must never be conflated.
    expect(wizardSource.match(/await onfinish\?\.\(\);/g)).toHaveLength(1);
    expect(wizardSource).toContain('async function finishWithRecovery()');
    expect(wizardSource).not.toContain('advanceTo(4)');
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

    primaryButton().click();
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
      'The tool opened, but HQ couldn’t finish setup.',
    );
    expect(recovery?.textContent).not.toContain('Could not open Claude Code');

    recovery?.querySelector<HTMLButtonElement>('button')?.click();
    await flush();

    expect(onfinish).toHaveBeenCalledTimes(2);
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'open_claude_code_link'),
    ).toHaveLength(1);
  });

  it('renders a ready-panel button for every detected tool and keeps Finish off that row', async () => {
    mountWizard(vi.fn(), 4, {
      ...NO_AI_TOOLS,
      claude_desktop: true,
      codex_cli: true,
      grok_cli: true,
      any: true,
    });
    await flushUntil(() =>
      Boolean(host.querySelector('[data-testid="onboarding-launch-grok"]')),
    );

    const row = host.querySelector('[data-testid="onboarding-launchers"]');
    expect(row).not.toBeNull();
    const labels = Array.from(row!.querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(['Open in Claude Code', 'Open in Codex', 'Open in Grok']);
    expect(row!.textContent).not.toMatch(/\bFinish\b/);
    expect(host.querySelector('[data-testid="onboarding-launch-claude"]')?.className).toContain(
      'btn-primary',
    );
    expect(host.querySelector('[data-testid="onboarding-launch-codex"]')?.className).toContain(
      'btn-secondary',
    );
  });

  it('keeps Download Claude when no AI tool is installed', async () => {
    mountWizard(vi.fn(), 4);
    await flush();
    expect(primaryButton().textContent).toBe('Download Claude');
    expect(host.querySelectorAll('[data-testid="onboarding-launchers"] button')).toHaveLength(1);
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
    mountWizard(onfinish, 9);
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

  it('uses the injected timer cadence for download watching and deep-linking', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ installed: true, logged_in: true });
    const interval = setInterval(() => void poll(), 3000);
    await vi.advanceTimersByTimeAsync(3000);
    clearInterval(interval);
    expect(poll).toHaveBeenCalledOnce();
    expect(wizardSource).toContain("invoke<ClaudeReady>('detect_claude_ready')");
    expect(wizardSource).toContain("invoke('open_claude_code_link', { url })");
    expect(wizardSource).toMatch(
      /buildClaudeCodeUrl\(\{\s+folder: installPath \?\? '',\s+prompt: '\/setup',\s+\}\)/,
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
    primaryButton().click();
    await flush();
    expect(primaryButton().textContent).toBe('Waiting for Claude…');

    await vi.advanceTimersByTimeAsync(3000);
    flushSync();
    expect(primaryButton().textContent).toBe('Waiting for Claude…');

    await vi.advanceTimersByTimeAsync(3000);
    flushSync();
    expect(primaryButton().textContent).toBe('Waiting for Claude…');

    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('open_claude_code_link', {
      url: 'claude://code/new?q=%2Fsetup&folder=%2FUsers%2Ftest%2Fhq',
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
    primaryButton().click();
    await flush();

    await vi.advanceTimersByTimeAsync(27_000);
    await flush();
    expect(tauri.invoke.mock.calls.filter(([command]) => command === 'open_claude_code_link'))
      .toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('open_claude_code_link', {
      url: 'claude://code/new?q=%2Fsetup&folder=%2FUsers%2Ftest%2Fhq',
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
    primaryButton().click();
    await flush();

    await vi.advanceTimersByTimeAsync(9000);
    await flush();
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'detect_claude_ready'),
    ).toHaveLength(3);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not open Claude Code: Claude probe unavailable',
    );

    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'detect_claude_ready'),
    ).toHaveLength(3);
  });
});
