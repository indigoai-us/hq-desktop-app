<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { open } from '@tauri-apps/plugin-shell';
  import { onMount, untrack } from 'svelte';
  import ConflictModal from './ConflictModal.svelte';
  import WorkspaceList from './WorkspaceList.svelte';
  import CopyPromptButton from './CopyPromptButton.svelte';
  import OpenInClaudeCodeButton from './OpenInClaudeCodeButton.svelte';
  import { dedupeWorkspaces, joinableMemberships, type Workspace } from '../lib/workspaces';
  import { liveProgressCaption } from '../lib/live-progress-caption';
  import { isCorePath, CORE_SETUP_LABEL } from '../lib/progressLabel';
  import { packUpdateTitle } from '../lib/packUpdate';
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

  const POPOVER_WIDTH = 296;
  const POPOVER_MIN_HEIGHT = 226;
  const POPOVER_MAX_HEIGHT = 480;
  const HQ_CLI_UPGRADE_CMD = 'npm install -g @indigoai-us/hq-cli@latest';

  let popoverEl: HTMLElement | null = $state(null);
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

  function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
  }

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
    try {
      void getCurrentWindow().setSize(new LogicalSize(POPOVER_WIDTH, POPOVER_MAX_HEIGHT));
    } catch {
      // Non-Tauri / test environment.
    }
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
      await open(`https://hq.getindigo.ai/companies/${w.slug}`);
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
    if (Math.abs(height - lastWindowHeight) < 2) return;
    lastWindowHeight = height;
    try {
      void getCurrentWindow().setSize(new LogicalSize(POPOVER_WIDTH, height));
    } catch {
      // Non-Tauri / test environment.
    }
  }

  function measuredPopoverHeight(): number {
    if (!popoverEl) return POPOVER_MIN_HEIGHT;
    const menuBottom = overflowOpen && overflowEl
      ? overflowEl.offsetTop + overflowEl.scrollHeight + 12
      : 0;
    return Math.max(Math.ceil(popoverEl.scrollHeight), menuBottom);
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
    if (!popoverEl || typeof ResizeObserver === 'undefined') return;

    let raf = 0;
    const syncSize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        resizePopoverWindow(clamp(measuredPopoverHeight(), POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT));
      });
    };

    const observer = new ResizeObserver(syncSize);
    observer.observe(popoverEl);
    syncSize();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  });

  $effect(() => {
    const _overflowOpen = overflowOpen;
    if (!popoverEl) return;
    requestAnimationFrame(() => {
      resizePopoverWindow(clamp(measuredPopoverHeight(), POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT));
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

    <button
      class="mbp-icon"
      type="button"
      onclick={openSettings}
      aria-label="Settings"
      title="Settings"
      data-testid="popover-settings-gear"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z" />
      </svg>
    </button>

    <div class="mbp-overflow">
      <button
        bind:this={overflowButtonEl}
        class="mbp-icon"
        type="button"
        onclick={toggleOverflow}
        aria-label="More"
        aria-expanded={overflowOpen}
        title="More"
        data-testid="popover-overflow-button"
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {#if overflowOpen}
        <div
          bind:this={overflowEl}
          class="mbp-menu"
          role="menu"
          data-testid="popover-overflow-menu"
        >
          <div class="mbp-menu-version">
            <span>{hqVersion ? `HQ v${hqVersion}` : 'HQ version unknown'}</span>
            {#if hqVersion === null}
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
            Settings
          </button>
          {#if desktopAltEnabled}
            <button class="mbp-menu-item" type="button" role="menuitem" onclick={openDesktopAltWindow}>
              Open desktop view
            </button>
          {/if}
          <button class="mbp-menu-item" type="button" role="menuitem" onclick={openActivityLog}>
            Recent activity
          </button>
          {#if meetingsEnabled && onmeetingsclick}
            <button class="mbp-menu-item" type="button" role="menuitem" onclick={openMeetings}>
              Meetings{meetingsPromptActive ? ' · active' : ''}
            </button>
          {/if}
          <button class="mbp-menu-item" type="button" role="menuitem" onclick={toggleWorkspaceActions}>
            {showWorkspaceActions ? 'Hide workspace actions' : 'Workspace actions'}
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

          <div class="mbp-menu-row">
            <button class="mbp-menu-item danger" type="button" role="menuitem" onclick={onsignout}>
              Sign out
            </button>
            <button class="mbp-menu-item danger" type="button" role="menuitem" onclick={handleQuit}>
              Quit
            </button>
          </div>
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

    {#if desktopAltError || updateAvailable || manifestError || !cloudReachable || membershipsToPull.length > 0 || syncState === 'auth-error' || (syncState === 'error' && errorMessage) || syncState === 'conflict'}
      <div class="mbp-notices">
        {#if desktopAltError}
          <div class="mbp-banner" role="status">
            <p>{desktopAltError}</p>
          </div>
        {/if}

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

    <section class="mbp-sec" aria-labelledby="popover-workspaces-label">
      <div class="mbp-lab" id="popover-workspaces-label">Workspaces</div>
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

<style>
  .popover {
    width: min(100vw, 296px);
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
    transform-origin: top right;
  }

  .mbpop.opening {
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
    .mbpop.opening {
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
  .mbp-icon:focus-visible {
    background: var(--pop-hover);
    color: var(--pop-text);
  }

  .mbp-icon:focus-visible,
  .mbp-sync:focus-visible,
  .mbp-open:focus-visible,
  .mbp-menu-item:focus-visible,
  .mbp-mini:focus-visible,
  .mbp-pill:focus-visible,
  .mbp-dismiss:focus-visible {
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
  .mbp-menu-block p,
  .mbp-progress p,
  .mbp-empty {
    margin: 0;
  }

  .mbp-banner p {
    font-weight: 600;
  }

  .mbp-banner span,
  .mbp-menu-block span {
    color: var(--pop-muted);
  }

  .mbp-banner-actions,
  .mbp-menu-actions {
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
    color: var(--pop-muted);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    padding: 6px 8px 4px;
  }

  .mbp-list {
    display: flex;
    flex-direction: column;
  }

  .mbp-co {
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
    width: 248px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    border-radius: 10px;
    border: 0.5px solid var(--pop-border);
    background: var(--pop-bg);
    backdrop-filter: blur(28px) saturate(1.6);
    -webkit-backdrop-filter: blur(28px) saturate(1.6);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.22), inset 0 1px 0 var(--pop-highlight);
  }

  .mbp-menu-version,
  .mbp-menu-row,
  .mbp-menu-pills,
  .mbp-menu-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mbp-menu-version {
    justify-content: space-between;
    color: var(--pop-text);
    font-size: 12px;
    font-weight: 600;
    padding: 3px 4px 5px;
  }

  .mbp-menu-row {
    gap: 4px;
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
    margin: 3px 0;
  }

  .mbp-menu-item {
    width: 100%;
    min-height: 26px;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 0 8px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--pop-text);
    font-family: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .mbp-menu-row .mbp-menu-item {
    flex: 1;
    justify-content: center;
  }

  .mbp-menu-item:hover,
  .mbp-menu-item:focus-visible {
    background: var(--pop-hover);
    outline: none;
  }

  .mbp-menu-item.danger {
    color: var(--pop-muted);
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
</style>
