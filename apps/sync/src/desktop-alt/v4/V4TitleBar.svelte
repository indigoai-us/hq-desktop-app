<script lang="ts">
  import type { SyncState } from '../lib/sync-model';
    import CopyPromptButton from '../../components/CopyPromptButton.svelte';
  import OpenInClaudeCodeButton from '../../components/OpenInClaudeCodeButton.svelte';
  import { getV4TitleBarModel, type V4HydrationIssue } from './model';
  import './tokens.css';

  /**
   * Compact native title bar (DESKTOP-001): traffic-light inset, sidebar
   * toggle, live sync status, command search, contextual sync action, and
   * account control. Liquid Glass lives on this chrome only. Tauri drag
   * regions are limited to noninteractive padded spacers — never the whole
   * header and never interactive controls.
   */
  interface Props {
    syncState: SyncState;
    /** Connected workspaces being watched (companies + personal). */
    watchedCount: number;
    /** Human relative last-sync label ("just now", "5m ago"). */
    lastSyncLabel?: string | null;
    /** Company currently transferring, while syncing. */
    syncingCompany?: string | null;
    fanoutDone?: number;
    fanoutTotal?: number;
    /** Plain-language error summary, for error states. */
    errorSummary?: string | null;
    /** Failed desktop hydration while cached surfaces remain visible. */
    hydrationIssue?: V4HydrationIssue | null;
    /** The newest hydration request is still resolving. */
    hydrationRefreshing?: boolean;
    errorMessage?: string;
    errorCompany?: string | null;
    conflictCount?: number;
    conflictCompany?: string | null;
    hqFolderPath?: string | null;
    /** Current workspace name shown at the left of the bar (Figma 2588:4406). */
    workspaceName?: string | null;
    /** Cloud sync toggle state for the active workspace; null hides it. */
    cloudOn?: boolean | null;
    oncloudtoggle?: (next: boolean) => void;
    onsync?: () => void | Promise<void>;
    oncancel?: () => void | Promise<void>;
    onretry?: () => void | Promise<void>;
    onretryhydration?: () => void | Promise<void>;
    onresolveconflicts?: () => void | Promise<void>;
    oncommand?: () => void;
  }

  let {
    syncState,
    watchedCount,
    lastSyncLabel = null,
    syncingCompany = null,
    fanoutDone = 0,
    fanoutTotal = 0,
    errorSummary = null,
    hydrationIssue = null,
    hydrationRefreshing = false,
    errorMessage = '',
    errorCompany = null,
    conflictCount = 0,
    conflictCompany = null,
    hqFolderPath = null,
    workspaceName = null,
    cloudOn = null,
    oncloudtoggle,
    onsync,
    oncancel,
    onretry,
    onretryhydration,
    onresolveconflicts,
    oncommand,
  }: Props = $props();

  const model = $derived(
    getV4TitleBarModel({
      syncState,
      watchedCount,
      lastSyncLabel,
      syncingCompany,
      fanoutDone,
      fanoutTotal,
      errorSummary,
      hydrationIssue,
    }),
  );

  const statusLine = $derived.by(() => {
    if (syncState === 'idle' && lastSyncLabel) return `Synced ${lastSyncLabel}`;
    return model.sentence;
  });


  let actionPending = $state(false);
  let actionError = $state<string | null>(null);
  let actionErrorDetail = $state('');
  let actionContext = '';

  async function handleAction(): Promise<void> {
    if (actionPending) return;
    actionPending = true;
    actionError = null;
    actionErrorDetail = '';
    try {
      if (model.recovery === 'hydration') await onretryhydration?.();
      else if (model.action.id === 'cancel') await oncancel?.();
      else if (model.action.id === 'retry') await onretry?.();
      else if (model.action.id === 'resolve') await onresolveconflicts?.();
      else await onsync?.();
    } catch (err) {
      console.error(`titlebar: ${model.action.id} action failed`, err);
      actionErrorDetail = err instanceof Error ? err.message : String(err);
      actionError =
        model.recovery === 'hydration'
          ? 'Couldn’t refresh'
          : model.action.id === 'cancel'
            ? 'Couldn’t cancel'
            : model.action.id === 'resolve'
              ? 'Couldn’t open conflicts'
              : syncState === 'auth-error'
                ? 'Couldn’t start sign-in'
                : model.action.id === 'retry'
                  ? 'Couldn’t retry'
                  : 'Couldn’t start sync';
    } finally {
      actionPending = false;
    }
  }

  $effect(() => {
    const nextContext = `${syncState}:${model.recovery ?? ''}:${model.action.id}`;
    if (nextContext === actionContext) return;
    actionContext = nextContext;
    actionError = null;
    actionErrorDetail = '';
  });


