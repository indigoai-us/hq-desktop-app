// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import {
  allSettled,
  buildInitialStages,
  setStageStatus,
  stageTimeoutMs,
  StageTimeoutError,
  STAGE_LABELS,
  STAGE_ORDER,
  DEFAULT_STAGE_TIMEOUT_MS,
  withTimeout,
  type StageState,
} from './onboarding-setup';
import SetupScreen from '../components/onboarding/SetupScreen.svelte';

const invokeMock = vi.fn();
type TauriHandler = (event: { payload: unknown }) => void;
const eventHandlers = new Map<string, TauriHandler>();
const unlistenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: TauriHandler) => {
    eventHandlers.set(name, handler);
    return Promise.resolve(() => {
      unlistenMock(name);
      eventHandlers.delete(name);
    });
  }),
}));

vi.mock('svelte', async () => {
  // Vitest resolves Svelte's public entry with the default/server condition in
  // this repo's node test config, even for per-file happy-dom tests.
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

async function waitForInvoke(command: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await flushMicrotasks();
    if (invokeMock.mock.calls.some(([cmd]) => cmd === command)) return;
  }
  throw new Error(`invoke(${command}) was not called`);
}

function emitInstallProgress(payload: unknown): void {
  const handler = eventHandlers.get('install:progress');
  if (!handler) throw new Error('install:progress listener was not registered');
  handler({ payload });
}

describe('onboarding setup stages', () => {
  it('builds the initial stage list in order with all stages pending', () => {
    const stages = buildInitialStages();

    expect(stages).toHaveLength(STAGE_ORDER.length);
    expect(stages.map((stage) => stage.id)).toEqual(STAGE_ORDER);
    expect(stages.map((stage) => stage.label)).toEqual(
      STAGE_ORDER.map((id) => STAGE_LABELS[id]),
    );
    expect(stages.every((stage) => stage.status === 'pending')).toBe(true);
  });

  it('settles only when every stage is ok or failed', () => {
    const pending = buildInitialStages();
    const running = setStageStatus(pending, 'deps', 'running');
    const settled: StageState[] = STAGE_ORDER.map((id, index) => ({
      id,
      label: STAGE_LABELS[id],
      status: index % 2 === 0 ? 'ok' : 'failed',
      error: index % 2 === 0 ? null : 'non-fatal failure',
    }));

    expect(allSettled(pending)).toBe(false);
    expect(allSettled(running)).toBe(false);
    expect(allSettled(settled)).toBe(true);
  });

  it('applies status transitions without mutating other stages', () => {
    const stages = buildInitialStages();
    const running = setStageStatus(stages, 'git-init', 'running');
    const failed = setStageStatus(running, 'git-init', 'failed', 'missing command');

    expect(stages.find((stage) => stage.id === 'git-init')?.status).toBe(
      'pending',
    );
    expect(running.find((stage) => stage.id === 'git-init')).toMatchObject({
      status: 'running',
      error: null,
    });
    expect(failed.find((stage) => stage.id === 'git-init')).toMatchObject({
      status: 'failed',
      error: 'missing command',
    });
    expect(failed.find((stage) => stage.id === 'deps')?.status).toBe('pending');
  });
});

describe('stage timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives content/deps/indexing longer budgets and everything else the default', () => {
    expect(stageTimeoutMs('content')).toBeGreaterThan(DEFAULT_STAGE_TIMEOUT_MS);
    expect(stageTimeoutMs('deps')).toBeGreaterThan(DEFAULT_STAGE_TIMEOUT_MS);
    expect(stageTimeoutMs('indexing')).toBeGreaterThan(DEFAULT_STAGE_TIMEOUT_MS);
    expect(stageTimeoutMs('git-init')).toBe(DEFAULT_STAGE_TIMEOUT_MS);
    expect(stageTimeoutMs('menubar')).toBe(DEFAULT_STAGE_TIMEOUT_MS);
  });

  it('resolves when the work settles before the timeout', async () => {
    const promise = withTimeout(
      Promise.resolve('done'),
      1000,
      () => new Error('should not fire'),
    );
    await expect(promise).resolves.toBe('done');
  });

  it('rejects with the timeout error when the work hangs past the budget', async () => {
    // A promise that never settles — models a hung `hq reindex`.
    const hung = new Promise<void>(() => {});
    const guarded = withTimeout(
      hung,
      90_000,
      () => new StageTimeoutError('indexing', 90_000),
    );
    const assertion = expect(guarded).rejects.toBeInstanceOf(StageTimeoutError);
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it('propagates the underlying rejection without waiting for the timeout', async () => {
    const failing = Promise.reject(new Error('backend blew up'));
    await expect(
      withTimeout(failing, 90_000, () => new Error('timeout')),
    ).rejects.toThrow('backend blew up');
  });

  it('disables the timeout when ms is not positive', async () => {
    await expect(
      withTimeout(Promise.resolve('ok'), 0, () => new Error('nope')),
    ).resolves.toBe('ok');
  });

  it('runs the timeout cancellation hook before rejecting', async () => {
    const hung = new Promise<void>(() => {});
    const onTimeoutCancel = vi.fn();
    const guarded = withTimeout(
      hung,
      90_000,
      () => new StageTimeoutError('deps', 90_000),
      onTimeoutCancel,
    );
    const assertion = expect(guarded).rejects.toBeInstanceOf(StageTimeoutError);
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(onTimeoutCancel).toHaveBeenCalledTimes(1);
  });
});

describe('SetupScreen install cancellation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    invokeMock.mockReset();
    eventHandlers.clear();
    unlistenMock.mockReset();
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    eventHandlers.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('cancels captured install handles when unmounted', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'install_deps') return new Promise<void>(() => {});
      if (command === 'cancel_install') return Promise.resolve(true);
      return Promise.resolve(undefined);
    });

    const component = mount(SetupScreen, {
      target: document.body,
      props: { onsetupcomplete: vi.fn() },
    });
    await waitForInvoke('install_deps');

    emitInstallProgress({
      handle: 'install-handle-unmount',
      line: 'Installing Node',
      finished: false,
    });
    await unmount(component);
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledWith('cancel_install', {
      handle: 'install-handle-unmount',
    });
    expect(unlistenMock).toHaveBeenCalledWith('install:progress');
  });

  it('cancels captured install handles when the deps stage times out', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'install_deps') return new Promise<void>(() => {});
      if (command === 'cancel_install') return Promise.resolve(true);
      return Promise.resolve(undefined);
    });

    const component = mount(SetupScreen, {
      target: document.body,
      props: { onsetupcomplete: vi.fn() },
    });
    await waitForInvoke('install_deps');

    emitInstallProgress({
      handle: 'install-handle-timeout',
      line: 'Installing Node',
      finished: false,
    });
    await vi.advanceTimersByTimeAsync(stageTimeoutMs('deps'));
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledWith('cancel_install', {
      handle: 'install-handle-timeout',
    });
    await unmount(component);
  });
});
