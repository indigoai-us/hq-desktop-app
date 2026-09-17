<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { emit, listen } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import {
    isPermissionGranted as isNotifyPermissionGranted,
    sendNotification,
  } from '@tauri-apps/plugin-notification';
  import {
    type DmRequest,
    enrichRequestFromContacts,
    requestBannerTitle,
    requestBannerBody,
    requestHasHumanLabel,
  } from './lib/dmRequests';
  import SignInPrompt from './components/SignInPrompt.svelte';
  import {
    isExpectedUnauthenticatedError,
    shouldSkipSignIn,
  } from './lib/auth';
  import { shouldRecheckAuthOnFocus } from './lib/authRecheckGate';
  import { isOnboardingState, type LifecycleState } from './lib/lifecycle';
  import { wizardModeForLifecycle } from './lib/onboarding-wizard';
  import { ListenerRegistry, subscribeWindowFocus } from './lib/listener-registry';
  import type { WorkspacesResult } from './lib/workspaces';
  import type { Channel } from './lib/channels';
  import { ChannelUnreadTracker } from './lib/channelUnreadTracker';
  import { UnreadSummaryTracker } from './lib/unreadSummaryTracker';
  import { TrayMessageBadgePublisher } from './lib/trayMessageBadge';
  import { RecordingActionAckCoordinator } from './lib/recordingActionAck';
  import {
    BannerActionRouter,
    type BannerActionEvent,
    type NotificationActionKind,
  } from './lib/bannerActionRouter';
  import {
    surfaceNativeNotificationRetry,
    type NativeNotificationRecovery,
  } from './lib/nativeNotificationRecovery';
  import { RECOVERY_EVENT, RETRY_EVENT } from '@hq/ui';
  import {
    applyBrandToDocument,
    cacheLogoAssets,
    readBrandCache,
    syncBrandFromWorkspaces,
    type CachedBrand,
  } from './lib/brand';
  import { loadMeetingDetectEligible } from './lib/permissionState.svelte';
  import { buildClaudeCodeUrl } from './lib/claude-code-link';
  import { emitDesktopTelemetry } from './lib/desktop-telemetry';
  import {
    handleMeetingDetected,
    type MeetingDetectedPayload,
  } from './lib/meetingDetection';
  import Onboarding from './components/Onboarding.svelte';
  import {
    armStopWatchdog,
    clearStopWatchdog,
    resolveStopTimeout,
  } from './lib/stopWatchdog';
  import { TELEMETRY_CONSENT_VERSION } from './lib/consent-version';
  import { markConsentRepromptShown } from './lib/onboarding-telemetry';
  import './styles/popover.css';

  interface Config {
    configured: boolean;
    companySlug: string;
    hqFolderPath: string;
    error?: string;
  }

  interface ContactIdentityResponse {
    contacts: Array<{
      personUid: string;
      email?: string | null;
      displayName?: string | null;
    }>;
  }

  async function enrichIncomingRequest(req: DmRequest): Promise<DmRequest> {
    if (requestHasHumanLabel(req)) return req;
    try {
      const response = await invoke<ContactIdentityResponse>('list_contacts');
      return enrichRequestFromContacts(req, response.contacts ?? []);
    } catch (err) {
      console.warn('dm-request: contact label lookup failed', err);
      return req;
    }
  }

  let authenticated = $state(false);
  let expiresAt = $state('');
  let checking = $state(true);
  let lifecycleState = $state<string | null>(null);
  // US-005: when the server reports this person's recorded consent as stale
  // (pre-versioned, administrative, or below the current version), the blocking
  // consent step is shown once. `null` means no re-prompt is due; otherwise it
  // carries the `prs_*` the "shown once" guard is keyed to. Server-authoritative
  // and fail-quiet: an unreachable server leaves this null and never blocks.
  let consentReprompt = $state<{ personUid: string } | null>(null);
  // "Replay welcome intro" from the menu-bar menu. Re-runs the first-run film
  // on the main window without touching the first-run flags; clears when the
  // film ends or is skipped.
  let replayIntro = $state(false);
  let syncState = $state<'idle' | 'syncing' | 'error' | 'conflict' | 'setup-needed' | 'auth-error'>('idle');
  // True while a manual "Sync Now" owns the progress UI — its richer
  // stdout-driven stream (fanout-aware) drives the card. Gates out the
  // cross-process file-watcher so the two sources never fight. Set on the Sync
  // Now click, cleared when the run ends.
  let manualSyncActive = $state(false);
  let manualSyncTelemetryPending = $state(false);
  // True while the cross-process watcher (auto-sync / CLI `hq sync`) owns the
  // card — lets sync:external-idle know it should reset back to idle.
  let externalSyncActive = $state(false);
  let config = $state<Config | null>(null);
  // filesSkipped is not on sync:all-complete (backend only aggregates
  // filesDownloaded), so we sum it client-side from per-company complete
  // events and report it in the manual-sync telemetry below.
  let syncFanoutFilesSkipped = $state(0);
  let syncStatsRefresh = $state<(() => void) | null>(null);

  // Meetings feature flag — driven by `meetings_feature_enabled` (Rust side
  // decodes the cached Cognito id_token; GA — true for any signed-in user).
  // The icon doesn't render at all when this is false. Click opens the standalone
  // `meetings-window` (mirrors the `new-files-detail` window pattern) — the
  // earlier modal-on-tray-window UX was too cramped.
  let meetingsEnabled = $state(false);

  // Live counts for the macOS menu-bar Messages badge (US-009). Fed by the
  // `dm:unread-summary` event (emitted by the SINGLE DM poll path on every
  // change — no separate poller) and seeded once on mount via
  // `get_unread_summary`. Reset to 0 unread by Rust when the Messages window
  // opens.
  let unreadSummary = $state<{
    unreadDms: number;
    pendingRequests: number;
    channelUnread: number;
  }>({
    unreadDms: 0,
    pendingRequests: 0,
    channelUnread: 0,
  });
  const messagesUnreadCount = $derived(
    Math.max(0, unreadSummary.unreadDms) +
      Math.max(0, unreadSummary.pendingRequests) +
      Math.max(0, unreadSummary.channelUnread),
  );
  const trayMessageBadgePublisher = new TrayMessageBadgePublisher(
    (count) => invoke<void>('set_tray_message_badge', { count }),
    (error) => console.error('set_tray_message_badge failed:', error),
  );
  const channelUnreadTracker = new ChannelUnreadTracker();
  const unreadSummaryTracker = new UnreadSummaryTracker();
  const CHANNEL_UNREAD_RETRY_MS = 1_000;
  let channelUnreadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let channelUnreadDisposed = false;

  $effect(() => {
    void trayMessageBadgePublisher.publish(
      authenticated ? messagesUnreadCount : 0,
    );
  });

  // Memberships drive the company picker in the active-meetings row.
  // Loaded once on mount (same source as MeetingsWindow's URL-invite
  // dropdown). Errors degrade to an empty list — the row still renders
  // with Personal as the only option, never blocking detection or
  // recording on a vault hiccup.
  interface MembershipRow {
    companyUid: string;
    companyName: string | null;
    role: string | null;
    status: string;
  }
  let memberships = $state<MembershipRow[]>([]);
  // Default company UID for new recordings — read from menubar.json on
  // mount. Per-recording overrides happen in the MeetingsWindow row dropdown
  // and never write back here; that mutation belongs to Settings.
  let defaultRecordingCompanyUid = $state<string | null>(null);

  /**
   * Active meeting detections — populated as the Recall Desktop SDK fires
   * `meeting:detected` events. Lives only in-memory: we don't persist
   * across app restarts because the SDK re-emits detections after restart
   * if a meeting window is still active.
   *
   * Keyed implicitly by `windowId` (the SDK's stable handle for the
   * meeting window). Entries are added on `meeting:detected`, mutated
   * on `recording:started` / `recording:ended` / `recording:error`,
   * and removed on `meeting:closed`.
   *
   * Surfaced to the user via MeetingsWindow's "Active meetings" strip,
   * where each entry gets a Record / Stop button wired back into the
   * `start_recording` / `stop_recording` Tauri commands.
   */
  interface ActiveMeeting {
    /** SDK window id (stable for the duration of the meeting). */
    windowId: string;
    /** Lowercase platform discriminator (`zoom`, `meet`, ...). */
    platform: string;
    /** Meeting URL — real or synthetic `recall-window:<id>`. */
    meetingUrl: string;
    /** ISO 8601 timestamp when the detection fired. */
    detectedAt: string;
    /** Lifecycle state — drives the Record/Stop button label. */
    state: 'detected' | 'starting' | 'recording' | 'stopping' | 'error';
    /** Recall.ai recording id (returned by start_recording). */
    recordingId?: string;
    /** Last error message from a failed start/stop, if any. */
    error?: string;
    /**
     * Company attribution for this recording. `null` = Personal vault.
     * Seeded from `defaultRecordingCompanyUid` at detection, but the
     * default may not have loaded yet when a detection fires — so the
     * authoritative resolution happens at `handleStartRecording` time
     * (and we back-fill rows when the default finishes loading).
     */
    companyUid: string | null;
    /**
     * True once the user has explicitly picked a company for this row via
     * the dropdown. Distinguishes an intentional "Personal" (companyUid =
     * null, userSet = true) from "default hasn't loaded yet" (companyUid =
     * null, userSet = false). Only the latter gets back-filled / resolved
     * to the default.
     */
    companyUserSet?: boolean;
  }
  let activeMeetings = $state<ActiveMeeting[]>([]);
  const recordingActionAcks = new RecordingActionAckCoordinator();

  function upsertActiveMeeting(m: ActiveMeeting) {
    const idx = activeMeetings.findIndex((x) => x.windowId === m.windowId);
    if (idx >= 0) {
      activeMeetings[idx] = m;
    } else {
      activeMeetings = [...activeMeetings, m];
    }
  }
  function updateActiveMeeting(
    windowId: string,
    patch: Partial<ActiveMeeting>,
  ) {
    const idx = activeMeetings.findIndex((x) => x.windowId === windowId);
    if (idx < 0) return;
    activeMeetings[idx] = { ...activeMeetings[idx], ...patch };
  }
  function removeActiveMeeting(windowId: string) {
    activeMeetings = activeMeetings.filter((x) => x.windowId !== windowId);
  }

  /**
   * The persisted default company, but only if it's still a company the
   * user is an active member of. Returns null (Personal) otherwise — never
   * pre-select a stale uid the user can't record to (hq-pro would 403).
   */
  function resolveValidDefault(): string | null {
    return defaultRecordingCompanyUid &&
      memberships.some((m) => m.companyUid === defaultRecordingCompanyUid)
      ? defaultRecordingCompanyUid
      : null;
  }

  async function handleStartRecording(windowId: string, throwOnError = false) {
    updateActiveMeeting(windowId, { state: 'starting', error: undefined });
    // Resolve the company at START time, not just whatever was frozen on
    // the row at detection. The detection may have fired before the
    // default-company context finished loading (it's a fire-and-forget
    // load after an async feature-gate check), leaving companyUid null on
    // the row. Unless the user *explicitly* picked a company, fall back to
    // the current valid default — this is what fixes the notification
    // "Record" path attributing to Personal even when a default is set.
    const row = activeMeetings.find((m) => m.windowId === windowId);
    const companyUid = row?.companyUserSet
      ? (row.companyUid ?? null)
      : (resolveValidDefault() ?? row?.companyUid ?? null);
    // Reflect the resolved attribution back onto the row so the MeetingsWindow
    // dropdown shows what we actually recorded against.
    if (row && row.companyUid !== companyUid) {
      updateActiveMeeting(windowId, { companyUid });
    }
    try {
      await recordingActionAcks.start(windowId, async () => {
        const recordingId = await invoke<string>('start_recording', {
          windowId,
          companyUid,
        });
        updateActiveMeeting(windowId, { recordingId });
        return recordingId;
      });
      // Resolution means BOTH bridge dispatch and the matching
      // `recording:started` lifecycle event completed. Concurrent clicks and
      // post-timeout retries share the same semantic operation by window id.
    } catch (err) {
      console.error('start_recording failed:', err);
      updateActiveMeeting(windowId, {
        state: 'error',
        error: typeof err === 'string' ? err : String(err),
      });
      // Most meeting surfaces render the row-level error above and intentionally
      // remain fire-and-forget. The acknowledged notification path opts into a
      // rejection so its banner/widget row cannot disappear on a failed start.
      if (throwOnError) throw err;
    }
  }

  function handleChangeRecordingCompany(windowId: string, companyUid: string | null) {
    // User explicitly picked a company — mark it so the start-time resolver
    // and the default back-fill both respect this choice (including an
    // intentional "Personal").
    //
    // The dropdown is editable during recording too. NOTE: changing it
    // mid-recording updates the row's intent but does NOT yet re-attribute
    // the recording — the Recall metadata is baked at upload-token mint
    // (start) time. True "company at end" requires the hq-pro `/finalize`
    // endpoint (a tracked follow-up); until that ships, the START company
    // is what routes. We still capture the value here so the finalize
    // wiring is a drop-in once that endpoint exists.
    updateActiveMeeting(windowId, { companyUid, companyUserSet: true });
  }

  /**
   * Load the memberships list + the persisted default-recording-company
   * UID into module state. Called once on mount when the meeting-detect
   * feature is enabled for this user. Best-effort — both reads degrade
   * to empty / null on error so a vault hiccup never blocks MeetingsWindow
   * from rendering or the user from recording (the row just shows
   * Personal as the only option, which is the safe default).
   */
  async function loadRecordingCompanyContext() {
    try {
      const [list, settings] = await Promise.all([
        invoke<MembershipRow[]>('meetings_list_memberships').catch(() => []),
        invoke<{ defaultRecordingCompanyUid?: string | null }>('get_settings').catch(
          () => ({} as { defaultRecordingCompanyUid?: string | null }),
        ),
      ]);
      memberships = (list ?? []).filter((m) => m.status === 'active');
      const storedUid = settings?.defaultRecordingCompanyUid ?? null;
      defaultRecordingCompanyUid = storedUid && memberships.some((m) => m.companyUid === storedUid)
        ? storedUid
        : null;
      // Back-fill any detections that fired before this load completed:
      // rows the user hasn't explicitly touched should reflect the default
      // (or stay Personal if there's no valid default). Without this, a
      // meeting detected during cold-start keeps companyUid=null and the
      // notification "Record" path attributes it to Personal.
      const validDefault = resolveValidDefault();
      if (validDefault) {
        for (const m of activeMeetings) {
          if (!m.companyUserSet && m.companyUid !== validDefault) {
            updateActiveMeeting(m.windowId, { companyUid: validDefault });
          }
        }
      }
    } catch (err) {
      console.warn('loadRecordingCompanyContext failed (non-blocking):', err);
    }
  }
  async function handleStopRecording(windowId: string) {
    updateActiveMeeting(windowId, { state: 'stopping' });
    // Backstop the SDK confirmation: if no `recording:ended`/`recording:error`
    // arrives (SDK crashed, bridge stalled, event dropped) the row would hang
    // in `stopping` forever — force it to `error` once the watchdog fires.
    armStopWatchdog(windowId, (id) => {
      const row = activeMeetings.find((m) => m.windowId === id);
      const patch = resolveStopTimeout(row?.state);
      if (patch) updateActiveMeeting(id, patch);
    });
    try {
      await invoke('stop_recording', { windowId });
      // Flip to detected/closed on `recording:ended` event.
    } catch (err) {
      console.error('stop_recording failed:', err);
      // Roll back to recording — the bridge errored before the SDK got
      // the stop, so we're still recording. Cancel the watchdog so it
      // doesn't later flip this still-recording row to `error`.
      clearStopWatchdog(windowId);
      updateActiveMeeting(windowId, {
        state: 'recording',
        error: typeof err === 'string' ? err : String(err),
      });
    }
  }

  // White-label brand (US-005). Seeded from localStorage so offline launches
  // keep the last entitled branding; refreshed from workspaces memberships.
  let brand = $state<CachedBrand | null>(null);
  {
    const seed = readBrandCache();
    if (seed) {
      brand = seed;
      applyBrandToDocument(seed);
    }
  }

  // Updater state — populated by the `update:available` event from the Rust
  // background checker (launch+10s, then every 6h). Non-null means the user
  // is on an older version and the banner should be shown.
  // True while `invoke('install_update')` is in-flight — blocks duplicate
  // clicks and lets the button show a spinner. On macOS the process usually
  // terminates before the promise resolves, so this rarely flips back.
  let updateInstalling = $state(false);
  // If even the compact native-action Retry banner cannot be created, retain
  // the failed action here until the desktop window's retry succeeds.
  let notificationActionRecovery = $state<NativeNotificationRecovery | null>(
    null,
  );
  let notificationActionRetrying = $state(false);
  let notificationActionRecoveryGeneration = 0;

  /**
   * Broadcast the recovery record so the desktop window can render the retry
   * banner too (PL-03). This window is the only one that can execute a
   * notification action, so it stays the producer and the executor; the shell
   * only displays the record and asks for the retry on RETRY_EVENT.
   */
  $effect(() => {
    const payload = {
      recovery: notificationActionRecovery,
      retrying: notificationActionRetrying,
    };
    void emit(RECOVERY_EVENT, payload).catch((error) => {
      console.error('notification recovery broadcast failed', error);
    });
  });

  // The hq CLI updater, the pack updater and the unified hq-core state
  // (drift, version-behind, the Restore/Update pill) are all owned by the
  // desktop window — Settings → Updates and the titlebar Core popover. This
  // window neither stores nor renders any of them.

  // `listen()` and `onFocusChanged()` resolve asynchronously. The app surface
  // normally stays mounted for the process lifetime, but it can be torn down
  // during dev reloads or a fast window shutdown. `ListenerRegistry`
  // (./lib/listener-registry) keeps registration scoped to one mount so an
  // unlisten handle that resolves late is called immediately, and tears every
  // handle down through `safeUnlisten` so a stale/double teardown can't crash
  // the surface (Sentry HQ-DESKTOP-39).

  async function loadConfig() {
    try {
      config = await invoke<Config>('get_config');
    } catch (err) {
      console.error('Failed to load config:', err);
    }
  }

  interface ChannelsUnreadResponse {
    channels?: Channel[];
  }

  function applyChannelUnread(channelId: string, unread: number): void {
    if (!authenticated) return;
    unreadSummary = {
      ...unreadSummary,
      channelUnread: channelUnreadTracker.applyEvent(channelId, unread),
    };
  }

  function clearChannelUnreadRetry(): void {
    if (channelUnreadRetryTimer === null) return;
    clearTimeout(channelUnreadRetryTimer);
    channelUnreadRetryTimer = null;
  }

  function resetUnreadSummary(): void {
    clearChannelUnreadRetry();
    unreadSummaryTracker.reset();
    channelUnreadTracker.reset();
    unreadSummary = {
      unreadDms: 0,
      pendingRequests: 0,
      channelUnread: 0,
    };
  }

  function scheduleChannelUnreadRetry(): void {
    if (
      !authenticated ||
      channelUnreadDisposed ||
      channelUnreadTracker.hasCompleteSnapshot() ||
      channelUnreadRetryTimer !== null
    ) return;
    channelUnreadRetryTimer = setTimeout(() => {
      channelUnreadRetryTimer = null;
      if (authenticated && !channelUnreadDisposed) void loadChannelUnreadCount();
    }, CHANNEL_UNREAD_RETRY_MS);
  }

  async function loadChannelUnreadCount(): Promise<void> {
    if (!authenticated || channelUnreadDisposed) return;
    const snapshotToken = channelUnreadTracker.beginSnapshot();
    try {
      const response = await invoke<ChannelsUnreadResponse | null>('list_channels');
      if (!authenticated || channelUnreadDisposed) {
        channelUnreadTracker.abandonSnapshot(snapshotToken);
        return;
      }
      const channelUnread = channelUnreadTracker.commitSnapshot(
        snapshotToken,
        response?.channels ?? [],
      );
      if (channelUnread === null) {
        scheduleChannelUnreadRetry();
        return;
      }
      clearChannelUnreadRetry();
      unreadSummary = {
        ...unreadSummary,
        channelUnread,
      };
    } catch (err) {
      channelUnreadTracker.abandonSnapshot(snapshotToken);
      if (!authenticated || channelUnreadDisposed) return;
      // Channels are additive to the badge. Preserve the last-known aggregate
      // when their endpoint is temporarily unavailable.
      if (!isExpectedUnauthenticatedError(err)) {
        console.error('list_channels unread summary failed:', err);
      }
      scheduleChannelUnreadRetry();
    }
  }

  // Reconcile the menu-bar Messages count from the existing DM/request summary
  // and the existing channel list. There is still no independent poller:
  // startup, window focus, and the established realtime events drive refreshes.
  async function loadUnreadSummary() {
    if (!authenticated) {
      resetUnreadSummary();
      return;
    }
    const snapshot = unreadSummaryTracker.beginSnapshot();
    try {
      const s = await invoke<{ unreadDms: number; pendingRequests: number }>(
        'get_unread_summary',
      );
      if (!authenticated) return;
      const reconciled = unreadSummaryTracker.commitSnapshot(
        snapshot,
        {
          unreadDms: s.unreadDms ?? 0,
          pendingRequests: s.pendingRequests ?? 0,
        },
        unreadSummary,
      );
      if (reconciled === null) return;
      unreadSummary = {
        ...reconciled,
        channelUnread: unreadSummary.channelUnread,
      };
    } catch (err) {
      if (authenticated && !isExpectedUnauthenticatedError(err)) {
        console.error('get_unread_summary failed:', err);
      }
    }
    if (authenticated) await loadChannelUnreadCount();
  }

  // Unified "Update" action — dispatches to the right rescue command based
  /**
   * Re-derive the white-label brand from the workspaces union (Personal +
   * memberships + local folders). Called on mount, on window focus and after
   * a sync completes. The brand is applied to this window's document and
   * written to the shared localStorage cache the desktop window reads.
   */
  async function loadWorkspaces() {
    try {
      const result = await invoke<WorkspacesResult>('list_syncable_workspaces');
      // Brand rides the membership enrichment already on each workspace row —
      // no extra endpoint. Cloud-unreachable keeps the offline cache.
      const nextBrand = syncBrandFromWorkspaces(result.workspaces, {
        cloudReachable: result.cloudReachable,
      });
      brand = nextBrand;
      applyBrandToDocument(nextBrand);
      if (nextBrand) {
        void cacheLogoAssets(nextBrand).then((withAssets) => {
          brand = withAssets;
          applyBrandToDocument(withAssets);
        });
      }
    } catch (err) {
      // Hard failure (e.g. couldn't resolve hq_root).
      console.error('list_syncable_workspaces failed:', err);
      // Offline: keep cached branding if we have it.
      const cached = readBrandCache();
      brand = cached;
      applyBrandToDocument(cached);
    }
  }

  async function handleSyncNow() {
    if (syncState === 'syncing') return;
    syncState = 'syncing';
    manualSyncActive = true;
    manualSyncTelemetryPending = true;
    externalSyncActive = false;
    syncFanoutFilesSkipped = 0;
    await invoke('set_tray_state', { state: 'syncing' });
    try {
      await invoke('start_sync');
    } catch (err) {
      const msg = String(err);
      // A sync already holds the runner singleton (the watch daemon or a prior
      // run) — not a failure worth alarming the user with a red error. Reflect
      // it as syncing and let the active sync's events / cross-process file
      // resolve it back to idle.
      if (msg.toLowerCase().includes('already running')) {
        manualSyncActive = false;
        manualSyncTelemetryPending = false;
        externalSyncActive = true;
        syncState = 'syncing';
        await invoke('set_tray_state', { state: 'syncing' });
        return;
      }
      manualSyncTelemetryPending = false;
      console.error('start_sync failed:', err);
      syncState = 'error';
      await invoke('set_tray_state', { state: 'error' });
      void emitDesktopTelemetry({
        eventName: 'manual_sync_failed',
        properties: { errorKind: 'start_sync', errorCount: 1, surface: 'popover' },
      });
    }
  }


  async function handleSignOut() {
    // Invalidate every in-flight frontend snapshot before waiting on backend
    // token deletion, and ignore any late native events while signed out.
    authenticated = false;
    expiresAt = '';
    resetUnreadSummary();
    // Clear the persisted Cognito tokens (file + in-memory cache) in the backend
    // so the app doesn't silently re-authenticate on the next launch — a
    // frontend-only flag left the token file on disk. We reset the UI to the
    // sign-in screen regardless (the user asked to sign out), but a backend
    // failure is logged so a lingering token file stays diagnosable.
    try {
      await invoke('sign_out');
    } catch (err) {
      console.error('Sign out: failed to clear stored tokens', err);
    }
  }







  async function handleInstallUpdate(throwOnError = false) {
    if (updateInstalling) return;
    updateInstalling = true;
    try {
      // Backend re-runs updater.check() inside install_update because
      // tauri_plugin_updater::Update is not Clone — we can't stash the
      // Update object across IPC. See src-tauri/src/updater.rs:41-60.
      // On macOS the app process is typically replaced before this
      // promise resolves; updateInstalling stays true by design.
      await invoke('install_update');
    } catch (err) {
      console.error('install_update failed:', err);
      updateInstalling = false;
      // Ordinary callers swallow the failure — the desktop window's Settings →
      // Updates pane owns the visible install-error surface.
      // Custom notification actions request propagation so Rust can reject the
      // original banner_action IPC and leave the Retry affordance mounted.
      if (throwOnError) throw err;
    }
  }

  async function handleCheckForUpdates() {
    try {
      // Fire-and-forget: the backend emits `update:available` on a hit and
      // the desktop shell renders it. The tray menu item only needs the
      // check to run.
      await invoke('check_for_updates');
    } catch (err) {
      console.error('check_for_updates failed:', err);
    }
  }

  function buildSharedPrompt(evt: any): string {
    const paths = Array.isArray(evt?.paths) ? evt.paths.join(', ') : '';
    const note = typeof evt?.note === 'string' && evt.note.trim()
      ? evt.note.trim()
      : '(no note)';
    const sender =
      typeof evt?.issuerDisplayName === 'string' && evt.issuerDisplayName.trim()
        ? evt.issuerDisplayName.trim()
        : 'A teammate';
    return `${sender} shared these files with me: ${paths}\n\nTheir note: ${note}.`;
  }

  /**
   * Execute the real destination operation for both custom and native
   * notification actions. Unsupported or incomplete payloads reject instead
   * of being mistaken for success by the acknowledgement bridge.
   */
  async function executeNotificationAction(
    kind: NotificationActionKind,
    action: string,
    data: any,
  ): Promise<void> {
    if (kind === 'dm') {
      if (action === 'copy') {
        const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';
        if (!prompt) throw new Error('DM prompt is unavailable');
        await navigator.clipboard.writeText(prompt);
        return;
      }
      if (action === 'open') {
        if (!data) throw new Error('DM event is unavailable');
        await invoke('open_dm_detail', { event: data });
        return;
      }
    } else if (kind === 'share') {
      if (action === 'claude') {
        const folder = config?.hqFolderPath ?? '';
        const url = buildClaudeCodeUrl({
          folder,
          prompt: buildSharedPrompt(data),
        });
        await invoke('open_claude_code_link', { url });
        return;
      }
      if (action === 'copy') {
        const prompt = buildSharedPrompt(data);
        if (!Array.isArray(data?.paths) || data.paths.length === 0) {
          throw new Error('Shared paths are unavailable');
        }
        await navigator.clipboard.writeText(prompt);
        return;
      }
      if (action === 'open') {
        if (!data) throw new Error('Share event is unavailable');
        await invoke('open_share_detail', { events: [data] });
        return;
      }
    } else if (kind === 'update') {
      if (action === 'update') {
        await invoke('show_main_window');
        await handleInstallUpdate(true);
        return;
      }
      if (action === 'open') {
        await invoke('show_main_window');
        return;
      }
    } else if (kind === 'meeting') {
      const windowId = typeof data?.windowId === 'string' ? data.windowId : '';
      const meetingId = typeof data?.meetingId === 'string' ? data.meetingId : '';
      if (action === 'record' && windowId) {
        await handleStartRecording(windowId, true);
        void invoke('meetings_clear_prompt_badge').catch(() => {});
        return;
      }
      if (action === 'assign' && meetingId) {
        await invoke('open_meetings_window', { focusMeetingId: meetingId });
        void invoke('meetings_clear_prompt_badge').catch(() => {});
        return;
      }
      if (action === 'open') {
        await invoke('show_main_window');
        void invoke('meetings_clear_prompt_badge').catch(() => {});
        return;
      }
    }

    throw new Error('Unsupported notification action');
  }

  /**
   * Native macOS notification actions do not have a mounted row to preserve.
   * On failure, raise the same custom banner with a safe Retry action so the
   * user sees recovery rather than a console-only error.
   */
  async function showNativeNotificationRetry(
    kind: 'dm' | 'share',
    action: string,
    data: any,
  ): Promise<void> {
    const recovery = await surfaceNativeNotificationRetry(
      { kind, action, data },
      {
        showRetryBanner: ({ kind, action, data }) =>
          invoke('show_action_retry_banner', { kind, action, data }),
        showMainWindow: () => invoke('show_main_window'),
        onError: (message, error) => console.error(message, error),
      },
    );
    if (recovery) {
      notificationActionRecoveryGeneration += 1;
      notificationActionRecovery = recovery;
    }
  }

  async function handleRetryNotificationAction(): Promise<void> {
    if (!notificationActionRecovery || notificationActionRetrying) return;
    const recovery = notificationActionRecovery;
    const recoveryGeneration = notificationActionRecoveryGeneration;
    notificationActionRetrying = true;
    try {
      await executeNotificationAction(
        recovery.kind,
        recovery.action,
        recovery.data,
      );
      if (notificationActionRecoveryGeneration === recoveryGeneration) {
        notificationActionRecovery = null;
      }
    } catch (error) {
      console.error('notification in-app retry failed', error);
    } finally {
      notificationActionRetrying = false;
    }
  }

  async function setupTrayListeners(unlisteners: ListenerRegistry) {
    // Refresh the workspaces read every time this window gains focus (it is
    // shown for onboarding and sign-in). Cheap — a single Tauri command plus a
    // small vault round-trip — and it catches external mutations: a company
    // added via /newcompany, a manifest patch from a CLI tool, or a folder
    // created outside the app. The white-label brand cache it writes is what
    // the desktop window reads.
    unlisteners.push(
      await subscribeWindowFocus(getCurrentWindow(), ({ payload: focused }) => {
        if (focused) {
          // Fire-and-forget: re-pull the workspace list so the white-label
          // brand cache this window writes stays current for the desktop
          // window that reads it.
          loadWorkspaces();
          if (authenticated) void loadUnreadSummary();
          if (shouldRecheckAuthOnFocus(focused, authenticated)) void checkAuth();
        }
      })
    );

    // Tray menu events
    unlisteners.push(
      await listen('tray:sync-now', () => {
        handleSyncNow();
      })
    );

    // Exact channel unread snapshots include increases and read/decrement
    // transitions, so the aggregate and native menu-bar count cannot stick.
    unlisteners.push(
      await listen<{ channelId: string; unread: number }>(
        'channel:unread-changed',
        (e) => {
          applyChannelUnread(e.payload.channelId, e.payload.unread);
        },
      ),
    );

    unlisteners.push(
      await listen<Channel>('channel:updated', (e) => {
        if (typeof e.payload.unread === 'number') {
          applyChannelUnread(e.payload.channelId, e.payload.unread);
        } else {
          void loadChannelUnreadCount();
        }
      }),
    );

    unlisteners.push(
      await listen('tray:replay-intro', () => {
        // The backend already brought `main` forward (and hid the desktop
        // window) before emitting — `show_main_window` opens the DESKTOP
        // window despite its name, so invoking it here is what used to send
        // the film to a window nobody could see.
        replayIntro = true;
      })
    );

    unlisteners.push(
      await listen('tray:open-settings', () => {
        void invoke('open_desktop_alt_window', { route: 'settings' }).catch((e) => {
          console.error('tray open_desktop_alt_window (settings) failed:', e);
          // Real open failure: keep first-run onboarding / sign-in reachable.
          void invoke('show_main_window').catch(console.error);
        });
      })
    );

    // Native tray right-click menu (hq-tray-helper): Open desktop view +
    // Sign Out. Signed-out users still get the workspace window so they can
    // sign in there.
    unlisteners.push(
      await listen('tray:open-desktop', () => {
        void invoke('open_desktop_alt_window').catch((e) => {
          console.error('tray open_desktop_alt_window failed:', e);
          // Real open failure: keep first-run onboarding / sign-in reachable.
          void invoke('show_main_window').catch(console.error);
        });
      })
    );

    unlisteners.push(
      await listen('tray:sign-out', () => {
        void handleSignOut();
      })
    );

    // --- Phase 7 runner event listeners ---
    // Protocol (see src-tauri/src/events.rs):
    //   sync:setup-needed  -- signed in, no person entity yet
    //   sync:auth-error    -- token invalid and can't refresh
    //   sync:fanout-plan   -- list of companies about to sync
    //   sync:progress      -- per-file download in-flight
    //   sync:error         -- per-file or per-company error
    //   sync:complete      -- per-company summary (fires N times in a fanout)
    //   sync:all-complete  -- aggregate summary; this is the real "done"

    unlisteners.push(
      await listen('sync:setup-needed', async () => {
        // Runner emits this when the caller has no memberships AND no
        // pending invites. As of the Rust auto-create patch, the personal
        // first-push provisions the person entity itself before the runner
        // even starts — so by the time we see setup-needed here, the only
        // remaining gap is "no companies yet", which is a perfectly normal
        // state for a brand-new account, not an error. Don't flip the tray
        // to red; just stay in syncing until all-complete fires.
        syncState = 'syncing';
      })
    );

    unlisteners.push(
      await listen<{ message: string }>('sync:auth-error', async (event) => {
        syncState = 'auth-error';
        manualSyncActive = false;
        externalSyncActive = false;
        // The runner cannot recover from a failed refresh. Route directly to
        // the sign-in screen instead of leaving an expired session in
        // place, even though the runner exits with code 0.
        authenticated = false;
        expiresAt = '';
        resetUnreadSummary();
        await invoke('set_tray_state', { state: 'reauth' });
      })
    );

    // The desktop window shows the same recovery banner; its Retry asks this
    // window to re-run the action, because the action routing lives here.
    unlisteners.push(
      await listen(RETRY_EVENT, async () => {
        await handleRetryNotificationAction();
      })
    );

    unlisteners.push(
      await listen('auth:reauth-required', async () => {
        syncState = 'auth-error';
        authenticated = false;
        expiresAt = '';
        resetUnreadSummary();
        await invoke('set_tray_state', { state: 'reauth' });
      })
    );

    // `sync:totals` and `sync:plan` carry progress denominators for a
    // progress surface. This window no longer paints one — the desktop shell
    // reads sync progress through `get_sync_status` — so neither is consumed
    // here.

    unlisteners.push(
      await listen<{ companies: Array<{ uid: string; slug: string; name?: string }> }>(
        'sync:fanout-plan',
        async (event) => {
          syncState = 'syncing';
          await invoke('set_tray_state', { state: 'syncing' });
        }
      )
    );

    unlisteners.push(
      await listen<{ company: string; path: string; bytes: number; message?: string }>(
        'sync:progress',
        async (event) => {
          syncState = 'syncing';
          // Cumulative transfer counter — the runner emits sync:progress
          // only for files it actually moves, so each event counts as one.
          // (Counting policy lives in lib/transfer-count.ts.)
          await invoke('set_tray_state', { state: 'syncing' });
        }
      )
    );

    // Cross-process progress — any sync the menubar did NOT spawn (the
    // auto-sync watch daemon, a CLI `hq sync`) writes ~/.hq/sync-progress.json,
    // surfaced by the Rust file-watcher as sync:external-progress. Drive the
    // same progress card — but never while a manual Sync Now owns it (its
    // stdout stream is richer + fanout-aware).
    unlisteners.push(
      await listen<{
        company: string | null;
        phase: string;
        filesTotal: number;
        filesDone: number;
        conflicts: number;
        currentFile: string | null;
      }>('sync:external-progress', async (event) => {
        if (manualSyncActive) return;
        externalSyncActive = true;
        syncState = 'syncing';
        const p = event.payload;
        await invoke('set_tray_state', { state: 'syncing' });
      })
    );

    unlisteners.push(
      await listen('sync:external-idle', async () => {
        if (!externalSyncActive) return;
        externalSyncActive = false;
        syncState = 'idle';
        await invoke('set_tray_state', { state: 'idle' });
      })
    );

    // ── Personal-first-push events ────────────────────────────────────────
    // The in-process Rust personal first-push runs in two phases. Scan:
    // hash every personal-vault file against the journal to build the
    // upload plan. Upload: push exactly that plan. Each phase has its own
    // event so the caption denominator is the CHANGED count, not the walk
    // size — feeding walk totals into the caption made a 1-file delta read
    // "x of 2,877 files".

    // Personal first-push phases. The per-file counters they used to feed
    // belonged to the tray popover's progress card; all that is left for this
    // window is keeping the tray in its syncing state while the push runs.
    // `sync:personal-first-push-complete` carries nothing this window acts on.
    unlisteners.push(
      await listen('sync:personal-first-push-scan', () => {
        syncState = 'syncing';
      })
    );
    unlisteners.push(
      await listen('sync:personal-first-push-progress', async () => {
        syncState = 'syncing';
        await invoke('set_tray_state', { state: 'syncing' });
      })
    );

    unlisteners.push(
      await listen<{
        company: string;
        filesDownloaded: number;
        bytesDownloaded: number;
        filesSkipped: number;
        conflicts: number;
        aborted: boolean;
      }>('sync:complete', async (event) => {
        // Per-company event — just tick the counter. Don't go idle yet;
        // wait for sync:all-complete to know the whole fanout is done.
        // We do NOT add filesSkipped to syncFilesProgressed: the runner
        // only emits per-file `progress` events for transfers, not skips,
        // and the new pre-walk denominator counts only transfers too.
        // Adding skips here would inflate the numerator and break the
        // ratio.
        syncFanoutFilesSkipped += event.payload.filesSkipped;
        if (event.payload.aborted) {
          // Conflict-aborted. The tray goes to its conflict state; the
          // actionable resolve surface (count, company, Copy prompt,
          // Open in Claude Code) is the desktop window's Core popover,
          // which reads the same aggregate from `get_sync_status`.
          syncState = 'conflict';
          await invoke('set_tray_state', { state: 'conflict' });
        }
      })
    );

    unlisteners.push(
      await listen<{
        companiesAttempted: number;
        filesDownloaded: number;
        bytesDownloaded: number;
        errors: Array<{ company: string; message: string }>;
      }>('sync:all-complete', async (event) => {
        const shouldEmitManualSync = manualSyncTelemetryPending;
        manualSyncTelemetryPending = false;
        manualSyncActive = false;
        externalSyncActive = false;
        // Only flip to idle if nothing raised conflict/error mid-stream
        if (syncState !== 'conflict' && syncState !== 'error') {
          syncState = 'idle';
          await invoke('set_tray_state', { state: 'idle' });
        }
        // Refresh SyncStats so "last synced" updates immediately
        syncStatsRefresh?.();
        // Refresh workspaces — sync may have created new local folders
        // (for newly-provisioned companies) or updated last-synced timestamps.
        loadWorkspaces();
        if (shouldEmitManualSync) {
          void emitDesktopTelemetry({
            eventName:
              event.payload.errors.length > 0
                ? 'manual_sync_failed'
                : 'manual_sync_completed',
            properties: {
              surface: 'popover',
              companiesAttempted: event.payload.companiesAttempted,
              filesDownloaded: event.payload.filesDownloaded,
              bytesDownloaded: event.payload.bytesDownloaded,
              filesSkipped: syncFanoutFilesSkipped,
              errorCount: event.payload.errors.length,
            },
          });
        }
      })
    );

    unlisteners.push(
      await listen<{ company?: string; path: string; message: string }>(
        'sync:error',
        async (event) => {
          const shouldEmitManualSync = manualSyncTelemetryPending;
          manualSyncTelemetryPending = false;
          // Native owns terminal runner telemetry, including its structured
          // exit/signal fingerprint and stderr breadcrumbs. This renderer
          // event is UI-only: capturing here too created a second Sentry event
          // for the same supervisor failure in a different project.
          manualSyncActive = false;
          externalSyncActive = false;
          syncState = 'error';
          await invoke('set_tray_state', { state: 'error' });
          if (shouldEmitManualSync) {
            void emitDesktopTelemetry({
              eventName: 'manual_sync_failed',
              properties: { errorKind: 'sync_error', errorCount: 1, surface: 'popover' },
            });
          }
        }
      )
    );

    // --- Updater event listener ---
    // `update:available` is consumed by the desktop shell (the Settings →
    // Updates pane and the recommended-update banner); this window only needs
    // to know when a pending update is cleared so a stalled in-flight install
    // flag can't stick.
    unlisteners.push(
      await listen('update:cleared', () => {
        updateInstalling = false;
      })
    );

    // The hq CLI updater, pack updater and hq-core state events are consumed
    // by the desktop shell (Settings → Updates and the titlebar Core popover).
    // This window neither renders nor forwards them.

    // Tray menu "Check for Updates" → on-demand check.
    unlisteners.push(
      await listen('tray:check-for-updates', () => {
        handleCheckForUpdates();
      })
    );

    // --- Meeting-detection listener ---
    // Fired by the Recall Desktop SDK sidecar when a supported video-call app
    // becomes active. The dedup + surface decision lives in
    // `handleMeetingDetected` (src/lib/meetingDetection.ts) so it can be
    // unit-tested without Tauri IPC; this wrapper only binds the Tauri
    // `invoke` + active-meeting store collaborators to it.
    //
    // The rule it enforces: a meeting already covered by an active hq-pro bot
    // (a scheduled calendar bot, or one already in the call) surfaces NEITHER
    // a recordable MeetingsWindow row NOR a macOS notification — the bot is handling
    // it. Everything else (no bot, synthetic/URL-less detection, or a failed
    // bot check) surfaces both.
    unlisteners.push(
      await listen<MeetingDetectedPayload>('meeting:detected', async (event) => {
        try {
          await handleMeetingDetected(event.payload, {
            checkActiveBot: async (meetingUrl, eventId) => {
              const bot = await invoke<{ botId: string } | null>(
                'meetings_check_bot_for_url',
                { meetingUrl, eventId },
              );
              return !!bot;
            },
            upsertRow: (seed) => upsertActiveMeeting(seed),
            removeRow: (windowId) => removeActiveMeeting(windowId),
            notify: async (payload) => {
              await invoke('meetings_notify_detected', { payload });
            },
            resolveValidDefault,
            now: () => new Date().toISOString(),
            warn: (msg, err) => console.warn(msg, err),
          });
        } catch (err) {
          console.error('meeting:detected handler error:', err);
        }
      }),
    );

    // Recording lifecycle — flip the active-meeting row state machine as
    // the bridge confirms each transition. The Tauri commands above
    // (handleStart/StopRecording) only know "we asked the bridge to do
    // this"; these events confirm the SDK accepted it. We keep the row
    // in `starting` / `stopping` until the SDK confirms, then flip to
    // `recording` / removed.
    unlisteners.push(
      await listen<{ windowId: string; platform: string; startedAt: string }>(
        'recording:started',
        (event) => {
          recordingActionAcks.started(event.payload.windowId);
          clearStopWatchdog(event.payload.windowId);
          updateActiveMeeting(event.payload.windowId, {
            state: 'recording',
            error: undefined,
          });
        },
      ),
    );
    unlisteners.push(
      await listen<{ windowId: string; platform: string; endedAt: string }>(
        'recording:ended',
        (event) => {
          recordingActionAcks.failed(
            event.payload.windowId,
            'Recording ended before startup confirmation.',
          );
          clearStopWatchdog(event.payload.windowId);
          // Recording over — drop the row. (Future: keep the row for a
          // few seconds showing "Saved" so the user gets confirmation
          // before it disappears.)
          removeActiveMeeting(event.payload.windowId);
        },
      ),
    );
    unlisteners.push(
      await listen<{ cmd: string; windowId: string; message: string }>(
        'recording:error',
        (event) => {
          const message = `${event.payload.cmd}: ${event.payload.message}`;
          recordingActionAcks.failed(event.payload.windowId, message);
          clearStopWatchdog(event.payload.windowId);
          updateActiveMeeting(event.payload.windowId, {
            state: 'error',
            error: message,
          });
        },
      ),
    );
    unlisteners.push(
      await listen<{ windowId: string; platform: string; closedAt: string }>(
        'meeting:closed',
        (event) => {
          const { windowId } = event.payload;
          recordingActionAcks.failed(
            windowId,
            'Meeting closed before recording startup confirmation.',
          );
          // The call ended (host ended it / everyone left) — the SDK's only
          // call-ended signal. Defense-in-depth: if the bridge's auto-stop was
          // missed and this row is still recording (or mid start/stop),
          // finalize it through the normal stop path instead of silently
          // dropping the row and leaking a still-running recording.
          // `handleStopRecording` owns the watchdog, so don't pre-clear here.
          const row = activeMeetings.find((m) => m.windowId === windowId);
          if (
            row &&
            (row.state === 'recording' ||
              row.state === 'starting' ||
              row.state === 'stopping')
          ) {
            void handleStopRecording(windowId);
            return;
          }
          // User closed the meeting app without recording — drop the row
          // so MeetingsWindow doesn't show stale detections.
          clearStopWatchdog(windowId);
          removeActiveMeeting(windowId);
        },
      ),
    );

    // --- Cross-window bridge to MeetingsWindow ---
    // The Detected/Record row used to live inside the tray popover. As of
    // 2026-05-30 it moved to MeetingsWindow's top strip; the event names below
    // keep their historical `popover:` prefix because MeetingsWindow listens
    // for them by name. MeetingsWindow runs in a separate
    // webview, so we ship the snapshot + dispatch actions over Tauri
    // custom events instead of via props.
    //
    // Three event channels:
    //   popover:meetings-snapshot           ← App.svelte → MeetingsWindow
    //     Whole snapshot {activeMeetings, memberships, defaultRecordingCompanyUid}.
    //     Re-broadcast on every $effect tick when any of those mutate.
    //   meetings-window:request-snapshot    ← MeetingsWindow → App.svelte
    //     Fired on MeetingsWindow mount so it gets an immediate seed
    //     without having to wait for the next mutation.
    //   meetings-window:action              ← MeetingsWindow → App.svelte
    //     Dispatch for Record / Stop / company-change. The handler maps
    //     each to its existing local handler so the bridge doesn't
    //     duplicate company-resolution / state-machine logic.
    unlisteners.push(
      await listen('meetings-window:request-snapshot', () => {
        // Best-effort emit — `emit` returns a Promise but we don't await
        // (the request is fire-and-forget UX).
        emit('popover:meetings-snapshot', {
          activeMeetings,
          memberships,
          defaultRecordingCompanyUid,
        }).catch((err) => {
          console.warn('meetings-snapshot re-emit failed', err);
        });
      }),
    );
    unlisteners.push(
      await listen<{
        action: 'start' | 'stop' | 'change-company';
        windowId: string;
        companyUid?: string | null;
      }>('meetings-window:action', (event) => {
        const { action, windowId, companyUid } = event.payload;
        if (action === 'start') {
          void handleStartRecording(windowId);
        } else if (action === 'stop') {
          void handleStopRecording(windowId);
        } else if (action === 'change-company') {
          handleChangeRecordingCompany(windowId, companyUid ?? null);
        }
      }),
    );

    // Notification action dispatch — fired by the Rust mac-notification-sys
    // worker thread when the user interacts with a "Meeting detected"
    // notification. Two cases:
    //   action="open"   → user clicked the notification body. Open the
    //                     desktop window so the meeting is reachable.
    //   action="record" → user clicked the Record action button. Skip the
    //                     window and start recording directly.
    unlisteners.push(
      await listen<{ action: string; windowId: string; platform: string; meetingId?: string }>(
        'notification:meeting-action',
        async (event) => {
          const { action, windowId, meetingId } = event.payload;
          if (action === 'record' && windowId) {
            await handleStartRecording(windowId);
            // Clear the prompt-tray badge — the user acted on the
            // detection, even if the recording itself errors.
            invoke('meetings_clear_prompt_badge').catch(() => {});
            return;
          }
          if (action === 'assign' && meetingId) {
            invoke('open_meetings_window', { focusMeetingId: meetingId }).catch((err) => {
              console.warn('open_meetings_window failed:', err);
            });
            invoke('meetings_clear_prompt_badge').catch(() => {});
            return;
          }
          if (action === 'open') {
            // `show_main_window` opens and focuses the desktop window
            // (PL-05 retargeted it there); the tray window is no longer a
            // surface a signed-in person is shown.
            invoke('show_main_window').catch((err) => {
              console.warn('show_main_window failed:', err);
            });
            invoke('meetings_clear_prompt_badge').catch(() => {});
          }
        },
      ),
    );

    // --- Share-notification event listener (US-005) ---
    // Rust emits `share:new-events` after each poll when new events are found.
    // The Rust side has already fired one macOS notification per event AND
    // primed the pending-events state for the detail-window ready-handshake.
    //
    // We deliberately do NOT open the ShareDetail window here. The window
    // opens only via user-initiated paths:
    //   1. notification click → `share-notify:detail-requested` listener
    //   2. notification action button "Open details" → same path
    //   3. tray click on the share-notify badge
    //
    // Auto-opening on every poll was a UX bug discovered during dogfood
    // (2026-05-26): combined with the cursor re-fire bug, the ShareDetail
    // window re-appeared every ~20s. Even with the cursor bug fixed, eager
    // open is wrong UX — the notification is the lightweight surface and
    // the detail window is opt-in.
    unlisteners.push(
      await listen<Array<{
        eventId: string;
        issuerEmail: string;
        issuerDisplayName: string;
        paths: string[];
        note: string | null;
        permission: string;
        createdAt: string;
      }>>('share:new-events', async (_event) => {
        // No-op for now — the notification handler in Rust owns the side
        // effects (notification.show(), pending-events state, tray badge).
        // This listener stays subscribed so a future in-window share-
        // events list can hook here without needing a second registration.
      })
    );

    // --- Share-notification action handler (Fix D, 2026-05-26) ---
    // Rust spawns a thread per macOS notification that blocks on
    // mac-notification-sys `wait_for_click(true).send()`. When the user
    // hovers the notification and picks "Copy prompt" / "Open details"
    // from the Actions dropdown (or body-clicks for the open path), the
    // thread emits `notification:share-action` with the full event payload.
    //
    // "copy" → write the templated prompt to the system clipboard.
    // "open" → invoke open_share_detail with this single event so the
    //          ShareDetail window focuses or opens with the right context.
    unlisteners.push(
      await listen<{
        action: 'claude' | 'copy' | 'open';
        eventId: string;
        event: {
          eventId: string;
          issuerEmail: string;
          issuerDisplayName: string;
          paths: string[];
          note: string | null;
          permission: string;
          createdAt: string;
        };
      }>('notification:share-action', async (e) => {
        const { action, event: evt } = e.payload;
        try {
          await executeNotificationAction('share', action, evt);
        } catch (err) {
          console.error('share notification action failed', err);
          await showNativeNotificationRetry('share', action, evt);
        }
      })
    );

    // --- DM-notification action handler (rich DMs, 2026-05-29) ---
    // DMs are receive-only (no reply/send surface). Plain DMs are fire-and-
    // forget. A DM that carries agent context (`prompt`) and/or `details`
    // gets an "Actions" dropdown; on action the Rust thread emits
    // `notification:dm-action`:
    //   "copy" → write the sender's agent prompt to the clipboard so the
    //            recipient can paste it straight into their own agent session.
    //   "open" → open the DM detail window (full message + details + Copy).
    unlisteners.push(
      await listen<{
        action: 'copy' | 'open';
        event: {
          eventId: string;
          fromPersonUid: string;
          fromEmail: string;
          fromDisplayName: string;
          body: string;
          details?: string | null;
          prompt?: string | null;
          createdAt: string;
        };
      }>('notification:dm-action', async (e) => {
        const { action, event: dm } = e.payload;
        try {
          await executeNotificationAction('dm', action, dm);
        } catch (err) {
          console.error('DM notification action failed', err);
          await showNativeNotificationRetry('dm', action, dm);
        }
      })
    );

    // --- Messages unread-summary listener (US-009) ---
    // The single DM poll path emits `dm:unread-summary` whenever the unread
    // count changes (a new DM landed, or the badge was reset). It carries the
    // DM count immediately; the pending-request count is reconciled on the next
    // explicit `get_unread_summary` read. Keep both fields current so the
    // menu-bar Messages badge stays live without its own poller.
    unlisteners.push(
      await listen<{ unreadDms: number; pendingRequests: number }>(
        'dm:unread-summary',
        (e) => {
          if (!authenticated) return;
          unreadSummaryTracker.noteDmEvent();
          unreadSummary = {
            unreadDms: e.payload.unreadDms ?? 0,
            // Preserve the last-known request count when the event omits it
            // (the poll path emits 0 for requests by design).
            pendingRequests:
              e.payload.pendingRequests || unreadSummary.pendingRequests,
            channelUnread: unreadSummary.channelUnread,
          };
        }
      )
    );

    // --- Incoming connection-request listeners (US-011) ---
    // The SINGLE DM poll path diffs the pending-requests list each cycle and
    // emits `dm:request-new` for a brand-new incoming request and
    // `dm:request-update` when a pending request leaves the set (accepted /
    // declined / blocked — or flipped from the Requests window via
    // respond_dm_request). These keep the Messages request-count accent
    // (`unreadSummary.pendingRequests`) live and surface a DISTINCT native banner
    // ("{name} wants to connect") — separate copy from a normal incoming DM.
    unlisteners.push(
      await listen<DmRequest>('dm:request-new', async (e) => {
        if (!authenticated) return;
        const authEpoch = unreadSummaryTracker.captureAuthEpoch();
        unreadSummaryTracker.noteRequestEvent();
        // Bump the request-count accent immediately (the poll path emits
        // 0 for requests on dm:unread-summary by design). This must happen
        // before contact enrichment awaits, otherwise a concurrent summary can
        // include the request and the later increment double-counts it.
        unreadSummary = {
          unreadDms: unreadSummary.unreadDms,
          pendingRequests: unreadSummary.pendingRequests + 1,
          channelUnread: unreadSummary.channelUnread,
        };
        const req = await enrichIncomingRequest(e.payload);
        if (
          !authenticated ||
          !unreadSummaryTracker.isAuthEpochCurrent(authEpoch)
        ) return;

        // Distinct native banner — "{name} wants to connect" — so a connection
        // request is visually different from a normal DM banner. Best-effort:
        // never throw if notifications are denied/unavailable.
        try {
          if (await isNotifyPermissionGranted()) {
            sendNotification({
              title: requestBannerTitle(req),
              body: requestBannerBody(req),
            });
          }
        } catch (err) {
          console.error('dm-request: banner failed', err);
        }
      })
    );

    unlisteners.push(
      await listen<{ pairKey: string; state?: string; withPersonUid?: string }>(
        'dm:request-update',
        (e) => {
          if (!authenticated) return;
          unreadSummaryTracker.noteRequestEvent();
          // A pending request resolved (accepted / declined / blocked / pruned).
          // Decrement the request-count accent (never below zero). The
          // optimistic Pending→active bubble flip and the Requests-list prune
          // live in the Messages window (MessagesShell), which listens for this
          // same event; here we only keep the accent honest.
          unreadSummary = {
            unreadDms: unreadSummary.unreadDms,
            pendingRequests: Math.max(0, unreadSummary.pendingRequests - 1),
            channelUnread: unreadSummary.channelUnread,
          };
          void e;
        }
      )
    );

  }

  // Install the critical ACK route independently and before the broad tray
  // listener bundle. Rust accepts banner actions only after this listener has
  // completed its explicit readiness handshake.
  $effect(() => {
    const router = new BannerActionRouter({
      listen: (event, handler) => listen<BannerActionEvent>(event, handler),
      invoke: (command, args) => invoke(command, args),
      execute: ({ kind, action, data }) =>
        executeNotificationAction(kind, action, data),
      onError: (message, error) => console.error(message, error),
    });
    void router.start();
    return () => {
      void router.dispose();
    };
  });

  $effect(() => {
    // Performance: mark app init
    performance.mark('app-init');
    channelUnreadDisposed = false;

    checkAuth();
    loadConfig();
    loadWorkspaces();
    const listenerRegistry = new ListenerRegistry();
    void setupTrayListeners(listenerRegistry).catch((err) => {
      // A failed registration must not turn into an unhandled rejection.
      console.error('setup tray listeners failed:', err);
    });
    // Resolve the Phase-0 meeting-detect eligibility flag once on mount.
    // Desktop SettingsPage gates the meeting-detect toggle when this is false.
    // (Per-permission TCC status tracking was removed 2026-05-25 — see
    // permissionState.svelte.ts for why; native macOS prompts are
    // sufficient.)
    loadMeetingDetectEligible();
    // NOTE: We intentionally do NOT request OS notification permission on
    // launch. Like the meeting permissions, asking is now exclusively a
    // user-initiated action from Settings (the "Enable notifications" button →
    // `handleEnableNotifications`). Prompting on open is what this change
    // removed — the app must open clean with no permission dialogs.
    // Fire-and-forget: gate is a process-lifetime cache on the Rust side,
    // so subsequent reads are O(1). Errors silently treated as not-enabled.
    invoke<boolean>('meetings_feature_enabled')
      .then((v) => {
        meetingsEnabled = v;
        // Lazy-load the recording-company picker data only for users who
        // can actually trigger a detection. Saves a vault round-trip for
        // non-eligible accounts and keeps the cold-start trace cleaner.
        if (v) {
          void loadRecordingCompanyContext();
        }
      })
      .catch(() => {
        meetingsEnabled = false;
      });

    return () => {
      channelUnreadDisposed = true;
      clearChannelUnreadRetry();
      recordingActionAcks.dispose();
      listenerRegistry.dispose();
    };
  });

  // Broadcast the active-meetings snapshot to MeetingsWindow whenever the
  // pieces it renders mutate. Tauri `emit` fans out to every webview
  // (this window ignores its own emit by virtue of not subscribing).
  // The snapshot is shaped to match
  // what MeetingsWindow renders 1:1 so the receiver is a dumb consumer.
  //
  // Don't depend on the receiver being mounted — `emit` is best-effort
  // and lost emits while MeetingsWindow is closed are recovered the
  // next time it mounts via `meetings-window:request-snapshot`.
  $effect(() => {
    if (!meetingsEnabled) return;
    emit('popover:meetings-snapshot', {
      activeMeetings,
      memberships,
      defaultRecordingCompanyUid,
    }).catch((err) => {
      console.warn('meetings-snapshot emit failed', err);
    });
  });

  // Notification authorization is no longer requested on launch — it is a
  // user-initiated action from Settings ("Enable notifications" →
  // `handleEnableNotifications` in desktop SettingsPage).
  //
  // macOS caveat that still applies wherever we DO request it: calling
  // `requestAuthorizationWithOptions` registers the process as a
  // UNUserNotificationCenter "modern" client, after which usernoted rejects
  // NSUserNotification deliveries from the same process ("Legacy client …
  // connecting to modern client"). Our meeting-detect path goes through
  // `mac-notification-sys` (0.6), still on NSUserNotification, so the
  // Settings request should stay gated to the not-yet-determined state. The
  // meeting-detect handler also falls back to `osascript display
  // notification` when a legacy deliver is denied (see commands/meetings.rs).
  // Long-term fix: migrate the notify paths to UNUserNotificationCenter via
  // objc2 so the whole app is a modern client.

  async function checkAuth() {
    try {
      // `get_auth_state` validates freshness and performs the one silent
      // refresh retry. Raw token-file presence must not override a failed
      // verdict; it is captured first only to select the friendly reauth copy
      // after validation clears an expired session.
      lifecycleState = await invoke<string>('get_lifecycle_state').catch(() => null);
      const hadStoredToken = await invoke<boolean>('has_stored_token');
      const state = await invoke<{
        authenticated: boolean;
        expiresAt: string | null;
      }>('get_auth_state');

      authenticated = shouldSkipSignIn(state);
      expiresAt = state.expiresAt ?? '';
      if (hadStoredToken && !state.authenticated) {
        syncState = 'auth-error';
        await invoke('set_tray_state', { state: 'reauth' });
      }
    } catch {
      authenticated = false;
    } finally {
      checking = false;
    }
    if (authenticated) void loadUnreadSummary();
    else resetUnreadSummary();
    // US-005: once signed in and NOT in first-run onboarding, ask the server
    // whether this person's recorded consent is stale and should be re-asked.
    // Non-blocking and fail-quiet — the window renders immediately; if a
    // re-prompt is due it swaps in on the next tick.
    if (authenticated && !isOnboardingState(lifecycleState)) {
      void checkConsentReprompt();
    }
    // Already-onboarded machines never re-enter the mesh onboarding stage, so
    // ensure the Work Mesh Live daemon on SteadyState launch (fail-quiet).
    if (lifecycleState === 'SteadyState') {
      void invoke('ensure_work_mesh_daemon').catch(() => {});
    }
  }

  /**
   * US-005: query the server-authoritative re-prompt decision and, if due,
   * arm the blocking consent step. Fail-quiet: any error (unreachable server,
   * no token) leaves `consentReprompt` null so the app is never blocked, and we
   * simply try again on the next launch.
   */
  async function checkConsentReprompt() {
    try {
      const status = await invoke<{ shouldReprompt: boolean; personUid: string | null }>(
        'consent_reprompt_status',
        { consentVersion: TELEMETRY_CONSENT_VERSION },
      );
      if (status.shouldReprompt && status.personUid) {
        // Finding #8: write the "shown once" guard the moment the prompt is
        // DISPLAYED, not only after the person answers or dismisses. Otherwise
        // closing or crashing after it appears re-shows it next launch. The
        // guard write is awaited BEFORE arming, and a write FAILURE must not
        // silently cause a repeat: if it did not persist, we do not display the
        // prompt this launch (we simply try again next launch, where the guard
        // write can be retried) rather than showing an unguarded prompt that
        // would nag every launch.
        const persisted = await markConsentRepromptShown(
          TELEMETRY_CONSENT_VERSION,
          status.personUid,
        );
        if (!persisted) {
          console.warn(
            'consent reprompt guard did not persist; deferring the prompt to a later launch',
          );
          return;
        }
        consentReprompt = { personUid: status.personUid };
      }
    } catch (err) {
      console.warn('consent reprompt check failed (non-fatal):', err);
    }
  }

  async function handleConsentRepromptFinish() {
    // The person answered or dismissed; the guard is persisted server/local-side.
    // Return to the normal surface and refresh consent-dependent state.
    consentReprompt = null;
  }

  async function handleOnboardingFinish() {
    lifecycleState = null;
    await checkAuth();
    lifecycleState = null;
  }

  async function handleAuthSuccess(auth: { authenticated: boolean; expiresAt: string }) {
    const shouldResumeSync = syncState === 'auth-error';
    resetUnreadSummary();
    authenticated = auth.authenticated;
    expiresAt = auth.expiresAt;
    syncState = 'idle';
    await invoke('set_tray_state', { state: 'idle' });
    void loadUnreadSummary();
    if (shouldResumeSync) {
      await handleSyncNow();
    }
    if (auth.authenticated) {
      void invoke('open_desktop_alt_window').catch((e) => {
        console.error('open_desktop_alt_window after sign-in failed:', e);
      });
    }
  }
