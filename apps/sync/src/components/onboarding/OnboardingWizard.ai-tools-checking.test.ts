// @vitest-environment happy-dom

// The ready scene's inline "Checking for AI tools…" surface — shown while the
// AI-tool probe is still resolving so the person isn't left staring at a
// silently-empty tool row. Also covers the ~10s fallback with a Check again
// control and a launch clicked mid-probe.

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
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.10.365') }));
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
import { __resetInstallerStepTelemetryForTests } from '../../lib/installer-step-telemetry';

const TOOLS_WITH_CLAUDE = {
  claude_cli: false,
  claude_desktop: true,
  codex_cli: false,
  codex_desktop: false,
  grok_cli: false,
  claude_last_used_ms: null,
  codex_last_used_ms: null,
  grok_last_used_ms: null,
  any: true,
};

type Handler = (args?: Record<string, unknown>) => unknown;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubInvoke(overrides: Record<string, Handler> = {}): void {
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    const override = overrides[command];
    if (override) return override(args);
    switch (command) {
      case 'resolve_hq_path':
        return '/Users/placeholder/hq';
      case 'detect_ai_tools':
        return TOOLS_WITH_CLAUDE;
      case 'detect_claude_desktop_connectors':
        return { present: false, count: 0, outcome: 'none', inspectedSources: 'unknown' };
      case 'ensure_person_entity':
        return true;
      default:
        return undefined;
    }
  });
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

const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
  host.querySelector<T>(`[data-testid="${id}"]`);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
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

describe('ready scene: AI-tool checking surface', () => {
  it('shows a checking line while the probe is in flight, then hides it and renders the tool pill', async () => {
    const probe = deferred<typeof TOOLS_WITH_CLAUDE>();
    stubInvoke({ detect_ai_tools: () => probe.promise });
    mountAt(READY_STEP_INDEX);

    await flushUntil(() => Boolean(byId('onboarding-ai-tools-checking')), 'the checking line');
    expect(byId('onboarding-ai-tools-checking')!.textContent).toContain('Checking for AI tools');
    expect(byId('onboarding-launch-claude')).toBeNull();
    // The rest of the step stays usable: the primary Open HQ Desktop card is
    // still there.
    expect(byId('onboarding-open-desktop')).not.toBeNull();

    probe.resolve(TOOLS_WITH_CLAUDE);
    await flushUntil(() => Boolean(byId('onboarding-launch-claude')), 'the resolved tool pill');
    expect(byId('onboarding-ai-tools-checking')).toBeNull();
  });

  it('replaces the checking line with a Check again control on probe failure, and re-probes on click', async () => {
    let calls = 0;
    stubInvoke({
      detect_ai_tools: async () => {
        calls += 1;
        if (calls === 1) throw new Error('probe rejected');
        return TOOLS_WITH_CLAUDE;
      },
    });
    mountAt(READY_STEP_INDEX);

    await flushUntil(() => Boolean(byId('onboarding-ai-tools-recheck')), 'the recheck control');
    expect(byId('onboarding-ai-tools-recheck')!.textContent).toContain("couldn’t check");
    expect(byId<HTMLButtonElement>('onboarding-ai-tools-recheck-button')).not.toBeNull();

    byId<HTMLButtonElement>('onboarding-ai-tools-recheck-button')!.click();
    await flushUntil(() => Boolean(byId('onboarding-launch-claude')), 'the recovered tool pill');
    expect(calls).toBe(2);
    expect(byId('onboarding-ai-tools-recheck')).toBeNull();
  });

  it('surfaces a Check again fallback when the probe outruns the ~10s timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const probe = deferred<typeof TOOLS_WITH_CLAUDE>();
    stubInvoke({ detect_ai_tools: () => probe.promise });
    mountAt(READY_STEP_INDEX);

    for (let i = 0; i < 4 && !byId('onboarding-ai-tools-checking'); i += 1) {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    }
    expect(byId('onboarding-ai-tools-checking')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(11_000);
    await flush();
    expect(byId('onboarding-ai-tools-recheck')).not.toBeNull();
    expect(byId('onboarding-ai-tools-checking')).toBeNull();

    // Late arrivals still fill in the launch buttons.
    probe.resolve(TOOLS_WITH_CLAUDE);
    for (let i = 0; i < 6 && !byId('onboarding-launch-claude'); i += 1) {
      await vi.advanceTimersByTimeAsync(10);
      await flush();
    }
    expect(byId('onboarding-launch-claude')).not.toBeNull();
    vi.useRealTimers();
  });
});
