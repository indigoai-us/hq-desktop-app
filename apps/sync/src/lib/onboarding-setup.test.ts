// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import {
  activeStageId,
  allSettled,
  buildInitialStages,
  contentProgressSubStatus,
  buildStagesFromManifest,
  countSettledStages,
  createSetupProgressTracker,
  resetSetupProgressTracker,
  setupRetryAttempt,
  setupRetrySubStatusText,
  trackSetupProgress,
  failedRequiredStages,
  friendlySetupBands,
  humanizeStageId,
  isContentRetryEligible,
  isHardStageTimeoutMessage,
  isStageSkipEligible,
  isTransientSetupStageFailure,
  resumeStartStageFromManifest,
  setStageStatus,
  setupAutoRetryDelayMs,
  setupCompletionResult,
  setupProgressPercent,
  setupStageRecoveryAction,
  setupSubStatus,
  stageAutoRetryLimit,
  stageCreepAt,
  stageSubSteps,
  stageCommandInvocations,
  stageSkipThresholdMs,
  stageTimeoutMs,
  StageTimeoutError,
  STAGE_LABELS,
  STAGE_ORDER,
  DEFAULT_STAGE_SKIP_THRESHOLD_MS,
  DEFAULT_STAGE_TIMEOUT_MS,
  withTimeout,
  type StageId,
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

  it('runs only stages with verified onboarding work', () => {
    expect(STAGE_ORDER).toEqual([
      'content',
      'deps',
      'initial-sync',
      'git-init',
      'personalize',
      'indexing',
    ]);
    expect(STAGE_ORDER).not.toContain('packages');
    expect(STAGE_ORDER).not.toContain('import');
    expect(STAGE_ORDER).not.toContain('menubar');
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

describe('setup failure record', () => {
  it('has no failed required stages when all stages succeed', () => {
    const stages: StageState[] = buildInitialStages().map((stage) => ({
      ...stage,
      status: 'ok',
    }));

    expect(failedRequiredStages(stages)).toEqual([]);
  });

  it('retains failed required stages with their labels and messages for the journal', () => {
    const stages = setStageStatus(
      buildInitialStages().map((stage) => ({ ...stage, status: 'ok' })),
      'content',
      'failed',
      'template download failed',
    );

    expect(failedRequiredStages(stages)).toEqual([
      {
        id: 'content',
        label: STAGE_LABELS.content,
        message: 'template download failed',
      },
    ]);
    expect(setupCompletionResult(stages)).toMatchObject({
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

  it('keeps failed required stages in the completion telemetry record', () => {
    const stages = setStageStatus(
      buildInitialStages().map((stage) => ({ ...stage, status: 'ok' })),
      'deps',
      'failed',
      'dependency install failed',
    );

    expect(setupCompletionResult(stages)).toMatchObject({
      failedStages: [
        {
          id: 'deps',
          label: 'Installing dependencies',
          message: 'dependency install failed',
        },
      ],
    });
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

  it('completes the seamless checklist when every stage has settled', () => {
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

describe('friendly setup bands', () => {
  it('marks the first band active at the start', () => {
    expect(friendlySetupBands(0)).toEqual([
      { label: 'Laying the groundwork', status: 'active' },
      { label: 'Building your workspace', status: 'pending' },
      {
        label: 'Bringing in your AI workers and workflows',
        status: 'pending',
      },
      { label: 'Making it yours', status: 'pending' },
      { label: 'Syncing across your devices', status: 'pending' },
    ]);
  });

  it('maps each 20 percent band to done, active, and pending states', () => {
    expect(friendlySetupBands(42).map((band) => band.status)).toEqual([
      'done',
      'done',
      'active',
      'pending',
      'pending',
    ]);
  });

  it('marks every band done at completion and clamps out-of-range values', () => {
    expect(friendlySetupBands(100).map((band) => band.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(friendlySetupBands(150).map((band) => band.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(friendlySetupBands(-12).map((band) => band.status)).toEqual([
      'active',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
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

describe('automatic setup recovery', () => {
  it('bounds auto-retry attempts to transient setup failures', () => {
    expect(stageAutoRetryLimit('content')).toBe(2);
    expect(stageAutoRetryLimit('git-init')).toBe(0);

    expect(
      isTransientSetupStageFailure({
        stageId: 'content',
        message: 'Template download stalled before receiving more data.',
      }),
    ).toBe(true);
    expect(
      isTransientSetupStageFailure({
        stageId: 'initial-sync',
        message: 'network timeout while syncing initial cloud data',
      }),
    ).toBe(true);
    expect(
      isTransientSetupStageFailure({
        stageId: 'content',
        message: 'template tarball not found (404)',
      }),
    ).toBe(false);
    expect(
      isTransientSetupStageFailure({
        stageId: 'deps',
        message: 'permission denied writing toolchain',
      }),
    ).toBe(false);
  });

  it('uses exponential backoff for automatic retries', () => {
    expect(setupAutoRetryDelayMs(0)).toBe(1000);
    expect(setupAutoRetryDelayMs(1)).toBe(1000);
    expect(setupAutoRetryDelayMs(2)).toBe(2000);
    expect(setupAutoRetryDelayMs(10)).toBe(8000);
  });

  it('plans retry, skip, or final failure without user interaction', () => {
    expect(
      setupStageRecoveryAction({
        stageId: 'content',
        message: 'network error downloading template: connection reset',
        retryCount: 0,
      }),
    ).toEqual({
      kind: 'retry',
      delayMs: 1000,
      nextRetryCount: 1,
      message: 'network error downloading template: connection reset',
    });

    expect(
      setupStageRecoveryAction({
        stageId: 'content',
        message: 'Template download stalled before receiving more data.',
        retryCount: 2,
      }),
    ).toEqual({
      kind: 'fail',
      message: 'Template download stalled before receiving more data.',
    });

    const hardTimeout = 'This step took too long (over 390s) and was skipped.';
    expect(isHardStageTimeoutMessage(hardTimeout)).toBe(true);
    expect(
      setupStageRecoveryAction({
        stageId: 'indexing',
        message: hardTimeout,
        retryCount: 0,
      }),
    ).toEqual({ kind: 'skip', message: hardTimeout });
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
    expect(stageTimeoutMs('personalize')).toBe(DEFAULT_STAGE_TIMEOUT_MS);
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

describe('live sub-status under the active band', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive the wizard's 1s ticker and read the sub-status at each tick. */
  function runStage(
    stageId: StageId,
    seconds: number,
    detail: string | null = null,
  ): ReturnType<typeof setupSubStatus>[] {
    const startedAt = Date.now();
    const seen: ReturnType<typeof setupSubStatus>[] = [];
    const timer = setInterval(() => {
      seen.push(
        setupSubStatus({ stageId, elapsedMs: Date.now() - startedAt, detail }),
      );
    }, 1_000);
    vi.advanceTimersByTime(seconds * 1_000);
    clearInterval(timer);
    return seen;
  }

  it('has honest sub-steps for every backend stage', () => {
    for (const id of STAGE_ORDER) {
      expect(stageSubSteps(id).length).toBeGreaterThan(0);
      for (const step of stageSubSteps(id)) expect(step.trim()).not.toBe('');
    }
  });

  it('humanizes a stage id it has no sub-steps for instead of rendering blank', () => {
    expect(stageSubSteps('menubar-install' as StageId)).toEqual([
      'Menubar install…',
    ]);
    expect(humanizeStageId('')).toBe('Working');
  });

  it('rotates through a stage’s sub-steps as it keeps running', () => {
    const lines = runStage('initial-sync', 30).map((status) => status.text);
    const distinct = [...new Set(lines)];

    expect(distinct.length).toBeGreaterThan(1);
    expect(distinct[0]).toBe('Downloading worker definitions…');
    expect(lines.at(-1)).toBe('Almost there…');
  });

  it('holds on the last sub-step rather than looping back to the first', () => {
    const lines = runStage('initial-sync', 240).map((status) => status.text);

    expect(lines.at(-1)).toBe('Almost there…');
    expect(lines.slice(60)).not.toContain('Downloading worker definitions…');
  });

  it('adds a still-working cue only after the threshold, counting up', () => {
    const statuses = runStage('deps', 130);

    expect(statuses[18]?.elapsedLabel).toBeNull();
    expect(statuses[19]?.elapsedLabel).toBe('Still working — 20s');
    expect(statuses[44]?.elapsedLabel).toBe('Still working — 45s');
    expect(statuses.at(-1)?.elapsedLabel).toBe('Still working — 2m 10s');
  });

  it('prefers a real backend detail over the written sub-steps', () => {
    const statuses = runStage(
      'content',
      12,
      'Downloading the HQ template — 42%',
    );

    expect(new Set(statuses.map((s) => s.text))).toEqual(
      new Set(['Downloading the HQ template — 42%']),
    );
  });

  it('says nothing when no stage is running', () => {
    expect(setupSubStatus({ stageId: null, elapsedMs: 600_000 })).toEqual({
      text: null,
      elapsedLabel: null,
    });
  });

  it('turns content download progress into one honest line', () => {
    expect(
      contentProgressSubStatus({ phase: 'download', percent: 41.6 }),
    ).toBe('Downloading the HQ template — 42%');
    expect(contentProgressSubStatus({ phase: 'download', percent: null })).toBe(
      'Downloading the HQ template…',
    );
    expect(contentProgressSubStatus({ phase: 'extract' })).toBe(
      'Unpacking files…',
    );
    expect(
      contentProgressSubStatus({ phase: 'download', percent: 12, stalled: true }),
    ).toBe('The download stalled — retrying…');
    expect(contentProgressSubStatus({ phase: 'complete' })).toBeNull();
  });
});

describe('percent creep inside a band', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The percent the ring shows for a stage that has been running `seconds`. */
  function percentAfter(seconds: number): number {
    return setupProgressPercent({
      settledCount: 2,
      totalStages: STAGE_ORDER.length,
      hasRunningStage: true,
      stageCreep: stageCreepAt(seconds * 1_000),
    });
  }

  it('keeps the number moving for minutes, not only for the first half-minute', () => {
    const startedAt = Date.now();
    const samples: number[] = [];
    const timer = setInterval(() => {
      samples.push(stageCreepAt(Date.now() - startedAt));
    }, 1_000);
    vi.advanceTimersByTime(180_000);
    clearInterval(timer);

    // Monotonic, and still climbing long after the old 14%-per-tick curve
    // had saturated (~25s).
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
    expect(samples.at(-1)!).toBeGreaterThan(samples[29]!);
    expect(percentAfter(180)).toBeGreaterThan(percentAfter(30));
    expect(percentAfter(30)).toBeGreaterThan(percentAfter(5));
  });

  it('never claims more than the band it is inside', () => {
    expect(stageCreepAt(0)).toBe(0);
    expect(stageCreepAt(10_000_000)).toBeLessThanOrEqual(0.92);
    expect(stageCreepAt(-5_000)).toBe(0);
    expect(percentAfter(10_000)).toBeLessThan(50);
  });
});

describe('setup progress never moves backward', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const BAND_RANK: Record<string, number> = { pending: 0, active: 1, done: 2 };

  /**
   * The wizard's displayed-progress pipeline over a stage list: the same
   * functions OnboardingWizard reads, in the same order.
   */
  function createVisit() {
    const tracker = createSetupProgressTracker();
    let stages = buildInitialStages();
    const percents: number[] = [];
    const bandRanks: number[][] = [];

    function sample(stageCreep = 0): number {
      const percent = trackSetupProgress(
        tracker,
        setupProgressPercent({
          settledCount: countSettledStages(stages),
          totalStages: STAGE_ORDER.length,
          hasRunningStage: activeStageId(stages) !== null,
          stageCreep,
          allDone: allSettled(stages),
        }),
      );
      percents.push(percent);
      bandRanks.push(
        friendlySetupBands(percent).map((band) => BAND_RANK[band.status]!),
      );
      return percent;
    }

    return {
      get stages() {
        return stages;
      },
      set(id: StageId, status: StageState['status'], error: string | null = null) {
        stages = setStageStatus(stages, id, status, error);
      },
      rebuild() {
        stages = buildInitialStages();
      },
      restart() {
        resetSetupProgressTracker(tracker);
      },
      sample,
      /** Run a stage for `seconds`, sampling on the wizard's 1s ticker. */
      tick(seconds: number, elapsedOffsetMs = 0) {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          sample(stageCreepAt(elapsedOffsetMs + Date.now() - startedAt));
        }, 1_000);
        vi.advanceTimersByTime(seconds * 1_000);
        clearInterval(timer);
        return elapsedOffsetMs + seconds * 1_000;
      },
      percents,
      bandRanks,
    };
  }

  function expectMonotonic(visit: ReturnType<typeof createVisit>): void {
    for (let i = 1; i < visit.percents.length; i += 1) {
      expect(visit.percents[i]).toBeGreaterThanOrEqual(visit.percents[i - 1]!);
    }
    for (let i = 1; i < visit.bandRanks.length; i += 1) {
      const previous = visit.bandRanks[i - 1]!;
      for (const [band, rank] of visit.bandRanks[i]!.entries()) {
        expect(rank).toBeGreaterThanOrEqual(previous[band]!);
      }
    }
  }

  it('keeps a stage settled-free and in place while it waits for its auto-retry', () => {
    const visit = createVisit();
    visit.set('content', 'ok');
    visit.set('deps', 'running');
    const running = visit.sample(0.9);

    // The old code flipped the stage back to 'pending' here, which dropped
    // both the settled count and the running flag.
    visit.set('deps', 'retrying', 'network timeout while fetching the registry');
    expect(countSettledStages(visit.stages)).toBe(1);
    expect(activeStageId(visit.stages)).toBe('deps');
    expect(allSettled(visit.stages)).toBe(false);
    expect(visit.sample(0.9)).toBe(running);
    expectMonotonic(visit);
  });

  it('does not lower the percent or regress the bands across a stage retry', () => {
    const visit = createVisit();
    visit.set('content', 'ok');
    visit.set('deps', 'ok');
    visit.set('initial-sync', 'running');
    let elapsedMs = visit.tick(40);
    const beforeFailure = visit.percents.at(-1)!;

    visit.set('initial-sync', 'retrying', 'connection reset by peer');
    elapsedMs = visit.tick(4, elapsedMs);
    visit.set('initial-sync', 'running');
    elapsedMs = visit.tick(40, elapsedMs);
    visit.set('initial-sync', 'ok');
    visit.sample();

    expectMonotonic(visit);
    expect(visit.percents.at(-1)!).toBeGreaterThan(beforeFailure);
    // The creep carried on from the first attempt instead of restarting, so
    // the retried attempt keeps earning percent rather than standing still.
    expect(stageCreepAt(elapsedMs)).toBeGreaterThan(stageCreepAt(40_000));
  });

  it('holds the displayed percent when the stage list is rebuilt mid-visit', () => {
    const visit = createVisit();
    visit.set('content', 'ok');
    visit.set('deps', 'ok');
    visit.set('initial-sync', 'running');
    const beforeRebuild = visit.sample(0.8);
    expect(beforeRebuild).toBeGreaterThan(40);

    // A second setup run rebuilding the list underneath a live one: the raw
    // percent collapses to the first band, the displayed one must not.
    visit.rebuild();
    expect(
      setupProgressPercent({
        settledCount: countSettledStages(visit.stages),
        totalStages: STAGE_ORDER.length,
        hasRunningStage: activeStageId(visit.stages) !== null,
        stageCreep: 0,
        allDone: false,
      }),
    ).toBe(0);
    expect(visit.sample()).toBe(beforeRebuild);
    expectMonotonic(visit);
  });

  it('starts over only when the visit does', () => {
    const visit = createVisit();
    visit.set('content', 'ok');
    visit.set('deps', 'running');
    expect(visit.sample(0.5)).toBeGreaterThan(15);

    visit.restart();
    visit.rebuild();
    expect(visit.sample()).toBe(0);
  });

  it('reaches 100 and stays there once every stage has settled', () => {
    const visit = createVisit();
    for (const id of STAGE_ORDER) visit.set(id, 'ok');
    expect(visit.sample()).toBe(100);
    expect(visit.sample()).toBe(100);
    expectMonotonic(visit);
  });

  it('still counts a stage that will not be retried as settled', () => {
    const stages = setStageStatus(
      buildInitialStages(),
      'git-init',
      'failed',
      'Stage failed with no detail recorded.',
    );

    expect(countSettledStages(stages)).toBe(1);
    expect(activeStageId(stages)).toBeNull();
    expect(failedRequiredStages(stages).map((stage) => stage.id)).toEqual([
      'git-init',
    ]);
  });

  it('leaves a retrying stage out of the failure record', () => {
    const stages = setStageStatus(
      buildInitialStages(),
      'content',
      'retrying',
      'download stalled',
    );

    expect(failedRequiredStages(stages)).toEqual([]);
    expect(allSettled(stages)).toBe(false);
  });
});

describe('auto-retry sub-status', () => {
  it('numbers the attempt against the stage\'s own retry budget', () => {
    expect(setupRetryAttempt('content', 1)).toEqual({ attempt: 2, of: 3 });
    expect(setupRetryAttempt('content', 2)).toEqual({ attempt: 3, of: 3 });
    expect(setupRetryAttempt('deps', 1)).toEqual({ attempt: 2, of: 2 });
    // A retry count past the budget can never promise an attempt that will
    // not happen.
    expect(setupRetryAttempt('deps', 9)).toEqual({ attempt: 2, of: 2 });
  });

  it('says the stage is retrying instead of rotating its sub-steps', () => {
    const retry = setupRetryAttempt('content', 1);
    expect(setupRetrySubStatusText(retry)).toBe('Retrying — attempt 2 of 3…');

    const status = setupSubStatus({
      stageId: 'content',
      elapsedMs: 45_000,
      detail: 'Downloading the HQ template — 40%',
      retry,
    });

    // The stale detail from the attempt that just failed must not claim work
    // that is paused, and the elapsed clock keeps running.
    expect(status.text).toBe('Retrying — attempt 2 of 3…');
    expect(status.elapsedLabel).toBe('Still working — 45s');
  });

  it('returns to the stage sub-steps once the next attempt is under way', () => {
    expect(
      setupSubStatus({ stageId: 'content', elapsedMs: 45_000, retry: null }).text,
    ).toBe('Checking everything arrived…');
  });
});
