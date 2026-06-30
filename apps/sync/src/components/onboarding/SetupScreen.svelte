<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';
  import {
    allSettled,
    buildInitialStages,
    setStageStatus,
    STAGE_COMMAND,
    STAGE_ORDER,
    type StageId,
    type StageState,
  } from '../../lib/onboarding-setup';

  let { onsetupcomplete } = $props();

  let stages = $state<StageState[]>(buildInitialStages());
  let completed = $state(false);

  const settledCount = $derived(
    stages.filter((stage) => stage.status === 'ok' || stage.status === 'failed')
      .length,
  );
  const currentStageId = $derived(
    stages.find((stage) => stage.status === 'running')?.id ?? null,
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

  async function invokeStageCommand(id: StageId): Promise<void> {
    const command = STAGE_COMMAND[id];
    if (!command) return;
    if (typeof invoke !== 'function') {
      throw new Error('The desktop bridge is not available in this environment.');
    }

    // The per-stage Rust backends (deps installers, provision, git_init,
    // personalize, import, indexing, install_menubar_app) are pending and will
    // be wired/verified on the clean VM.
    await invoke(command);
  }

  async function runSetup() {
    for (const id of STAGE_ORDER) {
      stages = setStageStatus(stages, id, 'running');

      try {
        await invokeStageCommand(id);
        stages = setStageStatus(stages, id, 'ok');
      } catch (err) {
        stages = setStageStatus(stages, id, 'failed', errorMessage(err));
      }
    }

    if (!completed && allSettled(stages)) {
      completed = true;
      onsetupcomplete?.();
    }
  }

  onMount(() => {
    void runSetup();
  });
</script>

<div class="setup-screen" data-testid="onboarding-setup">
  <div class="setup-header">
    <p class="eyebrow">Orchestrator Framework</p>
    <h1>Setting up HQ...</h1>
    <p class="progress-copy">{settledCount} of {STAGE_ORDER.length} stages complete</p>
    <div
      class="progress-track"
      aria-label="Setup progress"
      aria-valuemin="0"
      aria-valuemax={STAGE_ORDER.length}
      aria-valuenow={settledCount}
      role="progressbar"
    >
      <span style={`width: ${(settledCount / STAGE_ORDER.length) * 100}%`}></span>
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
        <span class="status-dot" aria-hidden="true"></span>
        <span class="stage-main">
          <span class="stage-label">{stage.label}</span>
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
    width: 100%;
    height: 8px;
    overflow: hidden;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
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
