// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import {
  allSettled,
  buildInitialStages,
  buildStagesFromManifest,
  failedRequiredStages,
  isContentRetryEligible,
  isStageSkipEligible,
  resumeStartStageFromManifest,
  setStageStatus,
  setupCompletionResult,
  setupNeedsAttention,
  setupProgressPercent,
  stageCommandInvocations,
  stageSkipThresholdMs,
  stageTimeoutMs,
  StageTimeoutError,
  STAGE_LABELS,
  STAGE_ORDER,
  DEFAULT_STAGE_SKIP_THRESHOLD_MS,
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

function emitContentProgress(payload: unknown): void {
  const handler = eventHandlers.get('content:progress');
  if (!handler) throw new Error('content:progress listener was not registered');
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

describe('install manifest resume state', () => {
  it('resumes at the first incomplete manifest stage', () => {
    const manifest = {
      schemaVersion: 1,
      installerVersion: '0.0.0-test',
      installPath: '/tmp/HQ',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      steps: {
        content: { status: 'ok' as const },
        deps: { status: 'failed' as const, error: 'node failed' },
      },
    };

    expect(resumeStartStageFromManifest(manifest)).toBe('deps');
    expect(buildStagesFromManifest(manifest).slice(0, 3)).toMatchObject([
      { id: 'content', status: 'ok' },
      { id: 'deps', status: 'pending' },
      { id: 'initial-sync', status: 'pending' },
    ]);
  });
});

describe('setup attention summary', () => {
  it('does not ask for attention when required stages all succeed', () => {
    const stages: StageState[] = buildInitialStages().map((stage) => ({
      ...stage,
      status: 'ok',
    }));

    expect(setupNeedsAttention(stages)).toBe(false);
    expect(failedRequiredStages(stages)).toEqual([]);
  });

  it('reports failed required stages with their labels and messages', () => {
    const stages = setStageStatus(
      buildInitialStages().map((stage) => ({ ...stage, status: 'ok' })),
      'content',
      'failed',
      'template download failed',
    );

    expect(setupNeedsAttention(stages)).toBe(true);
    expect(failedRequiredStages(stages)).toEqual([
      {
        id: 'content',
        label: STAGE_LABELS.content,
        message: 'template download failed',
      },
    ]);
    expect(setupCompletionResult(stages)).toMatchObject({
      needsAttention: true,
      failedStages: [
        {
          id: 'content',
          label: STAGE_LABELS.content,
          message: 'template download failed',
        },
      ],
    });
  });

  it('uses an honest fallback message when a required failure has no detail', () => {
    const stages = setStageStatus(buildInitialStages(), 'deps', 'failed', null);

    expect(failedRequiredStages(stages)).toEqual([
      {
        id: 'deps',
        label: STAGE_LABELS.deps,
        message: 'Stage failed with no detail recorded.',
      },
    ]);
  });
});

describe('setup progress percent', () => {
  it('creeps toward the next stage while a stage is running', () => {
    expect(
      setupProgressPercent({
        settledCount: 2,
        totalStages: 10,
        hasRunningStage: true,
        stageCreep: 0.5,
      }),
    ).toBe(25);
  });

  it('does not creep without an active running stage', () => {
    expect(
      setupProgressPercent({
        settledCount: 2,
        totalStages: 10,
        hasRunningStage: false,
        stageCreep: 0.5,
      }),
    ).toBe(20);
  });

  it('returns 100 once all stages are settled', () => {
    expect(
      setupProgressPercent({
        settledCount: STAGE_ORDER.length,
        totalStages: STAGE_ORDER.length,
        hasRunningStage: false,
        stageCreep: 0,
        allDone: true,
      }),
    ).toBe(100);
  });
});

describe('stage skip affordance', () => {
  it('uses legacy-length thresholds for skip eligibility', () => {
    expect(stageSkipThresholdMs('git-init')).toBe(
      DEFAULT_STAGE_SKIP_THRESHOLD_MS,
    );
    expect(stageSkipThresholdMs('content')).toBeGreaterThan(
      DEFAULT_STAGE_SKIP_THRESHOLD_MS,
    );
    expect(stageSkipThresholdMs('deps')).toBeGreaterThan(
      DEFAULT_STAGE_SKIP_THRESHOLD_MS,
    );
  });

  it('only enables skip for the active stage after its threshold', () => {
    const threshold = stageSkipThresholdMs('deps');

    expect(
      isStageSkipEligible({
        activeStageId: 'deps',
        stageId: 'deps',
        elapsedMs: threshold - 1,
      }),
    ).toBe(false);
    expect(
      isStageSkipEligible({
        activeStageId: 'content',
        stageId: 'deps',
        elapsedMs: threshold,
      }),
    ).toBe(false);
    expect(
      isStageSkipEligible({
        activeStageId: 'deps',
        stageId: 'deps',
        elapsedMs: threshold,
        setupDone: true,
      }),
    ).toBe(false);
    expect(
      isStageSkipEligible({
        activeStageId: 'deps',
        stageId: 'deps',
        elapsedMs: threshold,
      }),
    ).toBe(true);
  });
});

describe('content retry eligibility', () => {
  it('enables retry for failed content or a stalled active content fetch only', () => {
    const failed = setStageStatus(buildInitialStages(), 'content', 'failed', 'boom')
      .find((stage) => stage.id === 'content');
    expect(
      isContentRetryEligible({
        contentStage: failed,
        activeStageId: null,
      }),
    ).toBe(true);

    const running = setStageStatus(buildInitialStages(), 'content', 'running')
      .find((stage) => stage.id === 'content');
    expect(
      isContentRetryEligible({
        contentStage: running,
        activeStageId: 'content',
        progress: { stalled: true },
      }),
    ).toBe(true);
    expect(
      isContentRetryEligible({
        contentStage: running,
        activeStageId: 'content',
        progress: { stalled: false },
      }),
    ).toBe(false);
    expect(
      isContentRetryEligible({
        contentStage: running,
        activeStageId: 'deps',
        progress: { stalled: true },
      }),
    ).toBe(false);
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

describe('stage command invocations', () => {
  it('adds Claude settings PATH configuration after dependency install', () => {
    expect(
      stageCommandInvocations('deps', { installPath: '/tmp/hq' }),
    ).toEqual([
      { command: 'install_deps', required: true },
      {
        command: 'configure_claude_settings_path',
        args: { hqPath: '/tmp/hq' },
        required: false,
      },
    ]);
  });

  it('skips the Claude settings follow-up until an install path is resolved', () => {
    expect(stageCommandInvocations('deps', { installPath: null })).toEqual([
      { command: 'install_deps', required: true },
    ]);
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
      props: { installPath: '/tmp/hq', onsetupcomplete: vi.fn() },
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

  it('shows byte-level content progress while the template downloads', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'fetch_and_extract_template') {
        return new Promise<void>(() => {});
      }
      if (command === 'cancel_content_download') return Promise.resolve(true);
      return Promise.resolve(undefined);
    });

    const component = mount(SetupScreen, {
      target: document.body,
      props: { installPath: '/tmp/hq', onsetupcomplete: vi.fn() },
    });
    await waitForInvoke('fetch_and_extract_template');

    emitContentProgress({
      phase: 'download',
      receivedBytes: 50,
      totalBytes: 100,
      percent: 50,
      message: 'Downloading HQ template',
    });
    await flushMicrotasks();

    expect(document.body.textContent).toContain('Downloading HQ template');
    expect(document.body.textContent).toContain('50%');
    const fill = document.querySelector<HTMLElement>(
      'li.current .stage-progress.determinate span',
    );
    expect(fill?.getAttribute('style')).toContain('width: 50%');

    await unmount(component);
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
      props: { installPath: '/tmp/hq', onsetupcomplete: vi.fn() },
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

  it('lets the user skip a long-running stage after the threshold', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'install_deps') return new Promise<void>(() => {});
      if (command === 'cancel_install') return Promise.resolve(true);
      return Promise.resolve(undefined);
    });

    const onsetupcomplete = vi.fn();
    const component = mount(SetupScreen, {
      target: document.body,
      props: { installPath: '/tmp/hq', onsetupcomplete },
    });
    await waitForInvoke('install_deps');

    emitInstallProgress({
      handle: 'install-handle-skip',
      line: 'Installing Node',
      finished: false,
    });
    await vi.advanceTimersByTimeAsync(stageSkipThresholdMs('deps'));
    await flushMicrotasks();

    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Skip this step',
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();
    button?.click();
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledWith('cancel_install', {
      handle: 'install-handle-skip',
    });
    for (let i = 0; i < 100 && onsetupcomplete.mock.calls.length === 0; i += 1) {
      await flushMicrotasks();
    }
    expect(onsetupcomplete).toHaveBeenCalledWith(
      expect.objectContaining({
        needsAttention: true,
        failedStages: expect.arrayContaining([
          expect.objectContaining({
            id: 'deps',
            message: 'Skipped after timeout',
          }),
        ]),
      }),
    );
    await unmount(component);
  });

  it('invokes Claude settings PATH configuration after dependency install', async () => {
    invokeMock.mockResolvedValue(undefined);

    const component = mount(SetupScreen, {
      target: document.body,
      props: { installPath: '/tmp/hq', onsetupcomplete: vi.fn() },
    });

    await waitForInvoke('configure_claude_settings_path');
    const commands = invokeMock.mock.calls.map(([command]) => command);

    expect(commands.indexOf('install_deps')).toBeLessThan(
      commands.indexOf('configure_claude_settings_path'),
    );
    expect(invokeMock).toHaveBeenCalledWith('configure_claude_settings_path', {
      hqPath: '/tmp/hq',
    });
    await unmount(component);
  });
});
