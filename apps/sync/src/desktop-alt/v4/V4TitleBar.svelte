<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type { SyncState } from '../lib/sync-model';
  import type { SettingsTab } from '../route';
  import VersionPopout from '../components/VersionPopout.svelte';
  import CopyPromptButton from '../../components/CopyPromptButton.svelte';
  import OpenInClaudeCodeButton from '../../components/OpenInClaudeCodeButton.svelte';
  import { getV4TitleBarModel, type V4HydrationIssue } from './model';
  import { titlebarDayDate } from '../chat/sidebar-model';
  import type { HomeConflict } from './home-model';
  import CorePopover from './CorePopover.svelte';
  import './tokens.css';

  /**
   * Compact native title bar (DESKTOP-001 + US-003 chat chrome): traffic-light
   * inset, sidebar toggle, HQ wordmark, DAY · DATE, live sync status, meetings
   * / notifications stubs, Core pill, command search, contextual sync action,
   * and account control. Liquid Glass lives on this chrome only. Tauri drag
   * regions are limited to noninteractive padded spacers — never the whole
   * header and never interactive controls.
   */
  interface Props {
    version: string;
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
    /** Account initials for the profile control (e.g. "CE"). */
    accountInitials?: string | null;
    sidebarCollapsed?: boolean;
    onsync?: () => void | Promise<void>;
    oncancel?: () => void | Promise<void>;
    onretry?: () => void | Promise<void>;
    onretryhydration?: () => void | Promise<void>;
    onresolveconflicts?: () => void | Promise<void>;
    ontogglesidebar?: () => void;
    oncommand?: () => void;
    onaccount?: () => void;
    onOpenSettings?: (tab?: SettingsTab) => void;
    /** US-003 / US-012: meetings + notifications destinations. */
    onopenMeetings?: () => void;
    onopenNotifications?: () => void;
    /**
     * Unread notifications count for the bell badge (US-012). Hidden at 0;
     * display caps at 99+ (formatting owned by the caller or inline).
     */
    unreadCount?: number;
    /** V2 Cloud Off (US-001 / US-016): true when sync is paused on this device. */
    cloudPaused?: boolean;
    /** Live per-file conflicts for the Core popover rescue card (US-016). */
    conflicts?: HomeConflict[];
    oncloudtoggle?: (paused: boolean) => void;
    onresolveconflict?: (
      path: string,
      strategy: 'keep-local' | 'keep-remote',
    ) => void | Promise<void>;
    onopenconflict?: (path: string) => void | Promise<void>;
    onopendrift?: () => void | Promise<void>;
    /** US-016 / US-017: open Library overlay (stub route is fine). */
    onopenLibrary?: () => void;
    onopenMarketplace?: () => void;
  }

  let {
    version,
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
    accountInitials = null,
    sidebarCollapsed = false,
    onsync,
    oncancel,
    onretry,
    onretryhydration,
    onresolveconflicts,
    ontogglesidebar,
    oncommand,
    onaccount,
    onOpenSettings,
    onopenMeetings,
    onopenNotifications,
    unreadCount = 0,
    cloudPaused = false,
    conflicts = [],
    oncloudtoggle,
    onresolveconflict,
    onopenconflict,
    onopendrift,
    onopenLibrary,
    onopenMarketplace,
  }: Props = $props();

  const dayDateLabel = $derived(titlebarDayDate());

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

  const initials = $derived((accountInitials ?? 'HQ').slice(0, 2).toUpperCase());
  /** Bell badge: hide at 0, cap display at 99+. */
  const notificationsBadge = $derived.by(() => {
    const n = Number.isFinite(unreadCount) ? Math.floor(unreadCount) : 0;
    if (n <= 0) return null;
    return n > 99 ? '99+' : String(n);
  });
  let versionOpen = $state(false);
  let versionContainer: HTMLDivElement | null = $state(null);
  let coreOpen = $state(false);
  let coreContainer: HTMLDivElement | null = $state(null);
  let coreVersion = $state<string | null>(null);
  let coreVersionLoading = $state(true);
  let coreVersionError = $state(false);
  let actionPending = $state(false);
  let actionError = $state<string | null>(null);
  let actionErrorDetail = $state('');
  let actionContext = '';
  let coreVersionLoadGeneration = 0;
  const coreVersionLabel = $derived.by(() => {
    if (coreVersionLoading) return 'Core checking…';
    if (coreVersion) return `Core v${coreVersion}`;
    return coreVersionError ? 'Core unavailable' : 'Core not detected';
  });

  async function refreshCoreVersion() {
    const generation = ++coreVersionLoadGeneration;
    coreVersionLoading = true;
    coreVersionError = false;
    try {
      const next = await invoke<string | null>('get_hq_version');
      if (generation === coreVersionLoadGeneration) {
        coreVersion = next;
        coreVersionError = false;
      }
    } catch (err) {
      if (generation !== coreVersionLoadGeneration) return;
      console.error('titlebar: failed to read HQ Core version', err);
      coreVersion = null;
      coreVersionError = true;
    } finally {
      if (generation === coreVersionLoadGeneration) coreVersionLoading = false;
    }
  }

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

  $effect(() => {
    if (!versionOpen) return;

    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (versionContainer && !versionContainer.contains(event.target)) {
        versionOpen = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') versionOpen = false;
    }

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  $effect(() => {
    if (!coreOpen) return;

    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (coreContainer && !coreContainer.contains(event.target)) {
        coreOpen = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') coreOpen = false;
    }

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  $effect(() => {
    // Read once on mount and again whenever the update popout opens/closes so
    // a Core update completed in Settings becomes visible without relaunching.
    versionOpen;
    coreOpen;
    void refreshCoreVersion();
    return () => {
      coreVersionLoadGeneration += 1;
    };
  });
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
    <span class="v4-wordmark" data-testid="titlebar-wordmark" aria-label="HQ">HQ</span>
    <span class="v4-day-date" data-testid="titlebar-day-date">{dayDateLabel}</span>
  </div>

  <div class="v4-status" aria-live="polite">
    <span
      class={`v4-dot ${model.tone}`}
      class:pulsing={syncState === 'syncing'}
      aria-hidden="true"
    ></span>
    <span class="v4-sentence">{model.sentence}</span>
    {#if model.meta}
      <span class="v4-meta">{model.meta}</span>
    {/if}
  </div>

  <button
    type="button"
    class="v4-cloud-switch"
    class:off={cloudPaused}
    role="switch"
    aria-checked={!cloudPaused}
    data-testid="cloud-connected-switch"
    title={cloudPaused
      ? 'Cloud is off — sync is paused on this device'
      : 'Cloud connected — click to pause sync on this device'}
    onclick={() => oncloudtoggle?.(!cloudPaused)}
  >
    <span class={`v4-dot ${cloudPaused ? 'idle' : 'ok'}`} aria-hidden="true"></span>
    {cloudPaused ? 'Cloud Off' : 'Cloud Connected'}
  </button>

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
      data-testid="titlebar-meetings"
      aria-label="Meetings"
      title="Meetings"
      onclick={() => onopenMeetings?.()}
    >
      <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="4" width="12" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.2" />
        <circle cx="8" cy="8.25" r="2" stroke="currentColor" stroke-width="1.2" />
        <path d="M11.5 6.5l2-1.25v5.5L11.5 9.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
      </svg>
    </button>
    <button
      type="button"
      class="v4-icon-btn v4-notif-btn"
      data-testid="titlebar-notifications"
      aria-label={notificationsBadge
        ? `Notifications, ${notificationsBadge} unread`
        : 'Notifications'}
      title="Notifications"
      onclick={() => onopenNotifications?.()}
    >
      <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2.25a3.5 3.5 0 0 0-3.5 3.5v2.1l-1.2 1.8h9.4l-1.2-1.8V5.75A3.5 3.5 0 0 0 8 2.25Z"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
        <path d="M6.5 12.25a1.5 1.5 0 0 0 3 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
      {#if notificationsBadge}
        <span
          class="v4-notif-badge"
          data-testid="titlebar-notifications-badge"
          aria-hidden="true"
        >
          {notificationsBadge}
        </span>
      {/if}
    </button>
    <div class="v4-core-wrap" bind:this={coreContainer}>
      <button
        type="button"
        class="v4-core-pill"
        data-testid="titlebar-core-pill"
        title="Core"
        aria-expanded={coreOpen}
        aria-haspopup="dialog"
        aria-label="Open Core popover"
        onclick={() => {
          coreOpen = !coreOpen;
          if (coreOpen) versionOpen = false;
        }}
      >
        <span class="v4-core-dot" aria-hidden="true">●</span>
        Core
        <span class="v4-core-caret" aria-hidden="true">⌄</span>
      </button>
      {#if coreOpen}
        <CorePopover
          appVersion={version}
          {conflicts}
          {cloudPaused}
          onclose={() => (coreOpen = false)}
          onresolve={onresolveconflict}
          onopeneditor={onopenconflict}
          {onopendrift}
          onopenLibrary={() => {
            onopenLibrary?.();
            coreOpen = false;
          }}
          onopenMarketplace={() => {
            onopenMarketplace?.();
            coreOpen = false;
          }}
        />
      {/if}
    </div>
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
    <div class="v4-version-wrap" bind:this={versionContainer}>
      <button
        type="button"
        class="v4-version"
        data-testid="version-label"
        aria-expanded={versionOpen}
        aria-haspopup="dialog"
        aria-label={`HQ desktop app v${version}; ${coreVersionLabel}; ${
          coreVersionError ? 'retry Core version and open updates' : 'open updates'
        }`}
        onclick={() => (versionOpen = !versionOpen)}
      >
        <span class="v4-version-app">App v{version}</span>
        <span class="v4-version-divider" aria-hidden="true">·</span>
        <span class="v4-version-core" data-testid="core-version-label">
          {coreVersionLabel}
        </span>
        {#if coreVersionError && !coreVersionLoading}
          <span
            class="v4-version-retry"
            data-testid="core-version-retry"
            aria-hidden="true"
          >Retry</span>
        {/if}
      </button>
      {#if versionOpen}
        <VersionPopout
          {version}
          placement="below"
          onOpenSettings={(tab) => onOpenSettings?.(tab)}
          onclose={() => (versionOpen = false)}
        />
      {/if}
    </div>
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
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 40px;
    height: 40px;
    overflow: visible;
    padding: 0 12px 0 0;
    border-bottom: 1px solid var(--v4-hairline);
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
    gap: 8px;
    /* 78px left inset clears the overlay traffic lights (macOS). */
    padding-left: 78px;
  }

  .v4-wordmark {
    flex: 0 0 auto;
    color: var(--v4-text-1);
    font-size: var(--type-body, 14px);
    font-weight: 500;
    letter-spacing: 0.04em;
    line-height: 1;
  }

  .v4-day-date {
    flex: 0 0 auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 11px);
    font-weight: 500;
    letter-spacing: 0.06em;
    line-height: 1;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .v4-cloud-switch {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-metadata, 11px);
    font-weight: 550;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
  }

  .v4-cloud-switch.off {
    color: var(--v4-text-3);
  }

  .v4-cloud-switch:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-secondary-bg, var(--v4-active-row));
    color: var(--v4-text-1);
  }

  .v4-cloud-switch:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-core-wrap {
    position: relative;
    flex: 0 0 auto;
  }

  .v4-core-pill {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 9px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-metadata, 11px);
    font-weight: 500;
    letter-spacing: 0.04em;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
  }

  .v4-core-pill:hover,
  .v4-core-pill[aria-expanded='true'] {
    border-color: var(--v4-control-border);
    background: var(--v4-secondary-bg, var(--v4-active-row));
    color: var(--v4-text-1);
  }

  .v4-core-pill:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-core-dot {
    color: var(--v4-ok);
    font-size: 8px;
    line-height: 1;
  }

  .v4-core-caret {
    color: var(--v4-text-3);
    font-size: 11px;
    line-height: 1;
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

  .v4-version-wrap {
    position: relative;
    flex: 0 0 auto;
  }

  .v4-version {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    cursor: pointer;
  }

  .v4-version:hover,
  .v4-version[aria-expanded='true'] {
    border-color: var(--v4-control-border);
    background: var(--v4-secondary-bg);
    color: var(--v4-text-1);
  }

  .v4-version-app {
    color: var(--v4-text-3);
    font-weight: 450;
  }

  .v4-version-divider {
    color: var(--v4-hairline-strong, var(--v4-text-3));
  }

  .v4-version-core {
    color: var(--v4-text-1);
    font-weight: 650;
  }

  .v4-version-retry {
    color: var(--v4-text-1);
    font-weight: 500;
  }

  .v4-version:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-icon-btn {
    appearance: none;
    -webkit-appearance: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
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

  /* Pressed global controls stay visibly selected without inheriting the OS
     accent color. aria-pressed remains the semantic source of truth. */
  .v4-icon-btn[aria-pressed='true'] {
    border-color: var(--v4-control-border);
    background: color-mix(in srgb, var(--v4-text-1) 8%, transparent);
    box-shadow: inset 0 0 0 1px var(--v4-hairline);
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

  .v4-notif-btn {
    position: relative;
  }

  .v4-notif-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-error, #c44);
    color: #fff;
    font-size: 9px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 14px;
    text-align: center;
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

  .v4-action:hover:not(:disabled) {
    background: var(--v4-active-row);
  }

  .v4-action:disabled {
    cursor: default;
    opacity: 0.55;
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