</script>

<header class="v4-titlebar" aria-label="Window chrome">
  <div class="v4-titlebar-leading">
    <!-- Padded dead space under the native traffic lights — safe drag only. -->
    <div class="v4-drag-pad v4-drag-lights" data-tauri-drag-region aria-hidden="true"></div>
  </div>

  <div class="v4-status" aria-live="polite">
    {#if workspaceName}
      <span class="v4-ws-name">{workspaceName}</span>
    {/if}
    <span
      class={`v4-dot ${model.tone}`}
      class:pulsing={syncState === 'syncing'}
      aria-hidden="true"
    ></span>
    <span class="v4-sentence">{statusLine}</span>
  </div>

  <!-- Flexible noninteractive pad between status and actions — primary drag. -->
  <div class="v4-drag-pad v4-drag-flex" data-tauri-drag-region aria-hidden="true"></div>

  <div class="v4-title-actions">
    {#if actionError}
      <span class="v4-action-error" role="alert" title={actionErrorDetail}>
        {actionError}
      </span>
    {/if}
    <button
      type="button"
      class="v4-icon-btn"
      aria-label="Open command palette"
      title="Open command palette (⌘K)"
      onclick={() => oncommand?.()}
    >
      <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.25" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
      </svg>
    </button>
    {#if cloudOn !== null}
      <button
        type="button"
        class="v4-cloud"
        role="switch"
        aria-checked={cloudOn}
        aria-label="Cloud sync"
        data-tauri-drag-region="false"
        onclick={() => oncloudtoggle?.(!cloudOn)}
      >
        <span class="v4-cloud-track" class:on={cloudOn}>
          <span class="v4-cloud-thumb"></span>
        </span>
        <span class="v4-cloud-label">{cloudOn ? 'Cloud Connected' : 'Cloud Off'}</span>
      </button>
    {/if}
    {#if model.recovery === 'hydration'}
      <button
        type="button"
        class="v4-action"
        disabled={hydrationRefreshing || actionPending}
        aria-busy={hydrationRefreshing || actionPending}
        onclick={handleAction}
      >
        {hydrationRefreshing || actionPending ? 'Retrying…' : 'Retry'}
      </button>
    {:else if syncState === 'conflict'}
      <div class="v4-recovery-actions" data-tauri-drag-region="false">
        <button
          type="button"
          class="v4-action"
          onclick={handleAction}
          disabled={actionPending}
          aria-busy={actionPending}
        >
          {actionPending ? 'Opening…' : 'Resolve conflicts'}
        </button>
        <CopyPromptButton
          variant="inline"
          label="Copy prompt"
          issue={{
            kind: 'sync-conflict',
            payload: { count: conflictCount, company: conflictCompany },
          }}
        />
      </div>
    {:else if syncState === 'error' && errorMessage}
      <div class="v4-recovery-actions" data-tauri-drag-region="false">
        <button
          type="button"
          class="v4-action"
          onclick={handleAction}
          disabled={actionPending}
          aria-busy={actionPending}
        >
          {actionPending ? 'Retrying…' : 'Retry'}
        </button>
        <OpenInClaudeCodeButton
          variant="inline"
          label="Finish sync in Claude Code"
          folder={hqFolderPath ?? ''}
          issue={{ kind: 'sync-failed', payload: { message: errorMessage, company: errorCompany } }}
        />
        <CopyPromptButton
          variant="inline"
          label="Copy prompt"
          issue={{ kind: 'sync-failed', payload: { message: errorMessage, company: errorCompany } }}
        />
      </div>
    {:else}
      <button
        type="button"
        class="v4-action"
        onclick={handleAction}
        disabled={actionPending}
        aria-busy={actionPending}
      >
        {actionPending
          ? model.action.id === 'cancel'
            ? 'Cancelling…'
            : 'Starting…'
          : model.action.label === 'Sync Now'
            ? 'Sync'
            : model.action.label}
      </button>
    {/if}
  </div>
</header>

<style>
  .v4-titlebar {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 0 0 auto;
    height: 100%;
    overflow: visible;
    padding: 0 24px 0 0;
    border-bottom: 1px solid color-mix(in srgb, var(--v4-text-1) 5%, transparent);
    background: var(--v4-chrome);
    backdrop-filter: var(--v4-glass-filter);
    -webkit-backdrop-filter: var(--v4-glass-filter);
    box-shadow: inset 0 1px 0 var(--v4-glass-highlight);
    font-family: var(--font-sans);
  }

  .v4-titlebar-leading {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 4px;
    padding-left: 24px;
  }

  /* Windows uses the native decorated title bar (system controls + Snap
     Layouts). The HQ toolbar sits below it — no macOS traffic-light gutter. */
  :global(html[data-platform='windows']) .v4-titlebar-leading {
    padding-left: 12px;
  }

  :global(html[data-platform='windows']) .v4-drag-lights {
    width: 0;
    display: none;
  }

  .v4-drag-pad {
    flex: 0 0 auto;
    align-self: stretch;
    min-height: 100%;
  }

  .v4-drag-lights {
    width: 8px;
  }

  .v4-drag-flex {
    flex: 1 1 auto;
    min-width: 12px;
  }

  .v4-ws-name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--v4-text-1);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.16px;
    line-height: 20px;
    margin-right: 8px;
  }

  .v4-status {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    min-width: 0;
    max-width: 42%;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    /* Status is display-only — do not steal drag or clicks. */
    pointer-events: none;
  }

  .v4-dot {
    flex: 0 0 6px;
    width: 6px;
    height: 6px;
    border-radius: var(--v4-radius-pill);
  }

  .v4-dot.ok {
    background: var(--v4-ok);
  }

  .v4-dot.warn {
    background: var(--v4-warn);
  }

  .v4-dot.error {
    background: var(--v4-error);
  }

  .v4-dot.idle {
    background: var(--v4-idle);
  }

  .v4-dot.pulsing {
    animation: v4-dot-pulse 1.4s ease-in-out infinite;
  }

  @keyframes v4-dot-pulse {
    0%,
    100% {
      opacity: 1;
    }

    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .v4-dot.pulsing {
      animation: none;
    }
  }

  .v4-sentence {
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
  }

  .v4-meta {
    overflow: hidden;
    min-width: 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-xs));
    font-weight: 400;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .v4-title-actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 6px;
  }

  .v4-action-error {
    max-width: 150px;
    overflow: hidden;
    color: var(--v4-error);
    font-size: var(--type-metadata, 10px);
    font-weight: 550;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }


  .v4-icon-btn {
    appearance: none;
    -webkit-appearance: none;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    cursor: pointer;
  }

  /* Native macOS toolbar behavior: borderless icon at rest, subtle rounded
     fill on hover/press only — no persistent selected box. */
  .v4-icon-btn:hover {
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .v4-icon-btn:active {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .v4-icon-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-icon {
    width: 16px;
    height: 16px;
  }

  /* Figma 2588:4442 — green pill switch + secondary label. */
  .v4-cloud {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 10px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    cursor: pointer;
  }

  .v4-cloud-track {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    width: 28px;
    height: 16px;
    padding: 2px;
    box-sizing: border-box;
    border-radius: 999px;
    background: var(--v4-idle);
    transition: background 0.15s;
  }

  .v4-cloud-track.on {
    justify-content: flex-end;
    background: #04c950;
  }

  .v4-cloud-thumb {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    background: #ffffff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }

  .v4-cloud-label {
    font-size: 13px;
    line-height: 16px;
    color: var(--v4-text-2);
    white-space: nowrap;
  }

  .v4-cloud:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 2px;
    border-radius: 6px;
  }

  /* Standard secondary button (onboarding language): borderless fill,
     8px radius, opacity hover, gentle scale press. */
  .v4-action {
    flex: 0 0 auto;
    height: 32px;
    padding: 0 12px;
    border: none;
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
  }

  .v4-action:hover:not(:disabled) {
    opacity: 0.88;
  }

  .v4-action:active:not(:disabled) {
    transform: scale(0.97);
  }

  .v4-action:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .v4-action:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-recovery-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
  }

  .v4-recovery-actions :global(button) {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    padding-block: 0;
    line-height: 1;
  }

  @media (prefers-reduced-transparency: reduce) {
    .v4-titlebar {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: none;
    }
  }
</style>