</script>

<main>
  {#if checking}
    <div class="loading">
      <span class="dot-spinner"></span>
    </div>
  {:else if replayIntro}
    <Onboarding
      state="SteadyState"
      mode="replay"
      onfinish={() => {
        replayIntro = false;
        // Hand the person back to whatever was on screen before the film.
        void invoke('finish_replay_intro').catch(console.error);
      }}
    />
  {:else if isOnboardingState(lifecycleState)}
    <Onboarding
      state={(lifecycleState ?? 'NeedsInstall') as LifecycleState}
      mode={wizardModeForLifecycle(lifecycleState ?? 'NeedsInstall')}
      onfinish={handleOnboardingFinish}
    />
  {:else if authenticated && consentReprompt}
    <!-- US-005: blocking re-prompt for a stale/administrative/pre-versioned
         consent record. Same consent UI as onboarding, answered exactly once. -->
    <Onboarding
      state="SteadyState"
      mode="reprompt"
      repromptPersonUid={consentReprompt.personUid}
      onfinish={handleConsentRepromptFinish}
    />
  {:else if authenticated}
    <!-- PL-06: a signed-in person works in the desktop window. `main` stays a
         hidden controller — it renders nothing here, and nothing shows it.
         The controller itself (sync orchestration, set_tray_state, the macOS
         unread badge, tray-menu commands, notification routing) lives in the
         script block above and keeps running while this branch is empty. -->
  {:else}
    <SignInPrompt reauth={syncState === 'auth-error'} onsuccess={handleAuthSuccess} />
  {/if}
</main>

<style>
  /* Scoped to the `main` window via `data-window` (set in main.ts) so
     MeetingsWindow's opaque dark body background can't bleed across CSS
     bundle order and turn this transparent window into a black box. */
  :global(html[data-window='main']),
  :global(html[data-window='main'] body) {
    margin: 0;
    padding: 0;
    width: 100vw;
    height: 100vh;
    /* overflow:hidden prevents scrollbars from appearing on the root
       document. The onboarding and sign-in cards own their own scroll
       containers. */
    overflow: hidden;
    font-family: var(--font-sans);
    /* Transparent so the onboarding / sign-in card's rounded corners show
       the desktop behind them (the tauri window is transparent). Each card
       paints its own background + border-radius. */
    background: transparent;
    color: var(--popover-text, #e0e0e0);
  }

  main {
    /* Fill the window exactly; the mounted card sizes itself via
       100vw/100vh. No centering flex — that created a sub-viewport box that
       could clip the card if it ever exceeded window size. */
    width: 100vw;
    height: 100vh;
    padding: 0;
    overflow: hidden;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
  }

  .dot-spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2.5px solid var(--popover-progress-track, rgba(255, 255, 255, 0.14));
    border-top-color: var(--popover-progress-fill, #ffffff);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
