<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { onMount, untrack } from 'svelte';
  import ConflictModal from './ConflictModal.svelte';
  import NotificationFeed from './NotificationFeed.svelte';
  import CopyPromptButton from './CopyPromptButton.svelte';
  import OpenInClaudeCodeButton from './OpenInClaudeCodeButton.svelte';
  import { joinableMemberships, type Workspace } from '../lib/workspaces';
  import { liveProgressCaption } from '../lib/live-progress-caption';
  import { isCorePath, CORE_SETUP_LABEL } from '../lib/progressLabel';
  import {
    POPOVER_MIN_HEIGHT,
    POPOVER_WIDTH,
    clampPopoverHeight,
    measuredSurfaceContentHeight,
    shouldResizePopoverWindow,
  } from '../lib/popover-window-size';
  import type { ConflictFile } from '../stores/conflicts';

  interface Config {
    configured: boolean;
    companySlug: string;
    hqFolderPath: string;
    error?: string;
  }

  interface Props {
    syncState: 'idle' | 'syncing' | 'error' | 'conflict' | 'setup-needed' | 'auth-error';
    config: Config | null;
    progress?: { company: string; path: string; bytes: number } | null;
    fanoutTotal?: number;
    fanoutDoneCount?: number;
    syncFilesProgressed?: number;
    personalFilesDone?: number;
    personalFilesTotal?: number | null;
    personalFirstPushDone?: boolean;
    syncTotalFiles?: number;
    syncPlanTotalFiles?: number;
    companies?: Array<{ uid: string; slug: string; name?: string }>;
    workspaces?: Workspace[] | null;
    cloudReachable?: boolean;
    cloudError?: string | null;
    manifestError?: string | null;
    errorMessage?: string;
    errorCompany?: string;
    conflicts?: ConflictFile[];
    showConflictModal?: boolean;
    conflictCount?: number;
    conflictCompany?: string;
    updateAvailable?: { version: string; body?: string; date?: string } | null;
    updateInstalling?: boolean;
    onsync: () => void;
    onresolve?: (path: string, strategy: 'keep-local' | 'keep-remote') => void;
    onopen?: (path: string) => void;
    ondismissconflicts?: () => void;
    oninstallupdate?: () => void;
    bindStatsRefresh?: (fn: () => void) => void;
  }

  interface SyncStatus {
    lastSyncAt: string | null;
    pendingFiles: number;
    conflicts: number;
    daemonRunning: boolean;
    source: string;
  }

  let {
    syncState,
    config,
    progress = null,
    fanoutTotal = 0,
    fanoutDoneCount = 0,
    syncFilesProgressed = 0,
    personalFilesDone = 0,
    personalFilesTotal = null,
    personalFirstPushDone = false,
    syncTotalFiles = 0,
    syncPlanTotalFiles = 0,
    companies = [],
    workspaces = null,
    cloudReachable = true,
    cloudError = null,
    manifestError = null,
    errorMessage = '',
    errorCompany = '',
    conflicts = [],
    showConflictModal = false,
    conflictCount = 0,
    conflictCompany = '',
    updateAvailable = null,
    updateInstalling = false,
    onsync,
    onresolve,
    onopen,
    ondismissconflicts,
    oninstallupdate,
    bindStatsRefresh,
  }: Props = $props();

  let popoverEl: HTMLElement | null = $state(null);
  let popoverContentEl: HTMLElement | null = $state(null);
  let popoverMainContentEl: HTMLElement | null = $state(null);
  let opening = $state(false);
  let openingTimer: number | null = null;
  let syncStatus = $state<SyncStatus | null>(null);
  let syncStatusLoading = $state(true);
  let syncStatusError = $state('');
  let lastWindowHeight = $state(0);

  // Notifications is the sole panel body (US-001 chrome strip). Unread count
  // lives next to the section label; Mark all read remains.
  let unreadCount = $state(0);
  let feedEl: NotificationFeed | undefined = $state();

  function handleMarkAllRead() {
    feedEl?.markAllRead();
  }

  const membershipsToPull = $derived(
    joinableMemberships(workspaces ?? []).filter(
      (w) => !dismissedMemberships.has(w.slug),
    ),
  );

  const barPct = $derived.by(() => {
    if (syncTotalFiles > 0) {
      return Math.min(100, Math.max(0, (syncFilesProgressed / syncTotalFiles) * 100));
    }
    let p = 0;
    if (personalFirstPushDone) {
      p += 0.5;
    } else if (personalFilesTotal != null && personalFilesTotal > 0) {
      p += (personalFilesDone / personalFilesTotal) * 0.5;
    }
    if (fanoutTotal > 0) {
      p += (fanoutDoneCount / fanoutTotal) * 0.5;
    }
    return Math.min(100, Math.max(0, p * 100));
  });

  const caption = $derived(
    liveProgressCaption({
      syncFilesProgressed,
      syncPlanTotalFiles,
      syncTotalFiles,
      fanoutTotal,
      fanoutDoneCount,
      personalFilesDone,
      personalFilesTotal,
    }),
  );

  const currentLabel = $derived.by(() => {
    if (fanoutTotal > 0 && fanoutDoneCount < fanoutTotal) {
      const w = companies[fanoutDoneCount];
      if (w) return w.name ?? w.slug;
    }
    if (personalFilesTotal != null || personalFirstPushDone) return 'personal';
    return progress?.company ?? '...';
  });

  const liveWorkspaceLine = $derived.by(() => {
    if (progress && isCorePath(progress.path)) return CORE_SETUP_LABEL;
    return currentLabel === '...' ? 'Preparing sync...' : `Syncing ${currentLabel}`;
  });

  const statusTitle = $derived.by(() => {
    if (syncState === 'syncing') return 'Syncing';
    if (syncState === 'auth-error') return 'Sign in required';
    if (syncState === 'conflict') return 'Sync paused';
    if (syncState === 'error') return 'Needs attention';
    return 'All synced';
  });

  const lastSyncLabel = $derived.by(() => {
    if (syncState === 'syncing') return progressCaptionText();
    if (syncStatusLoading) return 'Last sync · ...';
    if (syncStatusError) return 'Last sync unavailable';
    return `Last sync · ${syncStatus?.lastSyncAt ? timeAgo(syncStatus.lastSyncAt) : 'never'}`;
  });

  let dismissedMemberships = $state(new Set<string>());

  function timeAgo(isoDate: string): string {
    const then = new Date(isoDate).getTime();
    if (Number.isNaN(then)) return 'unknown';
    const seconds = Math.floor((Date.now() - then) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) {
      const m = Math.floor(seconds / 60);
      return `${m}m ago`;
    }
    if (seconds < 86400) {
      const h = Math.floor(seconds / 3600);
      return `${h}h ago`;
    }
    const d = Math.floor(seconds / 86400);
    if (d < 30) return `${d}d ago`;
    return new Date(isoDate).toLocaleDateString();
  }

  function progressCaptionText(): string {
    if (caption.kind === 'transferred-of') {
      return `${caption.progressed.toLocaleString()} of ${caption.planTotal.toLocaleString()} transferred`;
    }
    if (caption.kind === 'transferred') {
      return `${caption.progressed.toLocaleString()} transferred`;
    }
    if (caption.kind === 'up-to-date') return 'Finalizing...';
    if (caption.kind === 'fanout') {
      return `Workspace ${caption.current} of ${caption.total}`;
    }
    if (caption.kind === 'personal') {
      return `${caption.done} of ${caption.total} files`;
    }
    return 'In progress';
  }

  async function refreshSyncStatus() {
    syncStatusLoading = true;
    syncStatusError = '';
    try {
      syncStatus = await invoke<SyncStatus>('get_sync_status');
    } catch (e) {
      syncStatusError = String(e);
    } finally {
      syncStatusLoading = false;
    }
  }

  function dismissMembershipPrompt(slug: string) {
    dismissedMemberships = new Set(dismissedMemberships).add(slug);
  }

  function restartOpeningMotion() {
    if (typeof window === 'undefined') return;
    if (openingTimer !== null) {
      window.clearTimeout(openingTimer);
      openingTimer = null;
    }
    opening = false;
    window.requestAnimationFrame(() => {
      opening = true;
      openingTimer = window.setTimeout(() => {
        opening = false;
        openingTimer = null;
      }, 480);
    });
  }

  function resizePopoverWindow(height: number) {
    if (!shouldResizePopoverWindow(height, lastWindowHeight)) return;
    lastWindowHeight = height;
    try {
      void getCurrentWindow().setSize(new LogicalSize(POPOVER_WIDTH, height));
    } catch {
      // Non-Tauri / test environment.
    }
  }

  // No header/footer chrome — height is main content only (US-001).
  function measuredPopoverHeight(): number {
    if (!popoverContentEl) return POPOVER_MIN_HEIGHT;
    const contentHeight = popoverMainContentEl?.scrollHeight ?? 0;
    return measuredSurfaceContentHeight({
      contentScrollHeight: Math.max(popoverContentEl.scrollHeight, contentHeight),
      floatingBottom: 0,
    });
  }

  $effect(() => {
    console.log(`[popover] mounted at ${performance.now().toFixed(1)}ms`);
    performance.mark('popover-mounted');
  });

  $effect(() => {
    untrack(() => void refreshSyncStatus());
  });

  $effect(() => {
    if (bindStatsRefresh) bindStatsRefresh(refreshSyncStatus);
  });

  $effect(() => {
    if (!popoverContentEl || typeof ResizeObserver === 'undefined') return;

    let raf = 0;
    const syncSize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        resizePopoverWindow(clampPopoverHeight(measuredPopoverHeight()));
      });
    };

    const observer = new ResizeObserver(syncSize);
    observer.observe(popoverContentEl);
    if (popoverMainContentEl) observer.observe(popoverMainContentEl);
    syncSize();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  });

  onMount(() => {
    let cancelled = false;
    let unlistenFocus: UnlistenFn | null = null;
    let unlistenOpened: UnlistenFn | null = null;

    restartOpeningMotion();

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) restartOpeningMotion();
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else unlistenFocus = unlisten;
      })
      .catch(() => {
        // Non-Tauri / test environment.
      });

    void listen('popover:opened', () => restartOpeningMotion())
      .then((unlisten) => {
        if (cancelled) unlisten();
        else unlistenOpened = unlisten;
      })
      .catch(() => {
        // Non-Tauri / test environment.
      });

    return () => {
      cancelled = true;
      unlistenFocus?.();
      unlistenOpened?.();
      if (openingTimer !== null) window.clearTimeout(openingTimer);
    };
  });
