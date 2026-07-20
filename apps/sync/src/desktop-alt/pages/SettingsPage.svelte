<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { getVersion } from '@tauri-apps/api/app';
  import { emit } from '@tauri-apps/api/event';
  import { open as openUrl } from '@tauri-apps/plugin-shell';
  import { formatHqFolderMeta, type SettingsTab } from '../route';
  import { emitDesktopTelemetry } from '../../lib/desktop-telemetry';
  import { postOptIn } from '../../lib/onboarding-telemetry';
  import { permissionState, loadMeetingPermissions } from '../../lib/permissionState.svelte';
  import { packUpdateTitle } from '../../lib/packUpdate';
  import { tutorialUrl } from '../../lib/tutorial';
  import WidgetSettings from '../../components/WidgetSettings.svelte';
  import '../v4/tokens.css';

  // The secondary sidebar drives which section is in view; this page renders all
  // sections in one scroll and reacts to `activeTab` by scrolling it into view.
  let { activeTab = 'sync' }: { activeTab?: SettingsTab } = $props();

  type Channel = 'stable' | 'beta' | 'alpha';
  type Platform = 'zoom' | 'meet' | 'teams' | 'slack' | 'webex';

  // Exact upgrade command the v0.9.8 popover copied to the clipboard.
  const HQ_CLI_UPGRADE_CMD = 'npm install -g @indigoai-us/hq-cli@latest';

  interface SettingsWire {
    hqPath: string | null;
    syncOnLaunch: boolean | null;
    notifications: boolean | null;
    startAtLogin: boolean | null;
    realtimeSync: boolean | null;
    personalSyncEnabled: boolean | null;
    instantSync: boolean | null;
    shareNotifications: boolean | null;
    dmNotifications: boolean | null;
    cliAutoUpdate: boolean | null;
    autoUpdate: boolean | null;
    stagingChannel: boolean | null;
    releaseChannel: string | null;
    meetingDetectNotify?: {
      enabled: boolean | null;
      platforms: string[] | null;
    } | null;
    defaultRecordingCompanyUid?: string | null;
    telemetryEnabled?: boolean | null;
  }

  type DriftEntry = {
    path: string;
    size: number;
    gitShaLocal: string | null;
    gitShaUpstream: string | null;
  };
  type DriftReport = {
    count: number;
    modified: DriftEntry[];
    missing: DriftEntry[];
    added: DriftEntry[];
    scannedAt: string;
    hqVersion: string;
    targetRepo: string;
    targetRef: string;
  };
  type CoreState = {
    channel: 'release' | 'staging';
    targetRepo: string;
    targetVersion: string;
    targetRef: string;
    localVersion: string | null;
    floorSha: string | null;
    isEligible: boolean;
    versionBehind: boolean;
    driftReport: DriftReport;
    unchangedCount: number;
    userOnlyCount: number;
    scannedAt: string;
  };

  const platforms: Platform[] = ['zoom', 'meet', 'teams', 'slack', 'webex'];

  // Memberships drive the default-recording-company dropdown (mirrors the
  // classic Settings + MeetingsWindow URL-invite picker). Empty for users with
  // no company memberships — the dropdown still renders so Personal is selectable.
  type CompanyMembership = {
    companyUid: string;
    companyName: string | null;
    role: string | null;
    status: string;
  };
  let memberships = $state<CompanyMembership[]>([]);

  let loading = $state(true);
  let saved = $state(false);
  let error = $state<string | null>(null);
  // GA gate (any signed-in user) — from `meetings_feature_enabled`. Gates the
  // Meeting-detection row, which graduated out of the Indigo dogfood.
  let isIndigoUser = $state(false);
  // True @getindigo.ai gate — from `is_indigo_user`. Gates the builder-only
  // staging-channel row. Kept separate from `isIndigoUser` above because
  // `meetings_feature_enabled` is now GA: keying the staging row off it would
  // hand the @getindigo.ai-only control to every signed-in user.
  let isIndigoBuilder = $state(false);
  let availableChannels = $state<Channel[]>(['stable']);

  let hqPath = $state<string | null>(null);
  // Default ON — mirrors the backend get_settings default; a fresh install
  // syncs on launch out of the box.
  let syncOnLaunch = $state(true);
  let realtimeSync = $state(true);
  let personalSyncEnabled = $state(true);
  let instantSync = $state(true);
  let notifications = $state(true);
  let shareNotifications = $state(true);
  let dmNotifications = $state(true);
  let cliAutoUpdate = $state(true);
  // Master automatic-updates switch — one toggle governs silent install of the
  // app, CLI, and hq-core. Default ON. Read fresh by the Rust auto-installers
  // and re-read by App.svelte on popover focus, so it takes effect without a
  // restart. Supersedes the standalone cliAutoUpdate toggle (still
  // round-tripped for back-compat, but the CLI installer now gates on
  // autoUpdate).
  let autoUpdate = $state(true);
  let stagingChannel = $state(true);
  let releaseChannel = $state<Channel | null>(null);
  let startAtLogin = $state(true);
  let meetingDetectEnabled = $state(true);
  let meetingDetectPlatforms = $state<string[]>([...platforms]);
  let defaultRecordingCompanyUid = $state<string | null>(null);
  // Telemetry is opt-out — defaults ON until the user explicitly turns it off.
  let telemetryEnabled = $state(true);

  // macOS notification authorization — distinct from the in-app `notifications`
  // preference. `'unknown'` = not yet read (row hidden until first resolve).
  let notifPermission = $state<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');
  let notifRequesting = $state(false);

  // App version from tauri.conf.json via the Tauri API.
  let appVersion = $state('');

  // Manual "Check for Updates" transient result (app auto-updater).
  let updateChecking = $state(false);
  let updateResult = $state<string | null>(null);
  let updateResultTimeout: ReturnType<typeof setTimeout> | null = null;

  // hq CLI update notice — loaded via check_hq_cli_update; null = hide card.
  let hqCliUpdate = $state<{ local: string | null; latest: string } | null>(null);
  let hqCliInstalling = $state(false);
  let hqCliUpdateError = $state<string | null>(null);
  let hqCliCmdCopied = $state(false);

  // Pack update notice — loaded via check_pack_update; hide when count is 0/null.
  let packUpdate = $state<{ count: number; names: string[] } | null>(null);
  let packsUpdating = $state(false);
  let packUpdateError = $state<string | null>(null);

  // HQ core row — get_hq_version + check_core_state on load.
  let hqVersion = $state<string | null>(null);
  let coreState = $state<CoreState | null>(null);
  let coreInstalling = $state(false);
  // Transient install result for the HQ core row (v0.9.8 parity): 'ok' auto-
  // clears after ~6s; 'err' stays until the next run. log_path surfaces on err
  // so the user can open the rescue log for details.
  let coreInstallResult = $state<'ok' | 'err' | null>(null);
  let coreInstallLogPath = $state<string | null>(null);
  let coreInstallResultTimeout: ReturnType<typeof setTimeout> | null = null;

  const displayedChannel = $derived<Channel>(
    releaseChannel ?? (availableChannels.includes('beta') ? 'beta' : 'stable'),
  );
  const hqPathLabel = $derived(hqPath ? formatHqFolderMeta(hqPath) : 'HQ folder not set');
  const coreHasDrift = $derived((coreState?.driftReport.count ?? 0) > 0);
  const coreNeedsUpdate = $derived(
    !!coreState && (coreState.versionBehind || coreHasDrift),
  );
  const coreUpdateLabel = $derived.by(() => {
    if (!coreState) return 'Update';
    if (coreState.channel === 'staging') {
      return coreState.versionBehind ? 'Update to Staging' : 'Restore Staging';
    }
    return coreState.versionBehind
      ? `Update to v${coreState.targetVersion}`
      : `Restore v${coreState.targetVersion}`;
  });

  $effect(() => {
    void loadSettings();
    void loadNotifPermission();
    void loadUpdateSurfaces();
    getVersion()
      .then((v) => {
        appVersion = v;
      })
      .catch((err) => console.error('Failed to read app version:', err));
    // Non-prompting read so the Meeting permissions row reflects the current
    // macOS grant state; refreshed on focus (returning from System Settings).
    void loadMeetingPermissions();
    const onFocus = () => {
      void loadMeetingPermissions();
      void loadNotifPermission();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (updateResultTimeout) clearTimeout(updateResultTimeout);
      if (coreInstallResultTimeout) clearTimeout(coreInstallResultTimeout);
    };
  });

  // Scroll the active section into view when the sidebar selection changes (and
  // once sections first render after load). No-op for the default top section.
  $effect(() => {
    const id = activeTab;
    if (loading) return;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  async function loadSettings() {
    loading = true;
    error = null;
    try {
      const [settings, indigoUser, indigoBuilder, channels, memberships_] = await Promise.all([
        invoke<SettingsWire>('get_settings'),
        invoke<boolean>('meetings_feature_enabled').catch(() => false),
        // True @getindigo.ai gate for the staging-channel row (NOT the GA
        // `meetings_feature_enabled` above, which admits any signed-in user).
        invoke<boolean>('is_indigo_user').catch(() => false),
        invoke<string[]>('available_channels').catch(() => ['stable']),
        // Drives the default-recording-company dropdown. A vault hiccup must not
        // block the rest of Settings from rendering → degrade to Personal-only.
        invoke<CompanyMembership[]>('meetings_list_memberships').catch(() => []),
      ]);
      // Keep the persisted path byte-for-byte intact. In particular, Windows
      // verbatim paths (\\?\C:\... and \\?\UNC\...) need their prefix for
      // long-path filesystem operations; formatHqFolderMeta handles display.
      hqPath = settings.hqPath;
      syncOnLaunch = settings.syncOnLaunch ?? true;
      realtimeSync = settings.realtimeSync ?? true;
      personalSyncEnabled = settings.personalSyncEnabled ?? true;
      instantSync = settings.instantSync ?? true;
      notifications = settings.notifications ?? true;
      shareNotifications = settings.shareNotifications ?? true;
      dmNotifications = settings.dmNotifications ?? true;
      cliAutoUpdate = settings.cliAutoUpdate ?? true;
      autoUpdate = settings.autoUpdate ?? true;
      stagingChannel = settings.stagingChannel ?? true;
      startAtLogin = settings.startAtLogin ?? true;
      meetingDetectEnabled = settings.meetingDetectNotify?.enabled ?? true;
      meetingDetectPlatforms = settings.meetingDetectNotify?.platforms ?? [...platforms];
      // Keep only active memberships; validate the stored default against the
      // live list so a revoked-access default falls back to Personal (null).
      memberships = (memberships_ ?? []).filter((m) => m.status === 'active');
      const storedUid = settings.defaultRecordingCompanyUid ?? null;
      defaultRecordingCompanyUid =
        storedUid && memberships.some((m) => m.companyUid === storedUid) ? storedUid : null;
      telemetryEnabled = settings.telemetryEnabled ?? true;
      isIndigoUser = indigoUser;
      isIndigoBuilder = indigoBuilder;
      availableChannels = channels.filter(isChannel);
      releaseChannel = isChannel(settings.releaseChannel) ? settings.releaseChannel : null;
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  function isChannel(value: unknown): value is Channel {
    return value === 'stable' || value === 'beta' || value === 'alpha';
  }

  function togglePlatform(platform: Platform) {
    meetingDetectPlatforms = meetingDetectPlatforms.includes(platform)
      ? meetingDetectPlatforms.filter((item) => item !== platform)
      : [...meetingDetectPlatforms, platform];
    void saveSettings();
  }

  // Re-tether the HQ folder — mirrors the classic Settings "Change…" button so a
  // user who moved their HQ folder can fix it without opening the menubar popover
  // or hand-editing menubar.json.
  async function handlePickFolder() {
    try {
      const picked = await invoke<string | null>('pick_folder');
      if (picked !== null) {
        hqPath = picked;
        await saveSettings();
      }
    } catch (err) {
      error = String(err);
    }
  }

  // Open the macOS TCC permissions wizard. Without this row the desktop window
  // had no way to grant the Accessibility/Screen-Recording/Microphone access the
  // meeting SDK needs — users had to open the classic popover to reach it.
  async function handleOpenMeetingPermissionsWizard() {
    try {
      await invoke('open_meeting_permissions_window');
    } catch (err) {
      error = String(err);
    }
  }

  async function saveSettings() {
    error = null;
    try {
      await invoke('save_settings', {
        prefs: {
          hqPath,
          syncOnLaunch,
          notifications,
          startAtLogin,
          realtimeSync,
          personalSyncEnabled,
          instantSync,
          shareNotifications,
          dmNotifications,
          cliAutoUpdate,
          autoUpdate,
          stagingChannel,
          releaseChannel,
          meetingDetectNotify: {
            enabled: meetingDetectEnabled,
            platforms: meetingDetectPlatforms,
          },
          defaultRecordingCompanyUid,
          telemetryEnabled,
        },
      });
      saved = true;
      window.setTimeout(() => (saved = false), 1000);
    } catch (err) {
      error = String(err);
    }
  }

  async function auditTelemetryPreferenceChanged(enabled: boolean) {
    await emitDesktopTelemetry({
      eventName: 'telemetry_preference_changed',
      properties: { enabled, surface: 'desktop-settings' },
    });
  }

  async function applyTelemetryPreference() {
    const next = telemetryEnabled;
    if (!next) {
      await auditTelemetryPreferenceChanged(next);
    }
    await saveSettings();
    await postOptIn({ enabled: next });
    if (next) {
      await auditTelemetryPreferenceChanged(next);
    }
  }

  // Three toggles carry live backend side-effects beyond persistence — without
  // them, flipping the switch in this window only writes menubar.json and the
  // running process keeps its old behavior until the next launch. These mirror
  // the classic popover Settings (src/components/Settings.svelte) so both
  // surfaces apply identically. `bind:checked` has already flipped the bound
  // value by the time onchange fires, so each reads the NEW state directly.

  // Auto-sync drives whether the background daemon runs at all. Start or stop
  // it immediately so the change takes effect without an app restart.
  async function applyRealtimeSync() {
    await saveSettings();
    try {
      if (realtimeSync) {
        await invoke('start_daemon');
      } else {
        await invoke('stop_daemon');
      }
    } catch (err) {
      // Persisted state is authoritative; main.rs reconciles on next launch.
      console.error('Auto-sync daemon command failed:', err);
    }
  }

  // Instant-sync is read at daemon spawn time (the --event-push argv). If the
  // daemon is already running, bounce it so the new flag takes effect now; if
  // Auto-sync is off there's no process to bounce — the next start picks it up.
  async function applyInstantSync() {
    await saveSettings();
    if (!realtimeSync) return;
    try {
      await invoke('stop_daemon');
      await invoke('start_daemon');
    } catch (err) {
      console.error('Instant-sync daemon restart failed:', err);
    }
  }

  // Start-at-login must reconcile the macOS LaunchAgent plist, not just persist
  // the flag — otherwise the login item never actually changes.
  async function applyStartAtLogin() {
    try {
      await invoke('set_autostart_enabled', { enabled: startAtLogin });
    } catch (err) {
      console.error('Failed to set autostart:', err);
    }
    await saveSettings();
  }

  // OS-level macOS notification authorization (non-prompting). Hidden until
  // the first read resolves, like the classic Settings surface.
  async function loadNotifPermission() {
    try {
      notifPermission = await invoke<'granted' | 'denied' | 'prompt'>(
        'notification_permission_state',
      );
    } catch (err) {
      console.error('Failed to read notification permission:', err);
      notifPermission = 'unknown';
    }
  }

  async function handleEnableNotifications() {
    if (notifRequesting) return;
    // Once macOS has recorded a denial it will NOT re-show the system dialog,
    // so request_permission() would be a silent no-op. Deep-link to
    // System Settings > Notifications instead.
    if (notifPermission === 'denied') {
      try {
        await openUrl('x-apple.systempreferences:com.apple.preference.notifications');
      } catch (err) {
        console.error('Failed to open System Settings:', err);
      }
      return;
    }
    notifRequesting = true;
    try {
      notifPermission = await invoke<'granted' | 'denied' | 'prompt'>(
        'notification_request_permission',
      );
    } catch (err) {
      console.error('Failed to request notification permission:', err);
    } finally {
      notifRequesting = false;
    }
  }

  // Fire-and-forget update surface hydration. Each check is independent so a
  // failed check_* never blocks the rest of Settings.
  async function loadUpdateSurfaces() {
    await Promise.all([
      refreshHqCliUpdate(),
      refreshPackUpdate(),
      refreshCoreState(),
    ]);
  }

  async function refreshHqCliUpdate() {
    if (hqCliInstalling) return;
    try {
      const info = await invoke<{ local: string | null; latest: string } | null>(
        'check_hq_cli_update',
      );
      hqCliUpdate = info;
      if (info) hqCliUpdateError = null;
    } catch (err) {
      console.error('check_hq_cli_update failed:', err);
      hqCliUpdate = null;
    }
  }

  async function refreshPackUpdate() {
    try {
      const info = await invoke<{ count: number; names: string[] } | null>(
        'check_pack_update',
      );
      packUpdate = info && info.count > 0 ? info : null;
    } catch (err) {
      console.error('check_pack_update failed:', err);
      packUpdate = null;
    }
  }

  async function refreshCoreState() {
    try {
      const [version, state] = await Promise.all([
        invoke<string | null>('get_hq_version').catch(() => null),
        invoke<CoreState | null>('check_core_state').catch(() => null),
      ]);
      hqVersion = version;
      coreState = state;
    } catch (err) {
      console.error('core state refresh failed:', err);
    }
  }

  async function handleCheckForUpdates() {
    if (updateChecking) return;
    updateChecking = true;
    updateResult = null;
    if (updateResultTimeout) clearTimeout(updateResultTimeout);
    try {
      const info = await invoke<{ version: string; body?: string; date?: string } | null>(
        'check_for_updates',
      );
      updateResult = info ? `v${info.version} ready` : 'Up to date';
    } catch (err) {
      console.error('check_for_updates failed:', err);
      updateResult = 'Check failed';
    } finally {
      updateChecking = false;
      updateResultTimeout = setTimeout(() => {
        updateResult = null;
      }, 4000);
    }
  }

  async function handleInstallHqCliUpdate() {
    if (hqCliInstalling) return;
    hqCliInstalling = true;
    hqCliUpdateError = null;
    try {
      const info = await invoke<{ local: string | null; latest: string }>(
        'install_hq_cli_update',
      );
      if (info.local && info.local === info.latest) {
        hqCliUpdate = null;
      } else {
        hqCliUpdate = info;
      }
      // Re-check after a successful install so a race with the registry is
      // reflected; leave the error path alone so "Update failed." sticks.
      await refreshHqCliUpdate();
    } catch (err) {
      console.error('install_hq_cli_update failed:', err);
      hqCliUpdateError = String(err);
    } finally {
      hqCliInstalling = false;
    }
  }

  async function handleDismissHqCliUpdate() {
    const latest = hqCliUpdate?.latest;
    hqCliUpdate = null;
    hqCliUpdateError = null;
    if (!latest) return;
    try {
      await invoke('set_hq_cli_update_dismissed', { version: latest });
    } catch (err) {
      console.error('set_hq_cli_update_dismissed failed:', err);
    }
  }

  async function copyHqCliCommand() {
    try {
      await navigator.clipboard.writeText(HQ_CLI_UPGRADE_CMD);
      hqCliCmdCopied = true;
      setTimeout(() => {
        hqCliCmdCopied = false;
      }, 1500);
    } catch (err) {
      console.error('copy hq CLI command failed:', err);
    }
  }

  async function handleUpdatePacks() {
    if (packsUpdating || !packUpdate) return;
    packsUpdating = true;
    packUpdateError = null;
    try {
      await invoke('update_packs', { names: packUpdate.names });
      packUpdate = null;
      await refreshPackUpdate();
    } catch (err) {
      packUpdateError = err instanceof Error ? err.message : String(err);
    } finally {
      packsUpdating = false;
    }
  }

  async function handleOpenDriftDetail() {
    const report = coreState?.driftReport;
    if (!report) return;
    try {
      await invoke('open_drift_detail', { report });
    } catch (err) {
      console.error('open_drift_detail failed:', err);
    }
  }

  async function handleInstallCore() {
    if (coreInstalling || !coreState) return;
    coreInstalling = true;
    coreInstallResult = null;
    coreInstallLogPath = null;
    if (coreInstallResultTimeout) {
      clearTimeout(coreInstallResultTimeout);
      coreInstallResultTimeout = null;
    }
    const command =
      coreState.channel === 'staging'
        ? 'run_replace_from_staging'
        : 'install_hq_core_update';
    try {
      // Rescue commands resolve Ok with { exit_code, log_tail, log_path } —
      // a NONZERO exit_code is a failed rescue that still returns successfully
      // from invoke (same shape as the classic popover path in App.svelte).
      const result = await invoke<{
        exit_code: number;
        log_tail: string;
        log_path: string;
      }>(command);
      if (result.exit_code === 0) {
        coreInstallResult = 'ok';
        // Auto-clear "update done" after a few seconds (momentary confirm).
        coreInstallResultTimeout = setTimeout(() => {
          if (coreInstallResult === 'ok') coreInstallResult = null;
          coreInstallResultTimeout = null;
        }, 6000);
      } else {
        coreInstallResult = 'err';
        coreInstallLogPath = result.log_path || null;
      }
      await refreshCoreState();
    } catch (err) {
      console.error(`${command} failed:`, err);
      coreInstallResult = 'err';
      coreInstallLogPath = null;
    } finally {
      coreInstalling = false;
    }
  }

  // Sign out via the same tray:sign-out event App.svelte already listens for
  // (sign_out + state reset), then surface the popover SignInPrompt.
  async function handleSignOut() {
    try {
      await emit('tray:sign-out');
    } catch (err) {
      console.error('emit tray:sign-out failed:', err);
    }
    try {
      await invoke('show_main_window');
    } catch (err) {
      console.error('show_main_window failed:', err);
    }
  }

  async function handleQuit() {
    try {
      await invoke('quit_app');
    } catch (err) {
      console.error('quit_app failed:', err);
    }
  }

  // Re-read just the persisted prefs (no loading flash) so a change made in the
  // menubar popover while this window is open reflects here on focus. The indigo
  // gate, channel list, and memberships are process-stable, so they're skipped.
  async function refreshSettingsSilently() {
    try {
      const settings = await invoke<SettingsWire>('get_settings');
      hqPath = settings.hqPath;
      syncOnLaunch = settings.syncOnLaunch ?? true;
      realtimeSync = settings.realtimeSync ?? true;
      personalSyncEnabled = settings.personalSyncEnabled ?? true;
      instantSync = settings.instantSync ?? true;
      notifications = settings.notifications ?? true;
      shareNotifications = settings.shareNotifications ?? true;
      dmNotifications = settings.dmNotifications ?? true;
      cliAutoUpdate = settings.cliAutoUpdate ?? true;
      autoUpdate = settings.autoUpdate ?? true;
      stagingChannel = settings.stagingChannel ?? true;
      startAtLogin = settings.startAtLogin ?? true;
      meetingDetectEnabled = settings.meetingDetectNotify?.enabled ?? true;
      meetingDetectPlatforms = settings.meetingDetectNotify?.platforms ?? [...platforms];
      defaultRecordingCompanyUid = settings.defaultRecordingCompanyUid ?? null;
      telemetryEnabled = settings.telemetryEnabled ?? true;
      releaseChannel = isChannel(settings.releaseChannel) ? settings.releaseChannel : null;
    } catch {
      // Non-fatal — keep showing the last-known values.
    }
  }

  $effect(() => {
    const onFocus = () => {
      void refreshSettingsSilently();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });
</script>

<section class="settings-page" aria-labelledby="settings-title" aria-busy={loading}>
  <main class="settings-main">
    <header class="page-header">
      <div>
        <p>{saved ? 'Saved' : 'menubar.json'}</p>
        <h1 id="settings-title">Settings</h1>
      </div>
    </header>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <section id="sync" class="settings-section">
      <h2>Sync</h2>
      <div class="settings-card">
        <div class="setting-row">
          <div><strong>HQ folder</strong><span>{hqPathLabel}</span></div>
          <button type="button" class="row-button" onclick={handlePickFolder}>Change…</button>
        </div>
        <label class="setting-row"><span><strong>Sync on launch</strong><small>Run a sync when the app starts.</small></span><input type="checkbox" bind:checked={syncOnLaunch} onchange={saveSettings} /></label>
        <label class="setting-row"><span><strong>Auto-sync</strong><small>Sync every few minutes in the background.</small></span><input type="checkbox" bind:checked={realtimeSync} onchange={applyRealtimeSync} /></label>
        <label class="setting-row"><span><strong>Instant sync</strong><small>Push local edits within seconds when eligible.</small></span><input type="checkbox" bind:checked={instantSync} onchange={applyInstantSync} /></label>
        <label class="setting-row"><span><strong>Sync personal vault</strong><small>Include personal HQ files in the fanout.</small></span><input type="checkbox" bind:checked={personalSyncEnabled} onchange={saveSettings} /></label>
      </div>
    </section>

    <section id="notifications" class="settings-section">
      <h2>Notifications</h2>
      <div class="settings-card">
        <label class="setting-row"><span><strong>Sync notifications</strong><small>Notify when sync needs attention.</small></span><input type="checkbox" bind:checked={notifications} onchange={saveSettings} /></label>
        <label class="setting-row"><span><strong>Share notifications</strong><small>Show file-share activity from teammates.</small></span><input type="checkbox" bind:checked={shareNotifications} onchange={saveSettings} /></label>
        <label class="setting-row"><span><strong>DM notifications</strong><small>Show direct messages in the menu bar.</small></span><input type="checkbox" bind:checked={dmNotifications} onchange={saveSettings} /></label>
        <!-- macOS permission monitor — OS authorization, separate from the
             in-app toggles above. Hidden until the first state read resolves. -->
        {#if notifPermission !== 'unknown'}
          <div class="setting-row">
            <span>
              <strong>System permission</strong>
              <small>
                {#if notifPermission === 'granted'}
                  System notifications are enabled for HQ
                {:else if notifPermission === 'denied'}
                  Blocked by system settings — open notification settings to allow
                {:else}
                  Not enabled yet — allow to see sync &amp; share alerts
                {/if}
              </small>
            </span>
            {#if notifPermission === 'granted'}
              <span class="perm-pill">Enabled</span>
            {:else}
              <button
                type="button"
                class="row-button"
                onclick={handleEnableNotifications}
                disabled={notifRequesting}
              >
                {#if notifRequesting}
                  Requesting…
                {:else if notifPermission === 'denied'}
                  Open Settings
                {:else}
                  Enable
                {/if}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    </section>

    <section id="widget" class="settings-section">
      <h2>Widget</h2>
      <div class="settings-card">
        <WidgetSettings />
      </div>
    </section>

    <section id="updates" class="settings-section">
      <h2>Updates</h2>
      <div class="settings-card">
        <!-- Master automatic-updates switch (default ON). One toggle governs
             silent, no-prompt install of the app itself (self-update +
             restart), the hq CLI, and hq-core (drift-safe rescue). Supersedes
             the old per-CLI "Auto-update HQ CLI" toggle. -->
        <label class="setting-row"><span><strong>Automatic updates</strong><small>Install HQ, the app, and the CLI updates automatically in the background — no prompts.</small></span><input id="toggle-auto-update" type="checkbox" bind:checked={autoUpdate} onchange={saveSettings} aria-label="Automatic updates" /></label>
        <label class="setting-row gated-row"><span><strong>HQ core staging channel</strong><small>@getindigo.ai only. Changes rescue and drift targets.</small></span><input type="checkbox" disabled={!isIndigoBuilder} bind:checked={stagingChannel} onchange={async () => { await saveSettings(); await refreshCoreState(); }} /><em>Gated</em></label>
        <label class="setting-row gated-row"><span><strong>Release channel</strong><small>@getindigo.ai only. Stable is enforced for everyone else.</small></span><select disabled={availableChannels.length <= 1} bind:value={releaseChannel} onchange={saveSettings}><option value={null}>Default ({displayedChannel})</option>{#each availableChannels as channel (channel)}<option value={channel}>{channel}</option>{/each}</select><em>Gated</em></label>
        <div class="setting-row">
          <span>
            <strong>Check for Updates</strong>
            <small>{updateResult ?? 'Background checks run every 6 hours'}</small>
          </span>
          <button
            type="button"
            class="row-button"
            onclick={handleCheckForUpdates}
            disabled={updateChecking}
          >
            {updateChecking ? 'Checking…' : 'Check Now'}
          </button>
        </div>
        <div class="setting-row">
          <span>
            <strong>HQ core</strong>
            <small>
              {#if coreInstallResult === 'ok'}
                update done
              {:else if coreInstallResult === 'err'}
                Update failed{#if coreInstallLogPath} — {coreInstallLogPath}{/if}
              {:else}
                {hqVersion ? `v${hqVersion}` : 'version unknown'}
              {/if}
            </small>
          </span>
          <div class="row-actions">
            {#if coreHasDrift}
              <button type="button" class="row-button" onclick={handleOpenDriftDetail}>
                {coreState?.driftReport.count} drifted
              </button>
            {/if}
            {#if coreNeedsUpdate}
              <button
                type="button"
                class="row-button primary"
                onclick={handleInstallCore}
                disabled={coreInstalling}
              >
                {coreInstalling ? 'Updating…' : coreUpdateLabel}
              </button>
            {/if}
          </div>
        </div>
      </div>

      {#if hqCliUpdate}
        <div class="settings-card notice-card">
          <div class="setting-row notice-row">
            <span>
              <strong>hq CLI update: v{hqCliUpdate.latest}</strong>
              <small>
                {#if hqCliUpdateError}
                  Update failed.
                {:else if hqCliUpdate.local}
                  You're on v{hqCliUpdate.local}
                {:else}
                  A newer CLI is available
                {/if}
              </small>
            </span>
            <div class="row-actions">
              <button
                type="button"
                class="row-button primary"
                onclick={handleInstallHqCliUpdate}
                disabled={hqCliInstalling}
              >
                {hqCliInstalling ? 'Installing…' : 'Update'}
              </button>
              <button type="button" class="row-button" onclick={copyHqCliCommand}>
                {hqCliCmdCopied ? 'Copied' : 'Copy command'}
              </button>
              <button type="button" class="row-button" onclick={handleDismissHqCliUpdate}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if packUpdate && packUpdate.count > 0}
        <div class="settings-card notice-card">
          <div class="setting-row notice-row">
            <span>
              <strong>{packUpdateTitle(packUpdate.count)}</strong>
              <small>
                {#if packUpdateError}
                  Update failed. Run <code>hq packs update</code>.
                {:else}
                  {packUpdate.names.join(', ')}
                {/if}
              </small>
            </span>
            <button
              type="button"
              class="row-button primary"
              onclick={handleUpdatePacks}
              disabled={packsUpdating}
            >
              {packsUpdating ? 'Updating…' : 'Update'}
            </button>
          </div>
        </div>
      {/if}
    </section>

    <section id="general" class="settings-section">
      <h2>General</h2>
      <div class="settings-card">
        <label class="setting-row"><span><strong>Start at login</strong><small>Open HQ when your computer starts.</small></span><input type="checkbox" bind:checked={startAtLogin} onchange={applyStartAtLogin} /></label>
        <label class="setting-row"><span><strong>Usage telemetry</strong><small>Share anonymized usage counts to improve HQ. You can turn this off any time.</small></span><input type="checkbox" bind:checked={telemetryEnabled} onchange={applyTelemetryPreference} /></label>
        <div class="setting-row">
          <span><strong>HQ tutorial</strong><small>Follow the guided seven-lesson setup course.</small></span>
          <button type="button" class="row-button" onclick={() => void openUrl(tutorialUrl('hq_desktop_settings'))}>Open</button>
        </div>
        <div class="setting-row">
          <span><strong>Version</strong><small>HQ desktop app build</small></span>
          <span class="version-value">{appVersion ? `v${appVersion}` : '—'}</span>
        </div>
        <div class="setting-row">
          <span><strong>Account</strong><small>Sign out returns you to the menu bar sign-in screen.</small></span>
          <div class="row-actions">
            <button type="button" class="row-button" onclick={handleSignOut}>Sign out</button>
            <button type="button" class="row-button danger" onclick={handleQuit}>Quit HQ</button>
          </div>
        </div>
      </div>
    </section>

    <section id="meetings" class="settings-section">
      <h2>Meetings</h2>
      <div class="settings-card">
        <label class="setting-row gated-row"><span><strong>Meeting detection</strong><small>Detect active meeting apps and surface recording actions.</small></span><input type="checkbox" disabled={!isIndigoUser} bind:checked={meetingDetectEnabled} onchange={saveSettings} /><em>Gated</em></label>
        {#if meetingDetectEnabled}
          <!-- Only shown when detection is on — otherwise the platform toggles
               looked actionable but changed nothing (detection was off). -->
          <div class="setting-row platform-row">
            <span><strong>Platforms</strong><small>Choose which meeting apps are watched.</small></span>
            <div class="platforms">
              {#each platforms as platform (platform)}
                <button type="button" class:active={meetingDetectPlatforms.includes(platform)} onclick={() => togglePlatform(platform)}>{platform}</button>
              {/each}
            </div>
          </div>
          <div class="setting-row">
            <span>
              <strong>Ledger</strong>
              <small class="ledger-path">~/.hq/meeting-notify-ledger.json</small>
            </span>
          </div>
        {/if}
        <!-- A validated dropdown of the caller's active memberships, not a
             free-text UID field. The old text input saved an arbitrary,
             unvalidated string (and only on blur, so it often never saved) — a
             bad UID then silently fell back to Personal at recording time. -->
        <label class="setting-row">
          <span><strong>Default recording company</strong><small>Attribution for new recordings. Changeable per-recording.</small></span>
          <select
            value={defaultRecordingCompanyUid ?? ''}
            aria-label="Default recording company"
            onchange={(event) => {
              const v = event.currentTarget.value;
              defaultRecordingCompanyUid = v === '' ? null : v;
              void saveSettings();
            }}
          >
            <option value="">Personal</option>
            {#each memberships as m (m.companyUid)}
              <option value={m.companyUid}>{m.companyName?.trim() || 'Company'}</option>
            {/each}
          </select>
        </label>
        <!-- Meeting permissions monitor — the only place to grant the macOS TCC
             permissions the SDK needs. Without it the desktop window couldn't
             grant them at all. -->
        <div class="setting-row">
          <span>
            <strong>Meeting permissions</strong>
            <small>
              {#if !permissionState.meetingPermissions}
                Checking system privacy permissions…
              {:else if permissionState.meetingPermissions.allRequiredGranted}
                Accessibility, screen recording &amp; microphone all granted
              {:else}
                One or more system permissions need attention
              {/if}
            </small>
          </span>
          <button type="button" class="row-button" onclick={handleOpenMeetingPermissionsWizard}>Manage</button>
        </div>
      </div>
    </section>
  </main>
</section>

<style>
  .settings-page {
    display: block;
    min-width: 0;
    height: 100%;
    color: var(--v4-text-1);
    font-family: var(--font-sans);
  }

  .settings-section h2,
  .page-header p {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    font-weight: 500;
    line-height: 1.25;
  }

  .settings-main {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-5);
    min-width: 0;
    overflow: auto;
  }

  h1 {
    margin: 2px 0 0;
    font-size: var(--text-lg);
    font-weight: 500;
  }

  .settings-section {
    display: grid;
    gap: 8px;
    scroll-margin-top: 12px;
  }

  .settings-card {
    display: grid;
    overflow: hidden;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-raised);
    box-shadow: var(--v4-shadow-card);
  }

  .setting-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 10px 12px;
    border-top: 1px solid var(--v4-rowline);
  }

  .setting-row:first-child {
    border-top: 0;
  }

  .setting-row > span:first-child,
  .setting-row > div:first-child {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    font-weight: 500;
  }

  small,
  .setting-row div span,
  .error {
    color: var(--v4-text-3);
    font-size: var(--text-base);
    line-height: 1.35;
  }

  input,
  select {
    min-width: 0;
  }

  /* macOS-style toggle pill — the one place green is allowed as a control fill
     (SPEC §5/§6: "26×16 pills, on = green fill — the one non-dot color
     exception, matching macOS"). The track and knob route through shared tokens. */
  input[type='checkbox'] {
    appearance: none;
    -webkit-appearance: none;
    position: relative;
    flex-shrink: 0;
    width: 26px;
    height: 16px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-bg);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  input[type='checkbox']::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: var(--v4-radius-pill);
    background: var(--c-bg);
    box-shadow: var(--v4-shadow-card);
    transition: transform 0.15s ease;
  }

  input[type='checkbox']:checked {
    background: var(--v4-ok);
  }

  input[type='checkbox']:checked::after {
    transform: translateX(10px);
  }

  input[type='checkbox']:disabled {
    opacity: 0.5;
    cursor: default;
  }

  input[type='checkbox']:focus-visible {
    outline: 1.5px solid var(--v4-text-2);
    outline-offset: 2px;
  }

  input:not([type='checkbox']),
  select {
    height: 30px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-inset);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--text-base);
  }

  select {
    color-scheme: dark;
  }

  select option {
    background: var(--v4-raised);
    color: var(--v4-text-1);
  }

  .gated-row em {
    padding: 3px 7px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-3);
    font-size: var(--text-base);
    font-style: normal;
  }

  /* Trailing row affordance (Change… / Manage) — quiet pill matching the V4
     control language. */
  .row-button {
    justify-self: end;
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-secondary-bg);
    color: var(--v4-secondary-fg);
    font: inherit;
    font-size: var(--text-base);
    cursor: pointer;
    white-space: nowrap;
  }

  .row-button:hover {
    border-color: var(--v4-text-3);
  }

  .row-button:focus-visible {
    outline: 1.5px solid var(--v4-text-2);
    outline-offset: 2px;
  }

  .platform-row {
    align-items: start;
  }

  .platforms {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }

  .platforms button {
    min-width: 58px;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--text-base);
    cursor: pointer;
  }

  .platforms button.active {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }

  .row-button.primary {
    background: var(--v4-primary-bg);
    border-color: transparent;
    color: var(--v4-primary-fg);
  }

  .row-button.danger {
    color: var(--v4-text-1);
  }

  .row-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .perm-pill {
    justify-self: end;
    padding: 3px 8px;
    border-radius: var(--v4-radius-pill);
    background: color-mix(in srgb, var(--v4-ok) 18%, transparent);
    color: var(--v4-ok);
    font-size: var(--text-base);
    font-weight: 600;
    white-space: nowrap;
  }

  .version-value {
    justify-self: end;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .notice-card {
    margin-top: 8px;
  }

  .notice-row {
    align-items: start;
  }

  .ledger-path {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.92em;
  }
</style>
