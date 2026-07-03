<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { onDestroy, onMount } from 'svelte';
  import {
    allSettled,
    buildInitialStages,
    buildStagesFromManifest,
    isContentRetryEligible,
    isStageSkipEligible,
    resumeStartStageFromManifest,
    setStageStatus,
    setupCompletionResult,
    setupProgressPercent,
    stageCommandInvocations,
    stageSkipThresholdMs,
    stageTimeoutMs,
    StageTimeoutError,
    STAGE_ORDER,
    withTimeout,
    type InstallManifest,
    type StageId,
    type StageState,
    type SetupCompletionResult,
  } from '../../lib/onboarding-setup';

  interface Props {
    installPath: string | null;
    onsetupcomplete?: (result: SetupCompletionResult) => void;
  }

  let { installPath, onsetupcomplete }: Props = $props();

  let stages = $state<StageState[]>(buildInitialStages());
  let completed = $state(false);
  let stageCreep = $state(0);
  let effectiveInstallPath = $state<string | null>(null);
  let currentRunId = 0;
  let setupCancelled = false;
  let unlistenInstallProgress: UnlistenFn | null = null;
  let unlistenContentProgress: UnlistenFn | null = null;
  let skipReadyStage = $state<StageId | null>(null);
  let activeStageControl: ActiveStageControl | null = null;
  let contentProgress = $state<ContentProgressPayload | null>(null);
  let contentRetryInFlight = $state(false);
  let stagingSource = $state(false);
  let stagingSourceSaving = $state(false);
  const activeInstallHandles = new Set<string>();
  const activeContentHandles = new Set<string>();

  const settledCount = $derived(
    stages.filter((stage) => stage.status === 'ok' || stage.status === 'failed')
      .length,
  );
  const currentStageId = $derived(
    stages.find((stage) => stage.status === 'running')?.id ?? null,
  );
  const contentStage = $derived(
    stages.find((stage) => stage.id === 'content') ?? null,
  );
  const contentRetryEligible = $derived(
    isContentRetryEligible({
      contentStage,
      activeStageId: currentStageId,
      progress: contentProgress,
      retrying: contentRetryInFlight,
    }),
  );
  const stagingToggleDisabled = $derived(
    stagingSourceSaving || contentStage?.status === 'ok',
  );
  const setupDone = $derived(allSettled(stages));
  const overallPercent = $derived(
    setupProgressPercent({
      settledCount,
      totalStages: STAGE_ORDER.length,
      hasRunningStage: currentStageId !== null,
      stageCreep,
      allDone: setupDone,
    }),
  );
  const progressFillPercent = $derived(
    setupDone ? overallPercent : Math.max(2, overallPercent),
  );

  function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  type InstallProgressPayload = {
    handle?: string;
    finished?: boolean;
  };

  type ContentProgressPayload = {
    handle?: string;
    phase?: 'download' | 'extract' | 'complete';
    receivedBytes?: number | null;
    totalBytes?: number | null;
    percent?: number | null;
    slow?: boolean;
    stalled?: boolean;
    message?: string;
  };

  type ActiveStageControl = {
    runId: number;
    stageId: StageId;
    skip: () => void;
    retry: () => void;
    skipped: boolean;
  };

  function beginSetupRun(): number {
    currentRunId += 1;
    setupCancelled = false;
    activeInstallHandles.clear();
    activeContentHandles.clear();
    activeStageControl = null;
    skipReadyStage = null;
    contentProgress = null;
    contentRetryInFlight = false;
    return currentRunId;
  }

  function isCurrentRun(runId: number): boolean {
    return runId === currentRunId && !setupCancelled;
  }

  async function cancelActiveInstallHandles(runId: number): Promise<void> {
    if (runId !== currentRunId) return;
    const handles = [...activeInstallHandles];
    activeInstallHandles.clear();
    await Promise.allSettled(
      handles.map((handle) => invoke('cancel_install', { handle })),
    );
  }

  async function cancelActiveContentHandles(runId: number): Promise<void> {
    if (runId !== currentRunId) return;
    const handles = [...activeContentHandles];
    activeContentHandles.clear();
    await Promise.allSettled(
      handles.map((handle) => invoke('cancel_content_download', { handle })),
    );
  }

  async function cancelForegroundWork(runId: number): Promise<void> {
    await Promise.allSettled([
      cancelActiveInstallHandles(runId),
      cancelActiveContentHandles(runId),
    ]);
  }

  function trackInstallProgress(runId: number, payload: InstallProgressPayload): void {
    if (!isCurrentRun(runId)) return;
    const handle = payload.handle;
    if (!handle || handle === 'preflight') return;

    if (payload.finished) {
      activeInstallHandles.delete(handle);
      return;
    }
    activeInstallHandles.add(handle);
  }

  function normalizeContentProgress(
    payload: ContentProgressPayload,
  ): ContentProgressPayload {
    const total = payload.totalBytes ?? null;
    const received = payload.receivedBytes ?? null;
    const percent =
      typeof payload.percent === 'number'
        ? Math.max(0, Math.min(100, Math.round(payload.percent)))
        : total && total > 0 && typeof received === 'number'
          ? Math.max(0, Math.min(100, Math.round((received / total) * 100)))
          : null;
    return {
      ...payload,
      receivedBytes: received,
      totalBytes: total,
      percent,
    };
  }

  function trackContentProgress(runId: number, payload: ContentProgressPayload): void {
    if (!isCurrentRun(runId)) return;
    const handle = payload.handle;
    if (
      handle &&
      activeContentHandles.size > 0 &&
      !activeContentHandles.has(handle)
    ) {
      return;
    }

    contentProgress = normalizeContentProgress(payload);

    if (handle && payload.phase === 'complete') {
      activeContentHandles.delete(handle);
    }
  }

  async function listenForProgress(runId: number): Promise<void> {
    const unlisten = await listen<InstallProgressPayload>(
      'install:progress',
      (event) => trackInstallProgress(runId, event.payload),
    );
    if (!isCurrentRun(runId)) {
      unlisten();
      return;
    }
    unlistenInstallProgress = unlisten;

    const unlistenContent = await listen<ContentProgressPayload>(
      'content:progress',
      (event) => trackContentProgress(runId, event.payload),
    );
    if (!isCurrentRun(runId)) {
      unlistenContent();
      return;
    }
    unlistenContentProgress = unlistenContent;
  }

  function invokeDesktopCommand(command: string, args?: Record<string, unknown>) {
    return args === undefined ? invoke(command) : invoke(command, args);
  }

  $effect(() => {
    if (installPath) effectiveInstallPath = installPath;
  });

  function contentHandle(runId: number): string {
    return `content-${runId}-${Date.now().toString(36)}`;
  }

  async function loadStagingSource(): Promise<void> {
    if (typeof invoke !== 'function') return;
    try {
      stagingSource = Boolean(await invoke<boolean>('get_staging_source'));
    } catch {
      stagingSource = false;
    }
  }

  async function handleToggleStagingSource(): Promise<void> {
    if (stagingToggleDisabled || typeof invoke !== 'function') return;
    const next = !stagingSource;
    stagingSource = next;
    stagingSourceSaving = true;
    let saved = false;
    try {
      stagingSource = Boolean(
        await invoke<boolean>('set_staging_source', { enabled: next }),
      );
      saved = true;
    } catch (err) {
      stagingSource = !next;
      console.error('Failed to save staging source:', err);
    } finally {
      stagingSourceSaving = false;
    }
    if (saved && currentStageId === 'content' && activeStageControl?.stageId === 'content') {
      retryActiveContentStage(activeStageControl);
    }
  }

  async function journalStageStart(id: StageId): Promise<void> {
    try {
      await invoke('record_step_start', { stepId: id });
    } catch {
      // Resume journaling is best-effort; setup itself remains authoritative.
    }
  }

  async function journalStageOk(id: StageId): Promise<void> {
    try {
      await invoke('record_step_ok', { stepId: id });
    } catch {
      // non-fatal
    }
  }

  async function journalStageFailure(id: StageId, message: string): Promise<void> {
    try {
      await invoke('record_step_failure', { stepId: id, error: message });
    } catch {
      // non-fatal
    }
  }

  async function journalInstallComplete(): Promise<void> {
    try {
      await invoke('record_install_complete');
    } catch {
      // non-fatal
    }
  }

  async function invokeStageCommand(id: StageId, runId: number): Promise<void> {
    const invocations = stageCommandInvocations(id, { installPath: effectiveInstallPath });
    if (invocations.length === 0) return;
    if (typeof invoke !== 'function') {
      throw new Error('The desktop bridge is not available in this environment.');
    }

    // Bound every stage so a hung backend (e.g. `hq reindex` blocked on a lock)
    // can't wedge the wizard forever. On timeout the stage is marked failed and
    // runSetup moves on — all stages are non-fatal and the tray agent re-runs
    // them in steady state.
    const ms = stageTimeoutMs(id);
    for (const invocation of invocations) {
      let args = invocation.args;
      let handle: string | null = null;
      if (invocation.command === 'fetch_and_extract_template') {
        handle = contentHandle(runId);
        activeContentHandles.add(handle);
        args = { ...args, handle };
      }
      try {
        await withTimeout(
          Promise.resolve(invokeDesktopCommand(invocation.command, args)),
          ms,
          () => new StageTimeoutError(id, ms),
          () => {
            void cancelForegroundWork(runId);
          },
        );
      } catch (err) {
        if (invocation.required) throw err;
      } finally {
        if (handle) {
          activeContentHandles.delete(handle);
        }
      }
    }
  }

  type StageRunOutcome = 'ok' | 'failed' | 'cancelled' | 'retry';

  async function runStage(id: StageId, runId: number): Promise<StageRunOutcome> {
    if (!isCurrentRun(runId)) return 'cancelled';
    stages = setStageStatus(stages, id, 'running');
    if (id === 'content') contentProgress = null;
    await journalStageStart(id);

    let skipStage!: () => void;
    let retryStage!: () => void;
    const controlPromise = new Promise<'skipped' | 'retry'>((resolve) => {
      skipStage = () => resolve('skipped');
      retryStage = () => resolve('retry');
    });
    const control: ActiveStageControl = {
      runId,
      stageId: id,
      skip: skipStage,
      retry: retryStage,
      skipped: false,
    };
    activeStageControl = control;

    const workPromise = invokeStageCommand(id, runId).then(
      () => ({ kind: 'done' as const }),
      (err) => ({ kind: 'failed' as const, err }),
    );
    const result = await Promise.race([
      workPromise,
      controlPromise.then((kind) => ({ kind })),
    ]);

    if (activeStageControl === control) {
      activeStageControl = null;
    }

    if (!isCurrentRun(runId)) return 'cancelled';

    if (result.kind === 'retry') {
      stages = setStageStatus(stages, id, 'pending');
      if (id === 'content') contentProgress = null;
      return 'retry';
    }

    if (result.kind === 'skipped') {
      const message = 'Skipped after timeout';
      stages = setStageStatus(stages, id, 'failed', message);
      await journalStageFailure(id, message);
      return 'failed';
    }

    if (control.skipped) return 'cancelled';
    if (result.kind === 'done') {
      stages = setStageStatus(stages, id, 'ok');
      await journalStageOk(id);
      return 'ok';
    }
    if (result.kind === 'failed') {
      const message = errorMessage(result.err);
      stages = setStageStatus(stages, id, 'failed', message);
      await journalStageFailure(id, message);
      return 'failed';
    }
    return 'cancelled';
  }

  async function runSetup(runId: number, startStage: StageId = STAGE_ORDER[0]) {
    const startIndex = Math.max(0, STAGE_ORDER.indexOf(startStage));
    for (const id of STAGE_ORDER.slice(startIndex)) {
      if (!isCurrentRun(runId)) return;
      let outcome: StageRunOutcome;
      do {
        outcome = await runStage(id, runId);
      } while (outcome === 'retry' && isCurrentRun(runId));
      if (outcome === 'cancelled') return;
      if (id === 'content' && outcome === 'failed') {
        skipReadyStage = null;
        return;
      }
      if (isCurrentRun(runId)) {
        skipReadyStage = null;
      }
    }

    if (isCurrentRun(runId) && !completed && allSettled(stages)) {
      completed = true;
      await journalInstallComplete();
      onsetupcomplete?.(setupCompletionResult(stages));
    }
  }

  async function startSetupRun() {
    const runId = beginSetupRun();
    if (installPath) effectiveInstallPath = installPath;
    await listenForProgress(runId);
    await loadStagingSource();
    let startStage: StageId = STAGE_ORDER[0];
    try {
      const manifest = await invoke<InstallManifest>('read_install_manifest');
      effectiveInstallPath = manifest.installPath || effectiveInstallPath;
      startStage = resumeStartStageFromManifest(manifest);
      stages = buildStagesFromManifest(manifest, startStage);
    } catch {
      // Missing/corrupt manifests fall back to a fresh run.
    }
    if (!isCurrentRun(runId)) return;
    await runSetup(runId, startStage);
  }

  function cancelSetupRun() {
    setupCancelled = true;
    unlistenInstallProgress?.();
    unlistenInstallProgress = null;
    unlistenContentProgress?.();
    unlistenContentProgress = null;
    void cancelForegroundWork(currentRunId);
  }

  function handleSkipCurrentStage(stageId: StageId) {
    const control = activeStageControl;
    if (!control || control.stageId !== stageId || stageId !== currentStageId) {
      return;
    }
    control.skipped = true;
    skipReadyStage = null;
    void cancelForegroundWork(control.runId);
    control.skip();
  }

  function retryActiveContentStage(control: ActiveStageControl) {
    contentRetryInFlight = true;
    skipReadyStage = null;
    void cancelActiveContentHandles(control.runId).finally(() => {
      contentRetryInFlight = false;
    });
    control.retry();
  }

  function handleRetryContentStage() {
    if (!contentRetryEligible || contentRetryInFlight) return;
    const control = activeStageControl;
    if (control && control.stageId === 'content' && currentStageId === 'content') {
      retryActiveContentStage(control);
      return;
    }

    if (currentStageId !== null) return;
    contentRetryInFlight = true;
    void runSetup(currentRunId, 'content').finally(() => {
      contentRetryInFlight = false;
    });
  }

  function formatBytes(bytes: number | null | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      return '';
    }
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = units[0];
    for (let i = 1; i < units.length && value >= 1024; i += 1) {
      value /= 1024;
      unit = units[i];
    }
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
  }

  function contentProgressText(): string | null {
    if (!contentProgress) return null;
    if (contentProgress.message) {
      if (typeof contentProgress.percent === 'number') {
        return `${contentProgress.message} (${contentProgress.percent}%)`;
      }
      return contentProgress.message;
    }
    const prefix =
      contentProgress.phase === 'extract' ? 'Extracting template' : 'Downloading template';
    if (typeof contentProgress.percent === 'number') {
      return `${prefix} (${contentProgress.percent}%)`;
    }
    const received = formatBytes(contentProgress.receivedBytes);
    return received ? `${prefix} (${received})` : prefix;
  }

  onMount(() => {
    void startSetupRun();
  });

  $effect(() => {
    const activeId = currentStageId;
    const done = setupDone;
    let creep = 0;
    stageCreep = creep;

    if (done || activeId === null) return;

    const interval = window.setInterval(() => {
      creep += (0.92 - creep) * 0.14;
      stageCreep = creep;
    }, 1200);

    return () => {
      window.clearInterval(interval);
    };
  });

  $effect(() => {
    const activeId = currentStageId;
    const done = setupDone;
    skipReadyStage = null;

    if (done || activeId === null) return;

    const startedAt = Date.now();
    const threshold = stageSkipThresholdMs(activeId);
    const timeout = window.setTimeout(() => {
      if (
        isStageSkipEligible({
          activeStageId: currentStageId,
          stageId: activeId,
          elapsedMs: Date.now() - startedAt,
          setupDone,
        })
      ) {
        skipReadyStage = activeId;
      }
    }, threshold);

    return () => {
      window.clearTimeout(timeout);
    };
  });

  onDestroy(() => {
    cancelSetupRun();
  });