</script>

<div class="popover mbpop show" class:opening bind:this={popoverEl} data-testid="popover-root">
  <div class="mbpop-content" bind:this={popoverContentEl}>
  <div class="mbp-main">
    <div class="mbp-main-content" bind:this={popoverMainContentEl}>
    {#if showConflictModal && conflicts.length > 0 && onresolve && onopen && ondismissconflicts}
      <div class="mbp-notices">
        <ConflictModal
          {conflicts}
          onresolve={onresolve}
          onopen={onopen}
          ondismiss={ondismissconflicts}
        />
      </div>
    {/if}

    {#if updateAvailable || manifestError || !cloudReachable || membershipsToPull.length > 0 || syncState === 'auth-error' || (syncState === 'error' && errorMessage) || syncState === 'conflict'}
      <div class="mbp-notices">
        {#if updateAvailable}
          <div class="mbp-banner">
            <div>
              <p>Update available: v{updateAvailable.version}</p>
              {#if updateAvailable.body}
                <span>{updateAvailable.body}</span>
              {/if}
            </div>
            <button
              type="button"
              class="mbp-mini primary"
              onclick={oninstallupdate}
              disabled={updateInstalling || !oninstallupdate}
            >
              {updateInstalling ? 'Installing...' : 'Install'}
            </button>
          </div>
        {/if}

        {#if manifestError}
          <div class="mbp-banner" title={manifestError}>
            <p>companies/manifest.yaml could not be read.</p>
            <CopyPromptButton
              variant="compact"
              label="Copy fix prompt"
              issue={{ kind: 'manifest-error', payload: { error: manifestError } }}
            />
          </div>
        {/if}

        {#if !cloudReachable}
          <div class="mbp-banner" title={cloudError ?? ''}>
            <p>Cloud unreachable - showing local folders.</p>
            <CopyPromptButton
              variant="compact"
              label="Copy diagnose prompt"
              issue={{ kind: 'cloud-unreachable', payload: { error: cloudError ?? '' } }}
            />
          </div>
        {/if}

        {#if membershipsToPull.length > 0}
          <div class="mbp-banner">
            <button
              class="mbp-dismiss"
              type="button"
              onclick={() => dismissMembershipPrompt(membershipsToPull[0].slug)}
              aria-label="Dismiss membership prompt"
            >
              ×
            </button>
            <div>
              <p>
                Added to {membershipsToPull[0].displayName}{membershipsToPull.length > 1
                  ? ` + ${membershipsToPull.length - 1} more`
                  : ''}
              </p>
              <span>Sync to pull {membershipsToPull.length > 1 ? 'them' : 'it'} down.</span>
            </div>
            <button
              type="button"
              class="mbp-mini primary"
              onclick={onsync}
              disabled={syncState === 'syncing'}
            >
              {syncState === 'syncing' ? 'Syncing...' : 'Sync'}
            </button>
          </div>
        {/if}

        {#if syncState === 'auth-error'}
          <div class="mbp-banner">
            <div>
              <p>Session expired</p>
              <span>{errorMessage || 'Please sign in again to continue syncing.'}</span>
            </div>
            <CopyPromptButton
              variant="inline"
              label="Copy prompt"
              issue={{ kind: 'auth-expired', payload: { message: errorMessage } }}
            />
          </div>
        {:else if syncState === 'error' && errorMessage}
          <div class="mbp-banner">
            <div>
              <p>Sync initialized</p>
              <span>Finish in Claude Code to complete sync.</span>
            </div>
            <div class="mbp-banner-actions">
              <OpenInClaudeCodeButton
                variant="compact"
                label="Finish sync in Claude Code"
                folder={config?.hqFolderPath ?? ''}
                issue={{ kind: 'sync-failed', payload: { message: errorMessage, company: errorCompany } }}
              />
              <CopyPromptButton
                variant="compact"
                label="Copy prompt"
                issue={{ kind: 'sync-failed', payload: { message: errorMessage, company: errorCompany } }}
              />
            </div>
          </div>
        {:else if syncState === 'conflict' && !(showConflictModal && conflicts.length > 0)}
          <div class="mbp-banner">
            <div>
              <p>
                Sync paused - {conflictCount > 0
                  ? `${conflictCount} file${conflictCount === 1 ? '' : 's'} changed in two places`
                  : 'a file changed in two places'}
              </p>
              <span>Resolve in Claude Code, then Sync again.</span>
            </div>
            <div class="mbp-banner-actions">
              <OpenInClaudeCodeButton
                variant="compact"
                label="Resolve in Claude Code"
                folder={config?.hqFolderPath ?? ''}
                issue={{ kind: 'sync-conflict', payload: { count: conflictCount, company: conflictCompany } }}
              />
              <CopyPromptButton
                variant="compact"
                label="Copy prompt"
                issue={{ kind: 'sync-conflict', payload: { count: conflictCount, company: conflictCompany } }}
              />
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <div
      class="mbp-status"
      class:syncing={syncState === 'syncing'}
      class:attention={syncState === 'auth-error' || syncState === 'error' || syncState === 'conflict'}
      data-testid="popover-status-row"
    >
      <span class="gd" aria-hidden="true"></span>
      <span class="mbp-s1">{statusTitle}</span>
      <span class="mbp-s2">{lastSyncLabel}</span>
    </div>

    {#if syncState === 'syncing'}
      <div class="mbp-progress">
        <p>{liveWorkspaceLine}</p>
        <div class="mbp-progress-track">
          <span style="width: {barPct}%"></span>
        </div>
      </div>
    {/if}

    <!-- Notifications panel body — slim label + unread count + Mark all read. -->
    <section class="mbp-sec" aria-labelledby="popover-notifications-label">
      <div class="mbp-sec-head">
        <div class="mbp-lab" id="popover-notifications-label">
          Notifications
          {#if unreadCount > 0}
            <span class="mbp-unread-count">{unreadCount > 99 ? '99+' : unreadCount}</span>
          {/if}
        </div>
        <button class="mbp-sec-action" type="button" onclick={handleMarkAllRead}>
          Mark all read
        </button>
      </div>
      <NotificationFeed
        bind:this={feedEl}
        showDayLabels={false}
        onunreadchange={(n) => (unreadCount = n)}
      />
    </section>
    </div>
  </div>
  </div>
</div>

<style>
  .popover {
    width: min(100vw, 296px);
    height: 100vh;
    max-height: 100vh;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    font-family: var(--font-sans);
  }

  .mbpop {
    color: var(--pop-text);
    background: var(--pop-bg);
    backdrop-filter: blur(32px) saturate(1.7);
    -webkit-backdrop-filter: blur(32px) saturate(1.7);
    border: 0.5px solid var(--pop-border);
    border-radius: 12px;
    box-shadow: var(--pop-shadow), inset 0 1px 0 var(--pop-highlight);
    overflow: hidden;
  }

  .mbpop-content {
    width: 100%;
    min-height: 0;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    transform-origin: top right;
  }

  .mbpop.opening .mbpop-content {
    animation: mbpop-show 0.42s cubic-bezier(.34, 1.18, .64, 1) both;
  }

  @keyframes mbpop-show {
    from {
      opacity: 0;
      transform: translateY(-12px) scale(0.97);
    }

    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .mbpop.opening .mbpop-content {
      animation: none;
    }
  }

  .mbp-main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
  }

  .mbp-main::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  .mbp-main-content {
    min-height: 0;
  }

  .mbp-notices {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 8px 0;
  }

  .mbp-banner {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 8px;
    border-radius: 8px;
    border: 0.5px solid var(--pop-border);
    background: var(--pop-hover);
    color: var(--pop-text);
    font-size: 11.5px;
    line-height: 1.3;
  }

  .mbp-banner p,
  .mbp-progress p {
    margin: 0;
  }

  .mbp-banner p {
    font-weight: 600;
  }

  .mbp-banner span {
    color: var(--pop-muted);
  }

  .mbp-banner-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .mbp-dismiss {
    position: absolute;
    top: 3px;
    right: 4px;
    width: 18px;
    height: 18px;
    border: 0;
    border-radius: 5px;
    color: var(--pop-muted);
    background: transparent;
    cursor: pointer;
  }

  .mbp-dismiss:hover {
    color: var(--pop-text);
    background: var(--pop-hover);
  }

  .mbp-dismiss:focus-visible,
  .mbp-mini:focus-visible {
    outline: 1.5px solid var(--popover-focus-ring, var(--pop-accent));
    outline-offset: var(--popover-focus-offset, 2px);
  }

  .mbp-status {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 14px 12px;
  }

  .mbp-status .gd {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--popover-success);
    box-shadow: 0 0 7px var(--popover-success-bg);
    flex-shrink: 0;
  }

  .mbp-status.syncing .gd {
    background: var(--pop-accent);
    box-shadow: 0 0 7px var(--pop-hover);
  }

  .mbp-status.attention .gd {
    background: var(--popover-warning);
    box-shadow: 0 0 7px var(--popover-warning-glow);
  }

  .mbp-s1 {
    color: var(--pop-text);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }

  .mbp-s2 {
    color: var(--pop-muted);
    font-size: 11px;
    margin-left: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mbp-progress {
    padding: 0 14px 10px;
    color: var(--pop-muted);
    font-size: 11px;
  }

  .mbp-progress-track {
    height: 5px;
    margin-top: 6px;
    border-radius: 999px;
    background: var(--pop-hover);
    overflow: hidden;
  }

  .mbp-progress-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--pop-accent);
    transition: width 0.25s ease-out;
  }

  .mbp-sec {
    padding: 6px;
    border-top: 0.5px solid var(--pop-divider);
  }

  .mbp-lab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--pop-muted);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    padding: 6px 8px 4px;
  }

  .mbp-unread-count {
    min-width: 16px;
    padding: 1px 5px;
    border-radius: 999px;
    background: var(--pop-hover);
    color: var(--pop-muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
    line-height: 1.3;
  }

  .mbp-mini {
    border: 0;
    border-radius: 6px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    min-height: 23px;
    padding: 0 8px;
  }

  .mbp-mini.primary {
    background: var(--pop-accent);
    color: var(--pop-acc-fg);
  }

  .mbp-mini:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .mbp-sec-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-right: 8px;
  }

  .mbp-sec-action {
    border: 0;
    padding: 2px 6px;
    border-radius: 6px;
    background: transparent;
    color: var(--pop-muted);
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .mbp-sec-action:hover {
    color: var(--pop-text);
    background: var(--pop-hover);
  }

  .mbp-sec-action:focus-visible {
    outline: 1.5px solid var(--popover-focus-ring, var(--pop-accent));
    outline-offset: var(--popover-focus-offset, 2px);
  }
</style>
