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
  import { sanitizeVisibleIdentifiers } from '../lib/visible-labels';
  import { safeUnlisten } from '../lib/listener-registry';
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
  const visibleCloudError = $derived(
    sanitizeVisibleIdentifiers(cloudError, { companies: workspaces ?? [] }),
  );

  // Notifications is the sole panel body (US-001 chrome strip). Unread count
  // lives next to the section label; Mark all read remains.
  let unreadCount = $state(0);
  let feedEl: NotificationFeed | undefined = $state();

  function handleMarkAllRead() {
    feedEl?.markAllRead();
  }

  /** Open the two-pane Inbox quick window (side pane + reply/detail canvas).
   *  Not the full desktop-alt app — that stays behind explicit Open desktop. */
  async function openDesktopInbox() {
    try {
      await invoke('open_inbox_window');
    } catch (e) {
      console.error('popover: open_inbox_window failed', e);
    }
  }

  const membershipsToPull = $derived(
    joinableMemberships(workspaces ?? []).filter(
      (w) => !dismissedMemberships.has(w.slug),
    ),
  );

  // ── System notices in the feed ──────────────────────────────────────────────
  // Conflict / update / membership / auth / error notices fold INTO the
  // notifications list as pinned one-line rows at the top (same locked
  // NotificationRow design language) instead of a separate banner stack above
  // the status row. The active count feeds the panel's unread badge alongside
  // the feed's own unread count, and tells NotificationFeed to suppress its
  // empty state so a quiet data feed doesn't read as "nothing here" while a
  // sync-paused row sits right above it.
  const conflictModalActive = $derived(showConflictModal && conflicts.length > 0);
  const systemNoticeCount = $derived(
    (membershipsToPull.length > 0 ? 1 : 0) +
      (updateAvailable ? 1 : 0) +
      (syncState === 'conflict' && !conflictModalActive ? 1 : 0) +
      (syncState === 'auth-error' ? 1 : 0) +
      (syncState === 'error' && errorMessage ? 1 : 0) +
      (manifestError ? 1 : 0) +
      (!cloudReachable ? 1 : 0),
  );
  const hasSystemNotices = $derived(systemNoticeCount > 0 || conflictModalActive);
  const notifBadge = $derived(unreadCount + systemNoticeCount);
  const conflictNoticeText = $derived(
    conflictCount > 0
      ? `${conflictCount} file${conflictCount === 1 ? '' : 's'} changed in two places. Resolve in Claude Code, then Sync again.`
      : 'A file changed in two places. Resolve in Claude Code, then Sync again.',
  );
  const membershipNoticeTitle = $derived(
    membershipsToPull.length > 0
      ? `Added to ${membershipsToPull[0].displayName}${
          membershipsToPull.length > 1 ? ` + ${membershipsToPull.length - 1} more` : ''
        }`
      : '',
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
        const safe = safeUnlisten(unlisten);
        if (cancelled) safe();
        else unlistenFocus = safe;
      })
      .catch(() => {
        // Non-Tauri / test environment.
      });

    void listen('popover:opened', () => restartOpeningMotion())
      .then((unlisten) => {
        const safe = safeUnlisten(unlisten);
        if (cancelled) safe();
        else unlistenOpened = safe;
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

    <!-- Notifications panel body — slim label + unread count + Mark all read.
         System notices (conflict / update / membership / auth / errors) pin to
         the top as one-line rows in the same locked row design, then the data
         feed (DMs, shares, new-file activity). -->
    <section class="mbp-sec" aria-labelledby="popover-notifications-label">
      <div class="mbp-sec-head">
        <div class="mbp-lab" id="popover-notifications-label">
          Notifications
          {#if notifBadge > 0}
            <span class="mbp-unread-count">{notifBadge > 99 ? '99+' : notifBadge}</span>
          {/if}
        </div>
        <div class="mbp-sec-actions">
          <button class="mbp-sec-action" type="button" onclick={handleMarkAllRead}>
            Mark all read
          </button>
          <button
            class="mbp-sec-action mbp-sec-action-primary"
            type="button"
            data-testid="popover-open-inbox"
            onclick={() => void openDesktopInbox()}
          >
            Open Inbox
          </button>
        </div>
      </div>

      {#if conflictModalActive && onresolve && onopen && ondismissconflicts}
        <!-- Detailed conflict resolver keeps its own card; the lighter conflict
             summary folds into the feed as a system-notice row. -->
        <div class="mbp-conflict-card">
          <ConflictModal
            {conflicts}
            onresolve={onresolve}
            onopen={onopen}
            ondismiss={ondismissconflicts}
          />
        </div>
      {/if}

      {#if membershipsToPull.length > 0}
        <div class="snr" data-testid="popover-system-notice" data-kind="membership">
          <span class="snr-icon action" aria-hidden="true">{@render noticeGlyph('action')}</span>
          <span class="snr-text">
            <b>{membershipNoticeTitle}</b>
            Sync to pull {membershipsToPull.length > 1 ? 'them' : 'it'} onto this machine.
          </span>
          <span class="snr-actions">
            <button
              type="button"
              class="mbp-mini primary"
              onclick={onsync}
              disabled={syncState === 'syncing'}
            >
              {syncState === 'syncing' ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              type="button"
              class="mbp-mini"
              onclick={() => dismissMembershipPrompt(membershipsToPull[0].slug)}
            >
              Dismiss
            </button>
          </span>
        </div>
      {/if}

      {#if updateAvailable}
        <div class="snr" data-testid="popover-system-notice" data-kind="update">
          <span class="snr-icon action" aria-hidden="true">{@render noticeGlyph('action')}</span>
          <span class="snr-text">
            <b>Update available</b>
            HQ v{updateAvailable.version}{updateAvailable.body ? ` — ${updateAvailable.body}` : ''}
          </span>
          <span class="snr-actions">
            <button
              type="button"
              class="mbp-mini primary"
              onclick={oninstallupdate}
              disabled={updateInstalling || !oninstallupdate}
            >
              {updateInstalling ? 'Installing…' : 'Install'}
            </button>
          </span>
        </div>
      {/if}

      {#if syncState === 'conflict' && !conflictModalActive}
        <div class="snr" data-testid="popover-system-notice" data-kind="conflict">
          <span class="snr-icon alert" aria-hidden="true">{@render noticeGlyph('alert')}</span>
          <span class="snr-text">
            <b>Sync paused</b>
            {conflictNoticeText}
          </span>
          <span class="snr-actions">
            <OpenInClaudeCodeButton
              variant="compact"
              label="Resolve"
              folder={config?.hqFolderPath ?? ''}
              issue={{ kind: 'sync-conflict', payload: { count: conflictCount, company: conflictCompany } }}
            />
            <CopyPromptButton
              variant="compact"
              label="Copy prompt"
              issue={{ kind: 'sync-conflict', payload: { count: conflictCount, company: conflictCompany } }}
            />
          </span>
        </div>
      {/if}

      {#if syncState === 'auth-error'}
        <div class="snr" data-testid="popover-system-notice" data-kind="auth">
          <span class="snr-icon action" aria-hidden="true">{@render noticeGlyph('action')}</span>
          <span class="snr-text">
            <b>Keep sync moving</b>
            {errorMessage || 'Sign in once and HQ will resume automatically.'}
          </span>
        </div>
      {:else if syncState === 'error' && errorMessage}
        <div class="snr" data-testid="popover-system-notice" data-kind="error">
          <span class="snr-icon alert" aria-hidden="true">{@render noticeGlyph('alert')}</span>
          <span class="snr-text">
            <b>Finish sync in Claude Code</b>
            Sync started but needs a hand to complete.
          </span>
          <span class="snr-actions">
            <OpenInClaudeCodeButton
              variant="compact"
              label="Finish in Claude Code"
              folder={config?.hqFolderPath ?? ''}
              issue={{ kind: 'sync-failed', payload: { message: errorMessage, company: errorCompany } }}
            />
            <CopyPromptButton
              variant="compact"
              label="Copy prompt"
              issue={{ kind: 'sync-failed', payload: { message: errorMessage, company: errorCompany } }}
            />
          </span>
        </div>
      {/if}

      {#if manifestError}
        <div class="snr" data-testid="popover-system-notice" data-kind="manifest" title={manifestError}>
          <span class="snr-icon alert" aria-hidden="true">{@render noticeGlyph('alert')}</span>
          <span class="snr-text">
            <b>Couldn’t read companies list</b>
            companies/manifest.yaml could not be read.
          </span>
          <span class="snr-actions">
            <CopyPromptButton
              variant="compact"
              label="Copy fix prompt"
              issue={{ kind: 'manifest-error', payload: { error: manifestError } }}
            />
          </span>
        </div>
      {/if}

      {#if !cloudReachable}
        <div class="snr" data-testid="popover-system-notice" data-kind="cloud" title={visibleCloudError}>
          <span class="snr-icon warn" aria-hidden="true">{@render noticeGlyph('warn')}</span>
          <span class="snr-text">
            <b>Cloud unreachable</b>
            Showing local folders.
          </span>
          <span class="snr-actions">
            <CopyPromptButton
              variant="compact"
              label="Copy diagnose prompt"
              issue={{ kind: 'cloud-unreachable', payload: { error: cloudError ?? '' } }}
            />
          </span>
        </div>
      {/if}

      <NotificationFeed
        bind:this={feedEl}
        showDayLabels={false}
        hideEmptyState={hasSystemNotices}
        onunreadchange={(n) => (unreadCount = n)}
      />
    </section>
    </div>
  </div>
  </div>
</div>

{#snippet noticeGlyph(kind: 'alert' | 'warn' | 'action')}
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    {#if kind === 'action'}
      <path
        d="M8 2.5v8.4M4.6 7.5 8 10.9l3.4-3.4M2.8 13h10.4"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else}
      <path
        d="M8 2 1.8 13h12.4L8 2Z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M8 6.4v3M8 11.4h.01"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    {/if}
  </svg>
{/snippet}

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

  /* Windows has no NSVisualEffectView behind the transparent webview. Give
     the tray popup a fully opaque surface so other windows never bleed
     through its content; macOS keeps the native glass treatment above. */
  :global(html[data-platform='windows']) .mbpop {
    background: #18181b;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-color: rgba(255, 255, 255, 0.16);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
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

  /* Detailed conflict resolver keeps its own card; the lighter conflict
     summary folds into the feed as a system-notice row. */
  .mbp-conflict-card {
    padding: 0 5px 4px;
  }

  /* Pinned system-notice rows — one-line, matching the locked NotificationRow
     design (icon + single ellipsized line + hover/focus-revealed actions). */
  .snr {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 30px;
    padding: 0 11px;
    border-radius: 9px;
    font-size: 12px;
    color: var(--pop-text);
    transition: background-color 0.15s ease;
    box-sizing: border-box;
  }

  .snr:hover,
  .snr:focus-within {
    background: var(--pop-hover);
  }

  .snr-icon {
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    display: grid;
    place-items: center;
    color: var(--pop-muted);
  }

  .snr-icon.alert {
    color: var(--popover-warning);
  }

  .snr-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 450;
    color: var(--pop-text);
  }

  .snr-text b {
    font-weight: 600;
  }

  .snr-actions {
    margin-left: auto;
    flex: 0 0 auto;
    display: none;
    align-items: center;
    gap: 4px;
  }

  .snr:hover .snr-actions,
  .snr:focus-within .snr-actions {
    display: inline-flex;
  }

  .mbp-progress p {
    margin: 0;
  }

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
    gap: 6px;
    padding-right: 8px;
  }

  .mbp-sec-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
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

  .mbp-sec-action-primary {
    color: var(--pop-accent, var(--pop-text));
  }

  .mbp-sec-action-primary:hover {
    color: var(--pop-text);
  }

  .mbp-sec-action:focus-visible {
    outline: 1.5px solid var(--popover-focus-ring, var(--pop-accent));
    outline-offset: var(--popover-focus-offset, 2px);
  }
</style>
