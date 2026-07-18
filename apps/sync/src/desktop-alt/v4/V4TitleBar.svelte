<script lang="ts">
  import type { SyncState } from '../lib/sync-model';
  import CopyPromptButton from '../../components/CopyPromptButton.svelte';
  import OpenInClaudeCodeButton from '../../components/OpenInClaudeCodeButton.svelte';
  import { getV4TitleBarModel } from './model';
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
    errorMessage?: string;
    errorCompany?: string | null;
    hqFolderPath?: string | null;
    /** Account initials for the profile control (e.g. "CE"). */
    accountInitials?: string | null;
    sidebarCollapsed?: boolean;
    onsync?: () => void;
    oncancel?: () => void;
    onretry?: () => void;
    ontogglesidebar?: () => void;
    oncommand?: () => void;
    onaccount?: () => void;
  }

  let {
    syncState,
    watchedCount,
    lastSyncLabel = null,
    syncingCompany = null,
    fanoutDone = 0,
    fanoutTotal = 0,
    errorSummary = null,
    errorMessage = '',
    errorCompany = null,
    hqFolderPath = null,
    accountInitials = null,
    sidebarCollapsed = false,
    onsync,
    oncancel,
    onretry,
    ontogglesidebar,
    oncommand,
    onaccount,
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
    }),
  );

  const initials = $derived((accountInitials ?? 'HQ').slice(0, 2).toUpperCase());

  function handleAction() {
    if (model.action.id === 'cancel') oncancel?.();
    else if (model.action.id === 'retry') onretry?.();
    else onsync?.();
  }
</script>

<header class="v4-titlebar" aria-label="Window chrome">
  <div class="v4-titlebar-leading">
    <!-- Padded dead space under the native traffic lights — safe drag only. -->
    <div class="v4-drag-pad v4-drag-lights" data-tauri-drag-region aria-hidden="true"></div>
    <button
      type="button"
      class="v4-icon-btn"
      class:active={!sidebarCollapsed}
      aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-pressed={!sidebarCollapsed}
      onclick={() => ontogglesidebar?.()}
    >
      <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" stroke="currentColor" stroke-width="1.2" />
        <path d="M5.25 2.5v11" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
  </div>

  <div class="v4-status" aria-live="polite">
    <span
      class={`v4-dot ${model.tone}`}
      class:pulsing={syncState === 'syncing'}
      aria-hidden="true"
    ></span>
    <span class="v4-sentence">{syncState === 'error' ? 'Sync initialized' : model.sentence}</span>
    {#if syncState === 'error'}
      <span class="v4-meta">Click the button to finish sync in Claude Code.</span>
    {:else if model.meta}
      <span class="v4-meta">{model.meta}</span>
    {/if}
  </div>

  <!-- Flexible noninteractive pad between status and actions — primary drag. -->
  <div class="v4-drag-pad v4-drag-flex" data-tauri-drag-region aria-hidden="true"></div>

  <div class="v4-title-actions">
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
    {#if syncState === 'error' && errorMessage}
      <div class="v4-recovery-actions" data-tauri-drag-region="false">
        <button type="button" class="v4-action" onclick={onretry}>Retry</button>
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
      <button type="button" class="v4-action" onclick={handleAction}>
        {model.action.label === 'Sync Now' ? 'Sync' : model.action.label}
      </button>
    {/if}
    <button
      type="button"
      class="v4-account"
      aria-label="Account and settings"
      title="Account and settings"
      onclick={() => onaccount?.()}
    >
      {initials}
    </button>
  </div>
</header>

<style>
  .v4-titlebar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 40px;
    height: 40px;
    padding: 0 12px 0 0;
    border-bottom: 1px solid var(--v4-hairline);
    background: var(--v4-chrome);
    backdrop-filter: blur(22px) saturate(180%);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    box-shadow: inset 0 1px 0 var(--pop-highlight);
    font-family: var(--font-sans);
  }

  .v4-titlebar-leading {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 4px;
    /* 78px left inset clears the overlay traffic lights. */
    padding-left: 78px;
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

  .v4-status {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    min-width: 0;
    max-width: 42%;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
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

  .v4-icon-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button, 8px);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    cursor: pointer;
  }

  .v4-icon-btn:hover,
  .v4-icon-btn.active {
    border-color: var(--v4-hairline);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .v4-icon-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-icon {
    width: 14px;
    height: 14px;
  }

  .v4-action {
    flex: 0 0 auto;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
  }

  .v4-action:hover {
    background: var(--v4-active-row);
  }

  .v4-action:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-account {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-metadata, 10px);
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1;
    cursor: pointer;
  }

  .v4-account:hover {
    background: var(--v4-active-row);
  }

  .v4-account:focus-visible {
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
