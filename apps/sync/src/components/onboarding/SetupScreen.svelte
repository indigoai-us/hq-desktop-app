<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { onDestroy, onMount } from 'svelte';
  import {
    allSettled,
    buildInitialStages,
    setStageStatus,
    setupProgressPercent,
    stageCommandInvocations,
    stageTimeoutMs,
    StageTimeoutError,
    STAGE_ORDER,
    withTimeout,
    type StageId,
    type StageState,
  } from '../../lib/onboarding-setup';

  interface Props {
    installPath: string | null;
    onsetupcomplete?: () => void;
  }

  let { installPath, onsetupcomplete }: Props = $props();

  let stages = $state<StageState[]>(buildInitialStages());
  let completed = $state(false);
  let stageCreep = $state(0);
  let currentRunId = 0;
  let setupCancelled = false;
  let unlistenInstallProgress: UnlistenFn | null = null;
  const activeInstallHandles = new Set<string>();

  const settledCount = $derived(
    stages.filter((stage) => stage.status === 'ok' || stage.status === 'failed')
      .length,
  );
  const currentStageId = $derived(
    stages.find((stage) => stage.status === 'running')?.id ?? null,
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

  function beginSetupRun(): number {
    currentRunId += 1;
    setupCancelled = false;
    activeInstallHandles.clear();
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

  async function listenForInstallProgress(runId: number): Promise<void> {
    const unlisten = await listen<InstallProgressPayload>(
      'install:progress',
      (event) => trackInstallProgress(runId, event.payload),
    );
    if (!isCurrentRun(runId)) {
      unlisten();
      return;
    }
    unlistenInstallProgress = unlisten;
  }

  function invokeDesktopCommand(command: string, args?: Record<string, unknown>) {
    return args === undefined ? invoke(command) : invoke(command, args);
  }

  async function invokeStageCommand(id: StageId, runId: number): Promise<void> {
    const invocations = stageCommandInvocations(id, { installPath });
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
      try {
        await withTimeout(
          Promise.resolve(
            invokeDesktopCommand(invocation.command, invocation.args),
          ),
          ms,
          () => new StageTimeoutError(id, ms),
          () => {
            void cancelActiveInstallHandles(runId);
          },
        );
      } catch (err) {
        if (invocation.required) throw err;
      }
    }
  }

  async function runSetup(runId: number) {
    for (const id of STAGE_ORDER) {
      if (!isCurrentRun(runId)) return;
      stages = setStageStatus(stages, id, 'running');

      try {
        await invokeStageCommand(id, runId);
        if (!isCurrentRun(runId)) return;
        stages = setStageStatus(stages, id, 'ok');
      } catch (err) {
        if (!isCurrentRun(runId)) return;
        stages = setStageStatus(stages, id, 'failed', errorMessage(err));
      }
    }

    if (isCurrentRun(runId) && !completed && allSettled(stages)) {
      completed = true;
      onsetupcomplete?.();
    }
  }

  async function startSetupRun() {
    const runId = beginSetupRun();
    await listenForInstallProgress(runId);
    if (!isCurrentRun(runId)) return;
    await runSetup(runId);
  }

  function cancelSetupRun() {
    setupCancelled = true;
    unlistenInstallProgress?.();
    unlistenInstallProgress = null;
    void cancelActiveInstallHandles(currentRunId);
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
            <span class="stage-progress" aria-hidden="true"><span></span></span>
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
    width: 46%;
    border-radius: inherit;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.82),
      transparent
    );
    animation: setup-stage-sweep 1.05s ease-in-out infinite;
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
    .stage-progress span,
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
