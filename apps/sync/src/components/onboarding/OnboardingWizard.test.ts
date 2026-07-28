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

import { flushSync, mount, unmount } from 'svelte';
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
  flushSync();
}

function mountWizard(onfinish = vi.fn()): ReturnType<typeof vi.fn> {
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
    props: { initialStep: 3, onfinish },
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
    expect(wizardSource.match(/await onfinish\?\.\(\);/g)).toHaveLength(5);
    expect(wizardSource).not.toContain('advanceTo(4)');
  });

  it('renders exactly one ready-panel bottom-row button and removes Finish', () => {
    const marker = wizardSource.indexOf('data-testid="onboarding-summary"');
    const panel = wizardSource.slice(
      wizardSource.lastIndexOf('<section', marker),
      wizardSource.indexOf('</section>', marker),
    );
    const row = panel?.match(/<div class="btns">[\s\S]*?<\/div>/)?.[0];
    expect(row?.match(/<button\b/g)).toHaveLength(1);
    expect(row).toContain('class="btn btn-primary"');
    expect(row).not.toContain('Finish');
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
