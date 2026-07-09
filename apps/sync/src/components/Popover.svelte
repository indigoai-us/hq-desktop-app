<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { open } from '@tauri-apps/plugin-shell';
  import { onMount, untrack } from 'svelte';
  import ConflictModal from './ConflictModal.svelte';
  import NotificationFeed from './NotificationFeed.svelte';
  import WorkspaceList from './WorkspaceList.svelte';
  import CopyPromptButton from './CopyPromptButton.svelte';
  import OpenInClaudeCodeButton from './OpenInClaudeCodeButton.svelte';
  import PopoverIcon from './PopoverIcon.svelte';
  import { dedupeWorkspaces, joinableMemberships, type Workspace } from '../lib/workspaces';
  import { liveProgressCaption } from '../lib/live-progress-caption';
  import { isCorePath, CORE_SETUP_LABEL } from '../lib/progressLabel';
  import { packUpdateTitle } from '../lib/packUpdate';
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
    onworkspacesrefresh?: () => void;
    lastSummary?: {
      companiesAttempted: number;
      filesDownloaded: number;
      bytesDownloaded: number;
      filesSkipped: number;
    } | null;
    errorMessage?: string;
    errorCompany?: string;
    conflicts?: ConflictFile[];
    showConflictModal?: boolean;
    conflictCount?: number;
    conflictCompany?: string;
    updateAvailable?: { version: string; body?: string; date?: string } | null;
    updateInstalling?: boolean;
    hqCliUpdateAvailable?: { local: string | null; latest: string } | null;
    hqCliUpdateInstalling?: boolean;
    hqCliUpdateError?: string | null;
    packUpdateAvailable?: { count: number; names: string[] } | null;
    packsUpdating?: boolean;
    packUpdateError?: string | null;
    onupdatepacks?: () => void;
    hqVersion?: string | null;
    coreState?: {
      channel: 'release' | 'staging';
      targetRepo: string;
      targetVersion: string;
      targetRef: string;
      localVersion: string | null;
      floorSha: string | null;
      isEligible: boolean;
      versionBehind: boolean;
      driftReport: {
        count: number;
        modified: Array<{ path: string; size: number; gitShaLocal: string | null; gitShaUpstream: string | null }>;
        missing: Array<{ path: string; size: number; gitShaLocal: string | null; gitShaUpstream: string | null }>;
        added: Array<{ path: string; size: number; gitShaLocal: string | null; gitShaUpstream: string | null }>;
        scannedAt: string;
        hqVersion: string;
        targetRepo: string;
        targetRef: string;
      };
      unchangedCount: number;
      userOnlyCount: number;
      scannedAt: string;
    } | null;
    coreInstalling?: boolean;
    coreInstallLastResult?: {
      kind: 'ok' | 'err';
      exitCode: number;
      logTail: string;
      logPath: string;
    } | null;
    onsync: () => void;
    oncancel?: () => void;
    onsettings: () => void;
    onsignout: () => void;
    onresolve?: (path: string, strategy: 'keep-local' | 'keep-remote') => void;
    onopen?: (path: string) => void;
    ondismissconflicts?: () => void;
    oninstallupdate?: () => void;
    oninstallhqcliupdate?: () => void;
    ondismisshqcliupdate?: () => void;
    oninstallcore?: () => void;
    bindStatsRefresh?: (fn: () => void) => void;
    meetingsEnabled?: boolean;
    onmeetingsclick?: () => void;
    activeMeetings?: ActiveMeeting[];
    onstartrecording?: (windowId: string) => void | Promise<void>;
    onstoprecording?: (windowId: string) => void | Promise<void>;
    recordingCompanies?: Array<{
      companyUid: string;
      companyName: string | null;
      role: string | null;
      status: string;
    }>;
    onchangerecordingcompany?: (
      windowId: string,
      companyUid: string | null,
    ) => void;
    desktopAltEnabled?: boolean;
  }

  interface ActiveMeeting {
    windowId: string;
    platform: string;
    meetingUrl: string;
    detectedAt: string;
    state: 'detected' | 'starting' | 'recording' | 'stopping' | 'error';
    recordingId?: string;
    error?: string;
    companyUid: string | null;
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
    onworkspacesrefresh,
    lastSummary = null,
    errorMessage = '',
    errorCompany = '',
    conflicts = [],
    showConflictModal = false,
    conflictCount = 0,
    conflictCompany = '',
    updateAvailable = null,
    updateInstalling = false,
    hqCliUpdateAvailable = null,
    hqCliUpdateInstalling = false,
    hqCliUpdateError = null,
    packUpdateAvailable = null,
    packsUpdating = false,
    packUpdateError = null,
    hqVersion = null,
    coreState = null,
    coreInstalling = false,
    coreInstallLastResult = null,
    onsync,
    oncancel,
    onsettings,
    onsignout,
    onresolve,
    onopen,
    ondismissconflicts,
    oninstallupdate,
    oninstallhqcliupdate,
    ondismisshqcliupdate,
    onupdatepacks,
    oninstallcore,
    bindStatsRefresh,
    meetingsEnabled = false,
    onmeetingsclick,
    activeMeetings = [],
    onstartrecording,
    onstoprecording,
    recordingCompanies = [],
    onchangerecordingcompany,
    desktopAltEnabled = false,
  }: Props = $props();

  const HQ_CLI_UPGRADE_CMD = 'npm install -g @indigoai-us/hq-cli@latest';

  let popoverEl: HTMLElement | null = $state(null);
  let popoverContentEl: HTMLElement | null = $state(null);
  let popoverMainContentEl: HTMLElement | null = $state(null);
  let overflowButtonEl: HTMLButtonElement | null = $state(null);
  let overflowEl: HTMLDivElement | null = $state(null);
  let overflowOpen = $state(false);
  let opening = $state(false);
  let openingTimer: number | null = null;
  let showWorkspaceActions = $state(false);
  let desktopAltError = $state('');
  let desktopAltErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let hqCliCmdCopied = $state(false);
  let syncStatus = $state<SyncStatus | null>(null);
  let syncStatusLoading = $state(true);
  let syncStatusError = $state('');
  let lastWindowHeight = $state(0);

  // ── Notifications-first tabs (redesign) ───────────────────────────────────
  // Notifications is the default tab; the feed stays mounted while hidden so
  // its realtime listeners + unread count survive tab switches.
  let activeTab = $state<'notifications' | 'workspaces'>('notifications');
  let unreadCount = $state(0);
  let feedEl: NotificationFeed | undefined = $state();

  function handleMarkAllRead() {
    feedEl?.markAllRead();
  }

  const stateOrder: Record<Workspace['state'], number> = {
    personal: 0,
    synced: 1,
    'cloud-only': 2,
    broken: 3,
    'local-only': 4,
  };

  const compactWorkspaces = $derived.by(() =>
    dedupeWorkspaces(workspaces ?? []).sort((a, b) => stateOrder[a.state] - stateOrder[b.state]),
  );

  const syncedWorkspaceCount = $derived(
    compactWorkspaces.filter((w) => isWorkspaceSynced(w)).length,
  );

  const membershipsToPull = $derived(
    joinableMemberships(workspaces ?? []).filter(
      (w) => !dismissedMemberships.has(w.slug),
    ),
  );

  // ── System notices in the feed (redesign) ──────────────────────────────────
  // Conflict / update / membership / auth / error notices fold into the
  // notifications list as pinned rows at the top instead of a separate banner
  // stack above the status row. The active count feeds the segmented-control
  // badge alongside the feed's own unread count, and tells NotificationFeed to
  // suppress its empty state so a quiet data feed doesn't read as "nothing
  // here" while a sync-paused row sits right above it.
  const conflictModalActive = $derived(showConflictModal && conflicts.length > 0);
  const systemNoticeCount = $derived(
    (desktopAltError ? 1 : 0) +
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

  const meetingsPromptActive = $derived(
    activeMeetings.some((m) =>
      m.state === 'detected' ||
      m.state === 'error' ||
      m.state === 'recording' ||
      m.state === 'starting' ||
      m.state === 'stopping',
    ),
  );

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

  function syncButtonLabel(): string {
    if (syncState === 'syncing') return oncancel ? 'Stop' : 'Syncing';
    if (syncState === 'auth-error') return 'Sign in';
    return 'Sync';
  }

  function syncButtonTitle(): string {
    if (syncState === 'syncing') return oncancel ? 'Stop syncing' : 'Syncing';
    if (syncState === 'auth-error') return 'Sign in again to sync';
    if (syncState === 'error') return 'Retry sync';
    if (syncState === 'conflict') return 'Retry after resolving conflicts';
    return 'Sync';
  }

  function handleSyncButtonClick() {
    if (syncState === 'syncing' && oncancel) {
      oncancel();
      return;
    }
    if (syncState !== 'syncing') {
      onsync();
    }
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

  function clearDesktopAltErrorTimer() {
    if (desktopAltErrorTimer) {
      clearTimeout(desktopAltErrorTimer);
      desktopAltErrorTimer = null;
    }
  }

  function showDesktopAltError(message: string) {
    clearDesktopAltErrorTimer();
    desktopAltError = message;
    desktopAltErrorTimer = setTimeout(() => {
      desktopAltError = '';
      desktopAltErrorTimer = null;
    }, 5000);
  }

  async function openDesktopAltWindow() {
    desktopAltError = '';
    clearDesktopAltErrorTimer();
    closeOverflow();

    try {
      await invoke('open_desktop_alt_window');
    } catch (e) {
      console.error('open_desktop_alt_window failed:', e);
      showDesktopAltError('Could not open desktop view.');
    }
  }

  async function openActivityLog() {
    closeOverflow();
    try {
      await invoke('open_activity_log');
    } catch (e) {
      console.error('open_activity_log failed:', e);
    }
  }

  async function copyHqCliCommand() {
    try {
      await navigator.clipboard.writeText(HQ_CLI_UPGRADE_CMD);
      hqCliCmdCopied = true;
      setTimeout(() => (hqCliCmdCopied = false), 1500);
    } catch (e) {
      console.error('copy hq CLI command failed:', e);
    }
  }

  async function fixHqCliUpdateInHq() {
    closeOverflow();
    const prompt = [
      'The hq CLI auto-update failed inside the HQ menubar app.',
      '',
      `Install command: ${HQ_CLI_UPGRADE_CMD}`,
      '',
      'Stderr from the failed run:',
      hqCliUpdateError ?? '(no error captured)',
      '',
      'Please diagnose the root cause (EACCES on a system-prefix npm is the usual suspect) and walk me through fixing it.',
    ].join('\n');

    const params = new URLSearchParams({ q: prompt });
    if (config?.hqFolderPath) params.set('folder', config.hqFolderPath);
    const url = `claude://code/new?${params.toString()}`;

    try {
      await invoke('open_claude_code_link', { url });
    } catch (e) {
      console.error('open_claude_code_link failed:', e);
    }
  }

  async function openDriftDetail() {
    const report = coreState?.driftReport;
    if (!report) return;
    closeOverflow();
    try {
      await invoke('open_drift_detail', { report });
    } catch (e) {
      console.error('open_drift_detail failed:', e);
    }
  }

  async function handleQuit() {
    closeOverflow();
    try {
      await invoke('quit_app');
    } catch (e) {
      console.error('Failed to quit:', e);
    }
  }

  function dismissMembershipPrompt(slug: string) {
    dismissedMemberships = new Set(dismissedMemberships).add(slug);
  }

  function closeOverflow() {
    overflowOpen = false;
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

  function toggleOverflow(event: MouseEvent) {
    event.stopPropagation();
    overflowOpen = !overflowOpen;
  }

  function openSettings() {
    closeOverflow();
    onsettings();
  }

  function openMeetings() {
    closeOverflow();
    onmeetingsclick?.();
  }

  function toggleWorkspaceActions() {
    showWorkspaceActions = !showWorkspaceActions;
    closeOverflow();
  }

  function isWorkspaceSynced(w: Workspace): boolean {
    return w.state === 'synced' || (w.state === 'personal' && Boolean(w.cloudUid));
  }

  function isWorkspaceClickable(w: Workspace): boolean {
    return w.kind === 'company' && (w.state === 'synced' || w.state === 'cloud-only');
  }

  function workspaceStateLabel(w: Workspace): string {
    if (w.state === 'personal') return w.cloudUid ? 'Synced personal workspace' : 'Personal workspace, cloud unreachable';
    if (w.state === 'synced') return 'Synced';
    if (w.state === 'cloud-only') return 'Not on this machine yet';
    if (w.state === 'local-only') return 'Local only';
    return 'Needs reconnection';
  }

  async function handleWorkspaceOpen(w: Workspace) {
    if (!isWorkspaceClickable(w)) return;
    try {
      await open(`https://hq.computer/companies/${w.slug}`);
    } catch (err) {
      console.error('Failed to open company URL:', err);
    }
  }

  function coreUpdateLabel(): string {
    if (!coreState) return 'Update';
    if (coreState.channel === 'staging') {
      return coreState.versionBehind ? 'Update to Staging' : 'Restore Staging';
    }
    return coreState.versionBehind ? `Update to v${coreState.targetVersion}` : `Restore v${coreState.targetVersion}`;
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

  function measuredPopoverHeight(): number {
    if (!popoverContentEl) return POPOVER_MIN_HEIGHT;
    const headerEl = popoverContentEl.querySelector<HTMLElement>('.mbp-head');
    const footerEl = popoverContentEl.querySelector<HTMLElement>('.mbp-foot');
    const contentHeight =
      (headerEl?.offsetHeight ?? 0) +
      (popoverMainContentEl?.scrollHeight ?? 0) +
      (footerEl?.offsetHeight ?? 0);
    const menuBottom = overflowOpen && overflowEl
      ? overflowEl.getBoundingClientRect().bottom - popoverContentEl.getBoundingClientRect().top + 12
      : 0;
    return measuredSurfaceContentHeight({
      contentScrollHeight: Math.max(popoverContentEl.scrollHeight, contentHeight),
      floatingBottom: menuBottom,
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
    return () => {
      clearDesktopAltErrorTimer();
    };
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

  $effect(() => {
    const _overflowOpen = overflowOpen;
    if (!popoverContentEl) return;
    requestAnimationFrame(() => {
      resizePopoverWindow(clampPopoverHeight(measuredPopoverHeight()));
    });
  });

  $effect(() => {
    if (!overflowOpen) return;

    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (overflowEl?.contains(target) || overflowButtonEl?.contains(target))
      ) {
        return;
      }
      closeOverflow();
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOverflow();
    };

    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);

    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
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
  <header class="mbp-head" data-tauri-drag-region>
    <span class="mbp-mark" data-tauri-drag-region>
      <svg
        viewBox="0 0 280 161"
        fill="none"
        role="img"
        aria-label="HQ"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M85.7251 3.66162H118.034V154.434H85.7251V89.8176H32.3085V154.434H0V3.66162H32.3085V57.5091H85.7251V3.66162Z" fill="currentColor" />
        <path d="M257.169 160.035L241.014 144.096C235.343 147.973 229.096 150.988 222.276 153.142C215.527 155.296 208.419 156.373 200.952 156.373C190.757 156.373 181.172 154.363 172.197 150.342C163.223 146.25 155.325 140.65 148.505 133.542C141.684 126.362 136.335 118.07 132.458 108.664C128.581 99.187 126.642 89.0278 126.642 78.1865C126.642 67.417 128.581 57.3296 132.458 47.9242C136.335 38.4471 141.684 30.1187 148.505 22.939C155.325 15.7593 163.223 10.1592 172.197 6.1386C181.172 2.0462 190.757 0 200.952 0C211.219 0 220.84 2.0462 229.814 6.1386C238.789 10.1592 246.686 15.7593 253.507 22.939C260.328 30.1187 265.641 38.4471 269.446 47.9242C273.323 57.3296 275.261 67.417 275.261 78.1865C275.261 86.0123 274.184 93.5151 272.031 100.695C269.948 107.803 267.077 114.444 263.415 120.618L280 137.203L257.169 160.035ZM200.952 124.065C203.896 124.065 206.732 123.741 209.46 123.095C212.26 122.449 214.952 121.552 217.537 120.403L208.491 111.357L231.322 88.5252L239.291 96.4946C240.512 93.6946 241.409 90.7509 241.984 87.6637C242.63 84.5764 242.953 81.4173 242.953 78.1865C242.953 71.8684 241.84 65.9452 239.614 60.4168C237.461 54.8885 234.445 50.0422 230.568 45.878C226.691 41.642 222.204 38.3394 217.106 35.9701C212.08 33.529 206.696 32.3085 200.952 32.3085C195.208 32.3085 189.788 33.529 184.69 35.9701C179.664 38.3394 175.213 41.642 171.336 45.878C167.459 50.0422 164.407 54.8885 162.182 60.4168C160.028 65.9452 158.951 71.8684 158.951 78.1865C158.951 84.5046 160.028 90.4637 162.182 96.0639C164.407 101.592 167.459 106.474 171.336 110.71C175.213 114.875 179.664 118.141 184.69 120.511C189.788 122.88 195.208 124.065 200.952 124.065Z" fill="currentColor" />
      </svg>
    </span>

    <div class="mbp-overflow">
      <button
        bind:this={overflowButtonEl}
        class="mbp-icon"
        class:active={overflowOpen}
        type="button"
        onclick={toggleOverflow}
        aria-label="More"
        aria-expanded={overflowOpen}
        title="More"
        data-testid="popover-overflow-button"
      >
        <PopoverIcon name="dots-three" size={18} />
      </button>

      {#if overflowOpen}
        <div
          bind:this={overflowEl}
          class="mbp-menu"
          role="menu"
          data-testid="popover-overflow-menu"
        >
          <div class="mbp-menu-ver">
            <div class="mv-text">
              <span class="mv-name">{hqVersion ? `HQ v${hqVersion}` : 'HQ'}</span>
              {#if updateAvailable}
                <span class="mv-sub">v{updateAvailable.version} available</span>
              {:else if hqVersion}
                <span class="mv-sub ok">Up to date</span>
              {:else}
                <span class="mv-sub">Version unknown</span>
              {/if}
            </div>
            {#if updateAvailable}
              <button
                class="mv-btn"
                type="button"
                onclick={() => {
                  closeOverflow();
                  oninstallupdate?.();
                }}
                disabled={updateInstalling || !oninstallupdate}
                data-testid="popover-menu-update-button"
              >
                <PopoverIcon name="download-simple" size={13} />
                {updateInstalling ? 'Updating…' : 'Update'}
              </button>
            {:else if hqVersion === null}
              <CopyPromptButton
                variant="compact"
                label="Copy prompt"
                issue={{ kind: 'hq-version-undetectable', payload: { hqFolderPath: config?.hqFolderPath ?? '' } }}
              />
            {/if}
          </div>

          {#if coreState}
            {@const hasDrift = coreState.driftReport.count > 0}
            {@const needsUpdate = coreState.versionBehind || hasDrift}
            <div class="mbp-menu-pills">
              {#if coreState.isEligible}
                <button
                  class="mbp-pill {hasDrift ? 'notice' : ''}"
                  type="button"
                  onclick={openDriftDetail}
                  title={hasDrift
                    ? `${coreState.driftReport.count} locked core file${coreState.driftReport.count === 1 ? '' : 's'} edited since last sync vs ${coreState.targetRepo}@${coreState.targetVersion}.`
                    : `Locked core matches ${coreState.targetRepo}@${coreState.targetVersion}.`}
                >
                  {hasDrift ? `${coreState.driftReport.count} drifted` : 'in sync'}
                </button>
              {:else}
                <span class="mbp-pill notice">in sync</span>
              {/if}

              {#if needsUpdate && oninstallcore}
                <button
                  class="mbp-pill"
                  type="button"
                  onclick={() => {
                    closeOverflow();
                    oninstallcore?.();
                  }}
                  disabled={coreInstalling}
                >
                  {coreInstalling ? 'Updating...' : coreUpdateLabel()}
                </button>
              {/if}
            </div>
          {/if}

          {#if coreInstallLastResult}
            {#if coreInstallLastResult.kind === 'ok'}
              <span class="mbp-menu-note" title={coreInstallLastResult.logTail || coreInstallLastResult.logPath}>
                update done
              </span>
            {:else}
              <CopyPromptButton
                variant="inline"
                label="Update failed - copy fix"
                issue={{
                  kind: 'hq-core-update-failed',
                  payload: {
                    exitCode: coreInstallLastResult.exitCode,
                    logTail: coreInstallLastResult.logTail,
                    logPath: coreInstallLastResult.logPath,
                    channel: coreState?.channel ?? '',
                    targetVersion: coreState?.targetVersion ?? '',
                    targetRepo: coreState?.targetRepo ?? '',
                    hqVersion: hqVersion ?? '',
                  },
                }}
              />
            {/if}
          {/if}

          <div class="mbp-menu-divider"></div>

          <button class="mbp-menu-item" type="button" role="menuitem" onclick={openSettings}>
            <PopoverIcon name="gear" size={17} />
            <span class="grow">Settings</span>
          </button>
          {#if desktopAltEnabled}
            <button class="mbp-menu-item" type="button" role="menuitem" onclick={openDesktopAltWindow}>
              <PopoverIcon name="laptop" size={17} />
              <span class="grow">Open desktop view</span>
            </button>
          {/if}
          <button class="mbp-menu-item" type="button" role="menuitem" onclick={openActivityLog}>
            <PopoverIcon name="clock-counter-clockwise" size={17} />
            <span class="grow">Recent activity</span>
          </button>
          {#if meetingsEnabled && onmeetingsclick}
            <button class="mbp-menu-item" type="button" role="menuitem" onclick={openMeetings}>
              <PopoverIcon name="video-camera" size={17} />
              <span class="grow">Meetings</span>
              {#if meetingsPromptActive}
                <span class="mbp-menu-dot" title="Active"></span>
              {/if}
            </button>
          {/if}
          <button class="mbp-menu-item no-icon" type="button" role="menuitem" onclick={toggleWorkspaceActions}>
            <span class="grow">{showWorkspaceActions ? 'Hide workspace actions' : 'Workspace actions'}</span>
          </button>

          {#if hqCliUpdateAvailable || (packUpdateAvailable && packUpdateAvailable.count > 0)}
            <div class="mbp-menu-divider"></div>
          {/if}

          {#if hqCliUpdateAvailable}
            <div class="mbp-menu-block">
              <p>hq CLI update: v{hqCliUpdateAvailable.latest}</p>
              {#if hqCliUpdateError}
                <span>Update failed.</span>
              {:else if hqCliUpdateAvailable.local}
                <span>You're on v{hqCliUpdateAvailable.local}.</span>
              {/if}
              <div class="mbp-menu-actions">
                <button type="button" class="mbp-mini" onclick={copyHqCliCommand}>
                  {hqCliCmdCopied ? 'Copied' : 'Copy command'}
                </button>
                {#if hqCliUpdateError}
                  <button type="button" class="mbp-mini primary" onclick={fixHqCliUpdateInHq}>
                    Fix this in HQ
                  </button>
                {:else}
                  <button
                    type="button"
                    class="mbp-mini primary"
                    onclick={() => {
                      closeOverflow();
                      oninstallhqcliupdate?.();
                    }}
                    disabled={hqCliUpdateInstalling || !oninstallhqcliupdate}
                  >
                    {hqCliUpdateInstalling ? 'Installing...' : 'Update'}
                  </button>
                {/if}
                {#if ondismisshqcliupdate}
                  <button
                    type="button"
                    class="mbp-mini"
                    onclick={() => {
                      closeOverflow();
                      ondismisshqcliupdate?.();
                    }}
                  >
                    Dismiss
                  </button>
                {/if}
              </div>
            </div>
          {/if}

          {#if packUpdateAvailable && packUpdateAvailable.count > 0}
            <div class="mbp-menu-block">
              <p>{packUpdateTitle(packUpdateAvailable.count)}</p>
              {#if packUpdateError}
                <span>Update failed. Run <code>hq packs update</code>.</span>
              {:else}
                <span>{packUpdateAvailable.names.join(', ')}</span>
              {/if}
              <div class="mbp-menu-actions">
                <button
                  type="button"
                  class="mbp-mini primary"
                  onclick={() => {
                    closeOverflow();
                    onupdatepacks?.();
                  }}
                  disabled={packsUpdating || !onupdatepacks}
                >
                  {packsUpdating ? 'Updating...' : 'Update'}
                </button>
              </div>
            </div>
          {/if}

          <div class="mbp-menu-divider"></div>

          <button class="mbp-menu-item danger" type="button" role="menuitem" onclick={onsignout}>
            <PopoverIcon name="sign-out" size={17} />
            <span class="grow">Sign out</span>
          </button>
          <button class="mbp-menu-item danger" type="button" role="menuitem" onclick={handleQuit}>
            <PopoverIcon name="power" size={17} />
            <span class="grow">Quit</span>
          </button>
        </div>
      {/if}
    </div>

    <button
      class="mbp-sync"
      class:syncing={syncState === 'syncing'}
      class:error={syncState === 'error' || syncState === 'conflict'}
      type="button"
      onclick={handleSyncButtonClick}
      disabled={syncState === 'syncing' && !oncancel}
      title={syncButtonTitle()}
      data-testid="popover-sync-button"
    >
      {#if syncState === 'syncing' && oncancel}
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      {:else}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v5h-5" />
        </svg>
      {/if}
      {syncButtonLabel()}
    </button>
  </header>

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
      {#if syncState === 'syncing'}
        <span class="mbp-s2 prog" title={liveWorkspaceLine}>
          <span class="mbp-bar"><i style="width: {barPct}%"></i></span>
          <span class="mbp-pct">{Math.round(barPct)}%</span>
        </span>
      {:else}
        <span class="mbp-s2">{lastSyncLabel}</span>
      {/if}
    </div>

    <div class="mbp-segbar">
      <div class="seg-track" role="tablist" aria-label="Popover sections">
        <button
          class="seg"
          class:active={activeTab === 'notifications'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'notifications'}
          onclick={() => (activeTab = 'notifications')}
        >
          Notifications
          {#if notifBadge > 0}
            <span class="seg-badge">{notifBadge > 99 ? '99+' : notifBadge}</span>
          {/if}
        </button>
        <button
          class="seg"
          class:active={activeTab === 'workspaces'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'workspaces'}
          onclick={() => (activeTab = 'workspaces')}
        >
          Workspaces
        </button>
      </div>
    </div>

    <!-- Notifications — system notices (conflict / update / membership / auth /
         errors) pin to the top as feed rows, then recent DMs, shares, and
         new-file activity. A tap opens the matching detail window; grouped
         new-file rows expand inline. Kept mounted while hidden so listeners +
         unread count persist. -->
    <div class="mbp-panel" class:hidden={activeTab !== 'notifications'}>
      <section class="mbp-sec" aria-labelledby="popover-notifications-label">
        <div class="mbp-sec-head">
          <div class="mbp-lab" id="popover-notifications-label">Notifications</div>
          <button class="mbp-sec-action" type="button" onclick={handleMarkAllRead}>
            Mark all read
          </button>
        </div>

        {#if conflictModalActive && onresolve && onopen && ondismissconflicts}
          <div class="mbp-conflict-card">
            <ConflictModal
              {conflicts}
              onresolve={onresolve}
              onopen={onopen}
              ondismiss={ondismissconflicts}
            />
          </div>
        {/if}

        {#if desktopAltError}
          <div class="notif-row" role="status">
            <span class="notif-gly alert"><PopoverIcon name="warning" size={14} /></span>
            <div class="notif-main">
              <div class="notif-line1"><span class="notif-actor">Couldn’t open desktop view</span></div>
              <div class="notif-summary">{desktopAltError}</div>
            </div>
          </div>
        {/if}

        {#if membershipsToPull.length > 0}
          <div class="notif-row">
            <span class="notif-gly action"><PopoverIcon name="cloud-arrow-down" size={14} /></span>
            <div class="notif-main">
              <div class="notif-line1">
                <span class="notif-actor">{membershipNoticeTitle}</span>
              </div>
              <div class="notif-summary">
                Sync to pull {membershipsToPull.length > 1 ? 'them' : 'it'} onto this machine.
              </div>
              <div class="notif-act">
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
              </div>
            </div>
          </div>
        {/if}

        {#if updateAvailable}
          <div class="notif-row">
            <span class="notif-gly action"><PopoverIcon name="download-simple" size={14} /></span>
            <div class="notif-main">
              <div class="notif-line1"><span class="notif-actor">Update available</span></div>
              <div class="notif-summary">
                HQ v{updateAvailable.version}{updateAvailable.body ? ` — ${updateAvailable.body}` : ''}
              </div>
              <div class="notif-act">
                <button
                  type="button"
                  class="mbp-mini primary"
                  onclick={oninstallupdate}
                  disabled={updateInstalling || !oninstallupdate}
                >
                  {updateInstalling ? 'Installing…' : 'Install'}
                </button>
              </div>
            </div>
          </div>
        {/if}

        {#if syncState === 'conflict' && !conflictModalActive}
          <div class="notif-row">
            <span class="notif-gly alert"><PopoverIcon name="warning" size={14} /></span>
            <div class="notif-main">
              <div class="notif-line1"><span class="notif-actor">Sync paused</span></div>
              <div class="notif-summary">{conflictNoticeText}</div>
              <div class="notif-act">
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
              </div>
            </div>
          </div>
        {/if}

        {#if syncState === 'auth-error'}
          <div class="notif-row">
            <span class="notif-gly alert"><PopoverIcon name="warning" size={14} /></span>
            <div class="notif-main">
              <div class="notif-line1"><span class="notif-actor">Session expired</span></div>
              <div class="notif-summary">{errorMessage || 'Sign in again to keep syncing.'}</div>
              <div class="notif-act">
                <CopyPromptButton
                  variant="compact"
                  label="Copy prompt"
                  issue={{ kind: 'auth-expired', payload: { message: errorMessage } }}
                />
              </div>
            </div>
          </div>
        {:else if syncState === 'error' && errorMessage}
          <div class="notif-row">
            <span class="notif-gly alert"><PopoverIcon name="warning" size={14} /></span>
            <div class="notif-main">
              <div class="notif-line1"><span class="notif-actor">Finish sync in Claude Code</span></div>
              <div class="notif-summary">Sync started but needs a hand to complete.</div>
              <div class="notif-act">
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
              </div>
            </div>
          </div>
        {/if}

        {#if manifestError}
          <div class="notif-row" title={manifestError}>
            <span class="notif-gly alert"><PopoverIcon name="warning" size={14} /></span>
            <div class="notif-main">
              <div class="notif-line1"><span class="notif-actor">Couldn’t read companies list</span></div>
              <div class="notif-summary">companies/manifest.yaml could not be read.</div>
              <div class="notif-act">
                <CopyPromptButton
                  variant="compact"
                  label="Copy fix prompt"
                  issue={{ kind: 'manifest-error', payload: { error: manifestError } }}
                />
              </div>
            </div>
          </div>
        {/if}

        {#if !cloudReachable}
          <div class="notif-row" title={cloudError ?? ''}>
            <span class="notif-gly warn"><PopoverIcon name="warning" size={14} /></span>
            <div class="notif-main">
              <div class="notif-line1"><span class="notif-actor">Cloud unreachable</span></div>
              <div class="notif-summary">Showing local folders.</div>
              <div class="notif-act">
                <CopyPromptButton
                  variant="compact"
                  label="Copy diagnose prompt"
                  issue={{ kind: 'cloud-unreachable', payload: { error: cloudError ?? '' } }}
                />
              </div>
            </div>
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

    <div class="mbp-panel" class:hidden={activeTab !== 'workspaces'}>
    <section class="mbp-sec" aria-labelledby="popover-workspaces-label">
      <div class="mbp-sec-head">
        <div class="mbp-lab" id="popover-workspaces-label">Workspaces</div>
        {#if compactWorkspaces.length > 0}
          <span class="mbp-lab-count">{syncedWorkspaceCount} of {compactWorkspaces.length} synced</span>
        {/if}
      </div>
      {#if compactWorkspaces.length > 0}
        <div class="mbp-list">
          {#each compactWorkspaces as w (`${w.kind}:${w.slug}`)}
            {#if isWorkspaceClickable(w)}
              <button
                class="mbp-co clickable"
                type="button"
                onclick={() => handleWorkspaceOpen(w)}
                title={workspaceStateLabel(w)}
                aria-label={`${w.displayName} - ${workspaceStateLabel(w)}`}
                data-testid="popover-workspace-row"
                data-workspace-key={`${w.kind}:${w.slug}`}
              >
                <span class="nm">
                  <span class="who">{w.displayName}</span>
                  {#if w.state === 'personal'}
                    <span class="tag">Personal</span>
                  {/if}
                </span>
                {#if isWorkspaceSynced(w)}
                  <span class="sti on" aria-label="Synced">
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 7.5 6 10.5 11 4" />
                    </svg>
                  </span>
                {:else if w.state === 'local-only'}
                  <span class="sti local" aria-label={workspaceStateLabel(w)}>
                    <PopoverIcon name="laptop" size={12} />
                  </span>
                {:else}
                  <span class="sti off" aria-label={workspaceStateLabel(w)}></span>
                {/if}
              </button>
            {:else}
              <div
                class="mbp-co"
                title={workspaceStateLabel(w)}
                data-testid="popover-workspace-row"
                data-workspace-key={`${w.kind}:${w.slug}`}
              >
                <span class="nm">
                  <span class="who">{w.displayName}</span>
                  {#if w.state === 'personal'}
                    <span class="tag">Personal</span>
                  {/if}
                </span>
                {#if isWorkspaceSynced(w)}
                  <span class="sti on" aria-label="Synced">
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 7.5 6 10.5 11 4" />
                    </svg>
                  </span>
                {:else if w.state === 'local-only'}
                  <span class="sti local" aria-label={workspaceStateLabel(w)}>
                    <PopoverIcon name="laptop" size={12} />
                  </span>
                {:else}
                  <span class="sti off" aria-label={workspaceStateLabel(w)}></span>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {:else}
        <p class="mbp-empty">No workspaces yet</p>
      {/if}

      {#if showWorkspaceActions && workspaces}
        <div class="mbp-advanced" data-testid="popover-workspace-actions">
          <WorkspaceList
            {workspaces}
            cloudReachable={cloudReachable}
            cloudError={cloudError}
            manifestError={manifestError}
            hqFolderPath={config?.hqFolderPath ?? ''}
            onrefresh={onworkspacesrefresh}
          />
        </div>
      {/if}
    </section>
    </div>
    </div>
  </div>

  {#if desktopAltEnabled}
    <div class="mbp-foot">
      <button
        class="mbp-open"
        type="button"
        onclick={openDesktopAltWindow}
        data-testid="desktop-alt-toggle"
      >
        <span data-testid="popover-open-desktop-view">Open desktop view</span>
      </button>
    </div>
  {/if}
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

  :global([data-tauri-drag-region] button),
  :global([data-tauri-drag-region] a),
  :global([data-tauri-drag-region] input) {
    -webkit-app-region: no-drag;
  }

  .mbp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 0.5px solid var(--pop-divider);
    flex-shrink: 0;
  }

  .mbp-mark {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    color: var(--pop-text);
  }

  .mbp-mark svg {
    height: 14px;
    width: auto;
    opacity: 0.92;
  }

  .mbp-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 7px;
    border: none;
    background: transparent;
    color: var(--pop-icon);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    -webkit-app-region: no-drag;
  }

  .mbp-icon:hover,
  .mbp-icon:focus-visible,
  .mbp-icon.active {
    background: var(--pop-hover);
    color: var(--pop-text);
  }

  .mbp-icon:focus-visible,
  .mbp-sync:focus-visible,
  .mbp-open:focus-visible,
  .mbp-menu-item:focus-visible,
  .mbp-mini:focus-visible,
  .mbp-pill:focus-visible {
    outline: 1.5px solid var(--popover-focus-ring, var(--pop-accent));
    outline-offset: var(--popover-focus-offset, 2px);
  }

  .mbp-sync {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 13px;
    border: none;
    border-radius: 8px;
    background: var(--pop-accent);
    color: var(--pop-acc-fg);
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.12s, opacity 0.12s;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    -webkit-app-region: no-drag;
  }

  .mbp-sync:hover:not(:disabled) {
    filter: brightness(1.07);
  }

  .mbp-sync:disabled {
    opacity: 0.65;
    cursor: default;
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

  .mbp-menu-block p,
  .mbp-empty {
    margin: 0;
  }

  .mbp-menu-block span {
    color: var(--pop-muted);
  }

  .mbp-menu-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  /* Detailed conflict resolver keeps its own card; the lighter conflict
     summary folds into the feed as a system-notice row. */
  .mbp-conflict-card {
    padding: 6px 6px 0;
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
    background: #eab308;
    box-shadow: 0 0 7px rgba(234, 179, 8, 0.5);
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

  /* Mid-sync the "last sync" line becomes an inline progress meter + percent
     (prototype `.s2.prog`) instead of a separate progress block below. */
  .mbp-s2.prog {
    display: flex;
    align-items: center;
    gap: 7px;
    overflow: visible;
  }

  .mbp-bar {
    width: 60px;
    height: 5px;
    border-radius: 999px;
    background: var(--pop-hover);
    overflow: hidden;
    flex-shrink: 0;
  }

  .mbp-bar > i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--pop-accent);
    transition: width 0.25s ease-out;
  }

  .mbp-pct {
    color: var(--pop-text);
    font-variant-numeric: tabular-nums;
  }

  .mbp-segbar {
    padding: 3px 12px 4px;
  }

  .mbp-sec {
    padding: 6px;
    border-top: 0.5px solid var(--pop-divider);
  }

  .mbp-lab {
    color: var(--pop-muted);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    padding: 6px 8px 4px;
  }

  .mbp-lab-count {
    margin-left: auto;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--pop-muted);
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
    padding: 6px 8px 4px;
  }

  .mbp-list {
    display: flex;
    flex-direction: column;
  }

  .mbp-co {
    /* Rows render as either <button> (clickable) or <div> (not). A <button>
       defaults to box-sizing:border-box while a <div> is content-box, so with
       width:100% + horizontal padding the div rows overflowed by the padding
       and their right-aligned state indicator drifted right (and clipped).
       Pin border-box so both row types align identically. */
    box-sizing: border-box;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px;
    border-radius: 7px;
    border: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: default;
  }

  .mbp-co.clickable {
    cursor: pointer;
  }

  .mbp-co:hover {
    background: var(--pop-hover);
  }

  .mbp-co.clickable:focus-visible {
    background: var(--pop-hover);
    outline: 1.5px solid var(--popover-focus-ring, var(--pop-accent));
    outline-offset: var(--popover-focus-offset, 2px);
  }

  .mbp-co .nm {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--pop-text);
    font-size: 13px;
  }

  .mbp-co .who {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mbp-co .tag {
    flex-shrink: 0;
    font-size: 9.5px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 5px;
    background: var(--pop-hover);
    color: var(--pop-muted);
    letter-spacing: 0.2px;
  }

  .mbp-co .sti {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .mbp-co .sti svg {
    width: 12px;
    height: 12px;
    display: block;
    flex-shrink: 0;
  }

  .mbp-co .sti.on {
    background: var(--popover-success-bg);
    color: var(--popover-success);
  }

  @media (prefers-color-scheme: dark) {
    .mbp-co .sti.on {
      background: var(--popover-success-bg);
      color: var(--popover-success);
    }
  }

  :global(.dark) .mbp-co .sti.on {
    background: var(--popover-success-bg);
    color: var(--popover-success);
  }

  .mbp-co .sti.off {
    background: var(--pop-hover);
  }

  .mbp-co .sti.local {
    background: var(--pop-hover);
    color: var(--pop-muted);
  }

  .mbp-empty {
    padding: 6px 8px 8px;
    color: var(--pop-muted);
    font-size: 12px;
  }

  .mbp-advanced {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 0.5px solid var(--pop-divider);
  }

  .mbp-foot {
    padding: 7px 12px 12px;
    border-top: 0.5px solid var(--pop-divider);
    flex-shrink: 0;
  }

  .mbp-open {
    width: 100%;
    height: 30px;
    border: 0.5px solid var(--pop-border);
    border-radius: 8px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-family: inherit;
    font-size: 12.5px;
    cursor: pointer;
    transition: filter 0.12s;
  }

  .mbp-open:hover {
    filter: brightness(0.96);
  }

  .mbp-overflow {
    position: relative;
    flex-shrink: 0;
  }

  .mbp-menu {
    position: absolute;
    top: 34px;
    right: -86px;
    width: 240px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    border-radius: 12px;
    border: 0.5px solid var(--menu-border);
    background: var(--menu-bg);
    backdrop-filter: blur(40px) saturate(1.9);
    -webkit-backdrop-filter: blur(40px) saturate(1.9);
    box-shadow: var(--menu-shadow), inset 0 1px 0 var(--menu-inset);
  }

  .mbp-menu-pills,
  .mbp-menu-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Version row — name + "Up to date" / "vX available", with an inline Update
     button when a build is ready (prototype `.menu-ver`). */
  .mbp-menu-ver {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 9px;
  }

  .mv-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .mv-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--pop-text);
  }

  .mv-sub {
    font-size: 11px;
    color: var(--pop-muted);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .mv-sub.ok {
    color: var(--popover-success);
  }

  .mv-btn {
    height: 25px;
    padding: 0 11px;
    border: 0;
    border-radius: 7px;
    background: var(--pop-accent);
    color: var(--pop-acc-fg);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  }

  .mv-btn:hover:not(:disabled) {
    filter: brightness(1.07);
  }

  .mv-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .mbp-menu-pills {
    flex-wrap: wrap;
    padding: 0 4px 3px;
  }

  .mbp-menu-note {
    color: var(--pop-muted);
    font-size: 11px;
    padding: 0 4px;
  }

  .mbp-menu-divider {
    height: 0.5px;
    background: var(--pop-divider);
    margin: 5px 7px;
  }

  .mbp-menu-item {
    width: 100%;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 11px;
    padding: 0 9px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--pop-text);
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .mbp-menu-item .grow {
    flex: 1;
    min-width: 0;
  }

  .mbp-menu-item.no-icon {
    padding-left: 38px;
  }

  .mbp-menu-item :global(.ph) {
    color: var(--pop-icon);
  }

  .mbp-menu-item:hover,
  .mbp-menu-item:focus-visible {
    background: var(--pop-hover);
    outline: none;
  }

  .mbp-menu-item:hover :global(.ph) {
    color: var(--pop-text);
  }

  .mbp-menu-item.danger {
    color: var(--pop-muted);
  }

  .mbp-menu-item.danger :global(.ph) {
    color: var(--pop-muted);
  }

  .mbp-menu-item.danger:hover,
  .mbp-menu-item.danger:focus-visible {
    color: var(--pop-text);
  }

  .mbp-menu-item.danger:hover :global(.ph) {
    color: var(--pop-text);
  }

  .mbp-menu-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--popover-success);
    flex-shrink: 0;
    box-shadow: 0 0 6px var(--popover-success-bg);
  }

  .mbp-menu-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border-radius: 8px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-size: 11px;
  }

  .mbp-menu-actions {
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .mbp-mini,
  .mbp-pill {
    border: 0;
    border-radius: 6px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .mbp-mini {
    min-height: 23px;
    padding: 0 8px;
  }

  .mbp-pill {
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--pop-accent);
    color: var(--pop-acc-fg);
  }

  .mbp-pill.notice {
    background: var(--pop-hover);
    color: var(--pop-muted);
  }

  .mbp-mini.primary {
    background: var(--pop-accent);
    color: var(--pop-acc-fg);
  }

  .mbp-mini:disabled,
  .mbp-pill:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .mbp-panel.hidden {
    display: none;
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