</script>

<div class="setup-screen" data-testid="onboarding-setup">
  <div class="setup-header">
    <p class="eyebrow">Orchestrator Framework</p>
    <h1>Setting up HQ...</h1>
    <p class="progress-copy">
      {overallPercent}% &middot; {settledCount} of {STAGE_ORDER.length} stages complete
    </p>
    <div
      class="progress-track"
      class:running={currentStageId !== null && !setupDone}
      aria-label="Setup progress"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={overallPercent}
      role="progressbar"
    >
      <span style={`width: ${progressFillPercent}%`}></span>
    </div>
    <button
      type="button"
      class="staging-toggle"
      class:active={stagingSource}
      disabled={stagingToggleDisabled}
      onclick={handleToggleStagingSource}
      role="switch"
      aria-checked={stagingSource}
    >
      <span class="toggle-knob" aria-hidden="true"></span>
      <span>Staging template</span>
    </button>
  </div>

  <ol class="stage-list" aria-label="Setup stages">
    {#each stages as stage}
      <li
        class:current={stage.id === currentStageId}
        class:pending={stage.status === 'pending'}
        class:running={stage.status === 'running'}
        class:ok={stage.status === 'ok'}
        class:failed={stage.status === 'failed'}
      >
        {#if stage.status === 'running'}
          <span class="stage-spinner" aria-hidden="true"></span>
        {:else}
          <span class="status-dot" aria-hidden="true"></span>
        {/if}
        <span class="stage-main">
          <span class="stage-label">{stage.label}</span>
          {#if stage.status === 'running'}
            {@const contentPercent =
              stage.id === 'content' && typeof contentProgress?.percent === 'number'
                ? contentProgress.percent
                : null}
            <span
              class="stage-progress"
              class:determinate={contentPercent !== null}
              class:indeterminate={contentPercent === null}
              aria-hidden="true"
            >
              <span style={contentPercent !== null ? `width: ${contentPercent}%` : undefined}></span>
            </span>
            {#if stage.id === 'content' && contentProgressText()}
              <span class="stage-detail" class:slow={contentProgress?.slow || contentProgress?.stalled}>
                {contentProgressText()}
              </span>
            {/if}
            {#if skipReadyStage === stage.id}
              <span class="skip-affordance">
                <span>This step is taking longer than expected.</span>
                <button type="button" onclick={() => handleSkipCurrentStage(stage.id)}>
                  Skip this step
                </button>
              </span>
            {/if}
          {/if}
          {#if stage.id === 'content' && contentRetryEligible}
            <span class="retry-affordance">
              <span>
                {stage.status === 'running'
                  ? 'Template download stalled.'
                  : 'Template setup did not complete.'}
              </span>
              <button type="button" onclick={handleRetryContentStage}>
                Retry
              </button>
            </span>
          {/if}
          {#if stage.error}
            <span class="stage-error">{stage.error}</span>
          {/if}
        </span>
        <span class="stage-status">{stage.status}</span>
      </li>
    {/each}
  </ol>
</div>

<style>
  .setup-screen {
    display: flex;
    flex-direction: column;
    gap: var(--space-5, 20px);
    width: 100%;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
  }

  .setup-header {
    display: grid;
    gap: var(--space-2, 8px);
  }

  .eyebrow {
    margin: 0;
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
    font-size: var(--text-xs, 12px);
    font-weight: 700;
    line-height: 1.2;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    color: var(--popover-text-heading, #ffffff);
    font-size: 28px;
    font-weight: 600;
    line-height: 1.15;
  }

  .progress-copy {
    margin: 0;
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
    font-size: var(--text-sm, 13px);
    line-height: 1.4;
  }

  .progress-track {
    position: relative;
    width: 100%;
    height: 8px;
    overflow: hidden;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
  }

  .progress-track.running::after {
    position: absolute;
    inset: 0;
    width: 42%;
    border-radius: inherit;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.32),
      transparent
    );
    content: '';
    transform: translateX(-120%);
    animation: setup-progress-sweep 1.35s ease-in-out infinite;
  }

  .progress-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--popover-primary, #ffffff);
    transition: width 0.18s ease;
  }

  .staging-toggle {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: var(--space-2, 8px);
    min-height: 30px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
    font: inherit;
    font-size: var(--text-xs, 12px);
    font-weight: 650;
    cursor: pointer;
  }

  .staging-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .toggle-knob {
    position: relative;
    width: 34px;
    height: 20px;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.09);
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease;
  }

  .toggle-knob::after {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 12px;
    height: 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.78);
    content: '';
    transition: transform 0.12s ease;
  }

  .staging-toggle.active .toggle-knob {
    border-color: rgba(125, 211, 168, 0.7);
    background: rgba(125, 211, 168, 0.22);
  }

  .staging-toggle.active .toggle-knob::after {
    background: #7dd3a8;
    transform: translateX(14px);
  }

  .stage-list {
    display: grid;
    gap: var(--space-2, 8px);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3, 12px);
    min-height: 42px;
    padding: var(--space-3, 12px);
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.14));
    border-radius: var(--radius-sm, 8px);
    background: rgba(255, 255, 255, 0.05);
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
  }

  li.current {
    border-color: rgba(255, 255, 255, 0.36);
    background: rgba(255, 255, 255, 0.1);
    color: var(--popover-text-heading, #ffffff);
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border: 1px solid currentColor;
    border-radius: 999px;
    background: transparent;
  }

  li.running .status-dot {
    background: #ffffff;
    box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.12);
  }

  .stage-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.28);
    border-top-color: #ffffff;
    border-radius: 999px;
    animation: setup-spinner 0.8s linear infinite;
  }

  li.ok .status-dot {
    border-color: #7dd3a8;
    background: #7dd3a8;
  }

  li.failed .status-dot {
    border-color: #f2a6a6;
    background: #f2a6a6;
  }

  .stage-main {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .stage-label {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: var(--text-sm, 13px);
    font-weight: 650;
    line-height: 1.25;
  }

  .stage-error {
    min-width: 0;
    overflow-wrap: anywhere;
    color: rgba(255, 210, 210, 0.78);
    font-size: var(--text-xs, 12px);
    line-height: 1.35;
  }

  .stage-detail {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
    font-size: var(--text-xs, 12px);
    line-height: 1.35;
  }

  .stage-detail.slow {
    color: rgba(255, 226, 166, 0.82);
  }

  .stage-progress {
    position: relative;
    display: block;
    width: min(220px, 100%);
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.11);
  }

  .stage-progress span {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
  }

  .stage-progress.indeterminate span {
    width: 46%;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.82),
      transparent
    );
    animation: setup-stage-sweep 1.05s ease-in-out infinite;
  }

  .stage-progress.determinate span {
    background: var(--popover-primary, #ffffff);
    transition: width 0.18s ease;
  }

  .skip-affordance,
  .retry-affordance {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2, 8px);
    padding-top: 2px;
    color: rgba(255, 226, 166, 0.88);
    font-size: var(--text-xs, 12px);
    line-height: 1.35;
  }

  .retry-affordance {
    color: rgba(255, 210, 210, 0.82);
  }

  .skip-affordance button,
  .retry-affordance button {
    appearance: none;
    min-height: 28px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.72);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.92);
    color: #111113;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .skip-affordance button:hover,
  .retry-affordance button:hover {
    background: #ffffff;
  }

  .skip-affordance button:focus-visible,
  .retry-affordance button:focus-visible,
  .staging-toggle:focus-visible {
    outline: 2px solid var(--popover-highlight, rgba(255, 255, 255, 0.34));
    outline-offset: 2px;
  }

  .stage-status {
    color: inherit;
    font-size: var(--text-xs, 12px);
    font-weight: 700;
    line-height: 1.2;
    text-transform: uppercase;
  }

  li.ok .stage-status {
    color: #9ae6b9;
  }

  li.failed .stage-status {
    color: #f8b4b4;
  }

  li.running .stage-status,
  li.running .stage-label {
    background-image:
      linear-gradient(
        90deg,
        transparent calc(50% - 2.5em),
        #ffffff,
        transparent calc(50% + 2.5em)
      ),
      linear-gradient(currentColor, currentColor);
    background-repeat: no-repeat;
    background-size: 250% 100%, auto;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: setup-text-shimmer 2s linear infinite;
  }

  @keyframes setup-progress-sweep {
    0% {
      transform: translateX(-120%);
    }

    100% {
      transform: translateX(260%);
    }
  }

  @keyframes setup-stage-sweep {
    0% {
      transform: translateX(-115%);
    }

    100% {
      transform: translateX(250%);
    }
  }

  @keyframes setup-spinner {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes setup-text-shimmer {
    0% {
      background-position: 100% center, 0 0;
    }

    100% {
      background-position: 0% center, 0 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-track.running::after,
    .stage-progress.indeterminate span,
    .stage-spinner,
    li.running .stage-status,
    li.running .stage-label {
      animation: none;
    }

    li.running .stage-status,
    li.running .stage-label {
      background-image: none;
      color: inherit;
      -webkit-text-fill-color: currentColor;
    }
  }

  @media (max-width: 640px) {
    h1 {
      font-size: 24px;
    }

    li {
      grid-template-columns: 16px minmax(0, 1fr);
    }

    .stage-status {
      grid-column: 2;
      justify-self: start;
    }
  }
</style>
