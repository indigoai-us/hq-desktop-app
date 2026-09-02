<script lang="ts">
  import {
    createUpdateCheckRunner,
    type AdapterResult,
  } from "./update-orchestration";
  import {
    channelDowngradeNotice,
    channelOptions,
    normalizeChannel,
    selectedChannel,
    type ReleaseChannelId,
  } from "./release-channel-model";
  /**
   * Host settings sections — Daybook / preview-v2 set-row + toggle language.
   * Appearance choices are local to this embedded window. Every setting that
   * claims to affect the native host is read from and written through it.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import {
    APPEARANCE_SIZES,
    APPEARANCE_THEMES,
    applyColorTheme,
    applyUiSize,
    applyWindowOpacity,
    calendarAccountLabel,
    readStoredTheme,
    settingsCompanyLists,
  } from "./shell-settings-model.js";
  import {
    readSettingsPrefs,
    writeSettingsPrefs,
    type SettingsUiSize,
    type ShellSettingsPrefs,
  } from "./settings-prefs.js";
  import { formatHqFolderMeta } from "./settings-sections.js";
  import {
    EMPTY_LIVE_SYNC,
    lastSyncLabelFromLive,
    readLiveSyncStatus,
    type LiveSyncStatus,
  } from "./live-sync-status.js";
  import type { ColorTheme } from "./appearance-seam.js";
  import {
    configureMeetingsApi,
    meetingsStore,
  } from "../meetings/meetings-store.svelte";
  import { isRecordingWorkspace } from "../meetings/recording-membership.js";
  import { HQ_CONSOLE_INTEGRATIONS_URL } from "../common/hq-console";
  import AvatarPackSettings from "../avatars/AvatarPackSettings.svelte";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";

  type Section =
    | "general"
    | "appearance"
    | "notifications"
    | "sync"
    | "meetings"
    | "updates";

  interface Props {
    section: Section;
    version?: string;
    adapter?: PlatformAdapter | null;
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    sessionGeneration?: number;
    companies?: Workspace[] | null;
    personalLabel?: string | null;
    onopenconsole?: (url: string) => Promise<void> | void;
    consoleBase?: string;
    /** Changes whenever the native host observes an app/Core/CLI update edge. */
    updateWakeSeq?: number;
    /** Reads the running native app version (Tauri's app API in Sync). */
    refreshAppVersion?: () => Promise<string>;
  }

  let {
    section,
    version = "0.0.0",
    adapter = null,
    storage = typeof window !== "undefined" ? window.localStorage : null,
    sessionGeneration = 0,
    companies = null,
    personalLabel = null,
    onopenconsole,
    consoleBase: _consoleBase = HQ_CONSOLE_BASE,
    updateWakeSeq = 0,
    refreshAppVersion,
  }: Props = $props();

  let prefs = $state<ShellSettingsPrefs>(readSettingsPrefs(storage));
  let theme = $state<ColorTheme>(readStoredTheme());
  let notifPermission = $state<string | null>(null);
  let notifRequesting = $state(false);
  let notifPermissionError = $state<string | null>(null);
  interface ConnectedCalendarAccount {
    accountId: string;
    label: string;
  }

  let connectedAccounts = $state<ConnectedCalendarAccount[]>([]);
  let calendarConnectStarting = $state(false);
  let calendarConnectMessage = $state<string | null>(null);
  let calendarConnectWarn = $state(false);
  let calendarDisconnectingId = $state<string | null>(null);
  let appVersion = $state(version);
  let coreVersion = $state<string | null>(null);
  let cliVersion = $state<string | null>(null);
  let hqFolder = $state<string | null>(null);
  let customHqRoot = $state<string | null>(null);
  let liveSync = $state<LiveSyncStatus>({ ...EMPTY_LIVE_SYNC });
  let dockVisibilityChanged = false;
  let desktopWidgetChanged = false;
  let dockWriteSeq = 0;
  let desktopWidgetWriteSeq = 0;
  let dockAuthoritativeValue: boolean | undefined;
  let desktopWidgetAuthoritativeValue: boolean | undefined;
  type NativeSettings = {
    startAtLogin: boolean;
    syncOnLaunch: boolean;
    realtimeSync: boolean;
    instantSync: boolean;
    personalSyncEnabled: boolean;
    notifications: boolean;
    shareNotifications: boolean;
    dmNotifications: boolean;
    autoUpdate: boolean;
    meetingDetection: boolean;
    meetingPlatforms: string[];
    defaultRecordingCompanyUid: string | null;
  };
  const DEFAULT_NATIVE_SETTINGS: NativeSettings = {
    startAtLogin: true,
    syncOnLaunch: true,
    realtimeSync: true,
    instantSync: true,
    personalSyncEnabled: true,
    notifications: true,
    shareNotifications: true,
    dmNotifications: true,
    autoUpdate: true,
    meetingDetection: true,
    meetingPlatforms: ["zoom", "meet", "teams", "slack", "webex"],
    defaultRecordingCompanyUid: null,
  };
  const MEETING_PLATFORMS = [
    { id: "zoom", label: "Zoom" },
    { id: "meet", label: "Google Meet" },
    { id: "teams", label: "Teams" },
    { id: "slack", label: "Slack huddles" },
    { id: "webex", label: "Webex" },
  ] as const;
  let native = $state<NativeSettings>({ ...DEFAULT_NATIVE_SETTINGS });
  let nativeLoaded = $state(false);
  let nativeError = $state<string | null>(null);
  let pendingControls = $state<string[]>([]);
  let nativeReadGeneration = 0;
  let nativeReconcileAfterWrites = false;
  let versionsReadGeneration = 0;
  const updateCheckRunner = createUpdateCheckRunner();
  // "failed" covers a timed-out/hung check: the pane must show a real failed
  // state with a retry affordance rather than an endless CHECKING.
  let appUpdateStatus = $state<
    "checking" | "up-to-date" | "available" | "unchecked" | "failed"
  >("unchecked");
  let coreUpdateStatus = $state<"checking" | "up-to-date" | "available" | "unchecked" | "unlocated" | "failed">("unchecked");
  let cliUpdateStatus = $state<"checking" | "up-to-date" | "available" | "unchecked" | "unlocated" | "failed">("unchecked");
  let coreProbeError = $state<string | null>(null);
  let cliProbeError = $state<string | null>(null);
  let versionsRefreshing = $state(false);
  // Release channel (Stable / Beta / Alpha). The native host owns the
  // semantics — this is the persisted `releaseChannel` pref in menubar.json
  // that release_channel.rs `effective_channel` already resolves.
  let availableChannels = $state<unknown>(null);
  let releaseChannelPref = $state<ReleaseChannelId | null>(null);
  let effectiveChannel = $state<ReleaseChannelId | null>(null);
  let channelSaving = $state(false);
  let channelError = $state<string | null>(null);
  /** Newest version offered by the selected channel, when the host reports one. */
  let channelLatestVersion = $state<string | null>(null);
  const releaseChannelOptions = $derived(channelOptions(availableChannels));
  const selectedReleaseChannel = $derived(
    selectedChannel(releaseChannelPref, effectiveChannel),
  );
  const channelDowngrade = $derived(
    channelDowngradeNotice(
      appVersion,
      selectedReleaseChannel,
      channelLatestVersion,
    ),
  );

  const calendarConnectPending = $derived(meetingsStore.connectPending);

  const canSync = $derived(adapter?.isAvailable("canSync") ?? false);
  const canTray = $derived(adapter?.isAvailable("trayAndWindow") ?? false);
  const canSelfUpdate = $derived(
    adapter?.isAvailable("canSelfUpdate") ?? false,
  );
  const canWatchMeetings = $derived(
    adapter?.isAvailable("canLaunchApps") ?? false,
  );

  const lists = $derived(settingsCompanyLists(companies, personalLabel));
  const recordingCompanies = $derived(
    (companies ?? [])
      .filter(isRecordingWorkspace)
      .map((company) => ({
        id: company.cloudUid!,
        name: company.displayName,
      })),
  );

  function patch(next: Partial<ShellSettingsPrefs>): void {
    prefs = writeSettingsPrefs(next, storage);
  }

  function setTheme(next: ColorTheme): void {
    theme = applyColorTheme(next);
  }

  function setUiSize(next: SettingsUiSize): void {
    patch({ uiSize: applyUiSize(next) });
  }

  function setOpacity(next: number): void {
    patch({ windowOpacity: applyWindowOpacity(next) });
  }

  async function toggleLaunch(): Promise<void> {
    if (!adapter || pending("launch")) return;
    const previous = native.startAtLogin;
    const next = !previous;
    native = { ...native, startAtLogin: next };
    nativeReadGeneration += 1;
    nativeReconcileAfterWrites = true;
    beginPending("launch");
    nativeError = null;
    const applied = await adapter.appShell.setAutostart(next);
    if (!applied.ok) {
      native = { ...native, startAtLogin: previous };
      nativeError = actionableError("Launch at login", applied.message);
      endPending("launch");
      return;
    }
    const saved = await adapter.settings.updateSettings({ startAtLogin: next });
    if (!saved.ok) {
      native = { ...native, startAtLogin: previous };
      nativeError = actionableError("Launch at login", saved.message);
      const rollback = await adapter.appShell.setAutostart(previous);
      if (!rollback.ok) {
        nativeError += " macOS could not restore the prior login item; check System Settings → Login Items.";
      }
    }
    endPending("launch");
  }

  async function toggleDock(): Promise<void> {
    const next = !prefs.showInDock;
    const writeSeq = ++dockWriteSeq;
    dockVisibilityChanged = true;
    patch({ showInDock: next });
    // Apply both directions — hiding the Dock icon must take effect too.
    if (!adapter) return;
    const result = await adapter.appShell.setDockVisible(next);
    if (writeSeq !== dockWriteSeq) return;
    if (result.ok) {
      dockAuthoritativeValue = next;
      return;
    }
    nativeError = actionableError("Show in Dock", result.message);
    if (result.reason !== "error") return;
    const settings = await adapter.settings.getSettings();
    if (writeSeq !== dockWriteSeq) return;
    dockVisibilityChanged = false;
    if (!settings.ok) {
      if (dockAuthoritativeValue !== undefined) {
        patch({ showInDock: dockAuthoritativeValue });
      }
      return;
    }
    const dockIcon = readHostBooleanSetting(settings.value, "dockIcon");
    if (dockIcon !== undefined) {
      dockAuthoritativeValue = dockIcon;
      patch({ showInDock: dockIcon });
    } else if (dockAuthoritativeValue !== undefined) {
      patch({ showInDock: dockAuthoritativeValue });
    }
  }

  async function toggleDesktopWidget(): Promise<void> {
    const next = !prefs.desktopWidget;
    const writeSeq = ++desktopWidgetWriteSeq;
    desktopWidgetChanged = true;
    patch({ desktopWidget: next });
    if (!adapter) return;
    const result = await adapter.appShell.setDesktopWidget(next);
    if (writeSeq !== desktopWidgetWriteSeq) return;
    if (result.ok) {
      desktopWidgetAuthoritativeValue = next;
      return;
    }
    nativeError = actionableError("Desktop widget", result.message);
    if (result.reason !== "error") return;
    const settings = await adapter.settings.getSettings();
    if (writeSeq !== desktopWidgetWriteSeq) return;
    desktopWidgetChanged = false;
    if (!settings.ok) {
      if (desktopWidgetAuthoritativeValue !== undefined) {
        patch({ desktopWidget: desktopWidgetAuthoritativeValue });
      }
      return;
    }
    const widgetEnabled = readHostBooleanSetting(settings.value, "widgetEnabled");
    if (widgetEnabled !== undefined) {
      desktopWidgetAuthoritativeValue = widgetEnabled;
      patch({ desktopWidget: widgetEnabled });
    } else if (desktopWidgetAuthoritativeValue !== undefined) {
      patch({ desktopWidget: desktopWidgetAuthoritativeValue });
    }
  }

  function pending(control: string): boolean {
    return pendingControls.includes(control);
  }

  function beginPending(control: string): void {
    pendingControls = [...pendingControls, control];
  }

  function endPending(control: string): void {
    pendingControls = pendingControls.filter((item) => item !== control);
    if (pendingControls.length === 0 && nativeReconcileAfterWrites) {
      nativeReconcileAfterWrites = false;
      void refreshNativeSettings();
    }
  }

  function actionableError(subject: string, detail?: string): string {
    return `${subject} wasn’t saved${detail ? `: ${detail}` : "."} Try again.`;
  }

  function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
    return typeof raw[key] === "boolean" ? raw[key] : fallback;
  }

  function readNativeSettings(raw: unknown): NativeSettings {
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const meeting =
      rec.meetingDetectNotify && typeof rec.meetingDetectNotify === "object"
        ? (rec.meetingDetectNotify as Record<string, unknown>)
        : {};
    const platforms = Array.isArray(meeting.platforms)
      ? meeting.platforms.filter((item): item is string => typeof item === "string")
      : DEFAULT_NATIVE_SETTINGS.meetingPlatforms;
    return {
      startAtLogin: readBoolean(rec, "startAtLogin", native.startAtLogin),
      syncOnLaunch: readBoolean(rec, "syncOnLaunch", native.syncOnLaunch),
      realtimeSync: readBoolean(rec, "realtimeSync", native.realtimeSync),
      instantSync: readBoolean(rec, "instantSync", native.instantSync),
      personalSyncEnabled: readBoolean(
        rec,
        "personalSyncEnabled",
        native.personalSyncEnabled,
      ),
      notifications: readBoolean(rec, "notifications", native.notifications),
      shareNotifications: readBoolean(
        rec,
        "shareNotifications",
        native.shareNotifications,
      ),
      dmNotifications: readBoolean(
        rec,
        "dmNotifications",
        native.dmNotifications,
      ),
      autoUpdate: readBoolean(rec, "autoUpdate", native.autoUpdate),
      meetingDetection: readBoolean(meeting, "enabled", native.meetingDetection),
      meetingPlatforms: platforms,
      defaultRecordingCompanyUid:
        typeof rec.defaultRecordingCompanyUid === "string" &&
        rec.defaultRecordingCompanyUid.trim()
          ? rec.defaultRecordingCompanyUid.trim()
          : null,
    };
  }

  function hydrateNativeSettings(raw: unknown): void {
    const next = readNativeSettings(raw);
    // Memberships arrive after identity. While that request is pending or has
    // failed, preserve the authoritative value rather than lying "Personal".
    if (
      companies !== null &&
      next.defaultRecordingCompanyUid &&
      !recordingCompanies.some(
        (company) => company.id === next.defaultRecordingCompanyUid,
      )
    ) {
      next.defaultRecordingCompanyUid = null;
    }
    native = next;
    nativeLoaded = true;
  }

  $effect(() => {
    // Revalidate once — and only once — membership data has authoritatively
    // settled. A stale/foreign value behaves as Personal in both the selector
    // and the invite guard; pending membership data never clears the UI value.
    if (
      !nativeLoaded ||
      companies === null ||
      !native.defaultRecordingCompanyUid ||
      recordingCompanies.some((company) => company.id === native.defaultRecordingCompanyUid)
    ) {
      return;
    }
    native = { ...native, defaultRecordingCompanyUid: null };
  });

  async function refreshNativeSettings(): Promise<void> {
    if (!adapter) return;
    const generation = ++nativeReadGeneration;
    const result = await adapter.settings.getSettings();
    if (generation !== nativeReadGeneration || !result.ok) {
      if (!result.ok && !nativeLoaded) {
        nativeError = actionableError("Settings", result.message);
      }
      return;
    }
    hydrateNativeSettings(result.value);
    hydrateHostBackedToggles(result.value);
    if (adapter.isAvailable("canSync")) {
      customHqRoot = readCustomHqRoot(result.value);
      hqFolder = customHqRoot ?? readFolderFromSettings(result.value) ?? hqFolder;
    }
  }

  async function persistNative<K extends keyof NativeSettings>(
    control: string,
    patchValue: Record<string, unknown>,
    field: K,
    previous: NativeSettings[K],
  ): Promise<boolean> {
    if (!adapter || pending(control)) return false;
    // Any host read that began before this mutation is stale. A post-write
    // reconciliation runs only after all independent controls have settled.
    nativeReadGeneration += 1;
    nativeReconcileAfterWrites = true;
    beginPending(control);
    nativeError = null;
    const saved = await adapter.settings.updateSettings(patchValue);
    endPending(control);
    if (saved.ok) return true;
    native = { ...native, [field]: previous };
    nativeError = actionableError(control, saved.message);
    return false;
  }

  async function toggleNativeBoolean(
    control: string,
    key:
      | "syncOnLaunch"
      | "personalSyncEnabled"
      | "notifications"
      | "shareNotifications"
      | "dmNotifications"
      | "autoUpdate",
  ): Promise<void> {
    const previous = { ...native };
    const value = !native[key];
    native = { ...native, [key]: value };
    const saved = await persistNative(control, { [key]: value }, key, previous[key]);
    if (saved && key === "personalSyncEnabled") {
      window.dispatchEvent(
        new CustomEvent("hq:workspace-sync-enabled-changed", {
          detail: { slug: "personal", enabled: value },
        }),
      );
    }
  }

  async function toggleRealtimeSync(): Promise<void> {
    if (!adapter || pending("auto-sync")) return;
    const previous = { ...native };
    const next = !previous.realtimeSync;
    native = { ...native, realtimeSync: next };
    nativeReadGeneration += 1;
    nativeReconcileAfterWrites = true;
    beginPending("auto-sync");
    nativeError = null;
    const live = await (next ? adapter.sync.startDaemon() : adapter.sync.stopDaemon());
    if (!live.ok) {
      native = { ...native, realtimeSync: previous.realtimeSync };
      nativeError = actionableError("Auto-sync", live.message);
      endPending("auto-sync");
      return;
    }
    const saved = await adapter.settings.updateSettings({ realtimeSync: next });
    if (!saved.ok) {
      native = { ...native, realtimeSync: previous.realtimeSync };
      nativeError = actionableError("Auto-sync", saved.message);
      await (previous.realtimeSync
        ? adapter.sync.startDaemon()
        : adapter.sync.stopDaemon());
    }
    endPending("auto-sync");
  }

  async function toggleInstantSync(): Promise<void> {
    if (!adapter || pending("instant-sync")) return;
    const previous = { ...native };
    const next = !previous.instantSync;
    native = { ...native, instantSync: next };
    nativeReadGeneration += 1;
    nativeReconcileAfterWrites = true;
    beginPending("instant-sync");
    nativeError = null;
    const saved = await adapter.settings.updateSettings({ instantSync: next });
    if (saved.ok && previous.realtimeSync) {
      const stopped = await adapter.sync.stopDaemon();
      const started = stopped.ok ? await adapter.sync.startDaemon() : stopped;
      if (!started.ok) {
        native = { ...native, instantSync: previous.instantSync };
        await adapter.settings.updateSettings({ instantSync: previous.instantSync });
        await adapter.sync.startDaemon();
        nativeError = actionableError("Instant sync", started.message);
      }
    } else if (!saved.ok) {
      native = { ...native, instantSync: previous.instantSync };
      nativeError = actionableError("Instant sync", saved.message);
    }
    endPending("instant-sync");
  }

  async function toggleMeetingDetection(): Promise<void> {
    const previous = { ...native };
    const meetingDetection = !previous.meetingDetection;
    native = { ...native, meetingDetection };
    await persistNative(
      "meeting-detection",
      {
        meetingDetectNotify: {
          enabled: meetingDetection,
          platforms: native.meetingPlatforms,
        },
      },
      "meetingDetection",
      previous.meetingDetection,
    );
  }

  async function togglePlatform(id: string): Promise<void> {
    const previous = { ...native };
    const meetingPlatforms = previous.meetingPlatforms.includes(id)
      ? previous.meetingPlatforms.filter((platform) => platform !== id)
      : [...previous.meetingPlatforms, id];
    native = { ...native, meetingPlatforms };
    await persistNative(
      "meeting-platforms",
      {
        meetingDetectNotify: {
          enabled: native.meetingDetection,
          platforms: meetingPlatforms,
        },
      },
      "meetingPlatforms",
      previous.meetingPlatforms,
    );
  }

  async function setRecordingCompany(id: string): Promise<void> {
    const previous = { ...native };
    const defaultRecordingCompanyUid =
      id && recordingCompanies.some((company) => company.id === id) ? id : null;
    native = { ...native, defaultRecordingCompanyUid };
    await persistNative(
      "recording-company",
      { defaultRecordingCompanyUid },
      "defaultRecordingCompanyUid",
      previous.defaultRecordingCompanyUid,
    );
  }

  /**
   * Match host Settings UX:
   * - denied → host-owned OS Settings (OS will not re-show the dialog)
   * - prompt/unknown → requestAuthorization (system dialog when notDetermined)
   * Never auto-prompt on launch — only from this control.
   */
  async function enableNotifications(): Promise<void> {
    if (!adapter || notifRequesting) return;
    notifPermissionError = null;
    // Denied: do not flip notifRequesting into "Requesting…" — open Settings.
    if (notifPermission === "denied") {
      const opened = await adapter.appShell.openNotificationSettings();
      if (!opened.ok) {
        notifPermissionError = "Couldn’t open Notification Settings. Try again.";
      }
      return;
    }
    notifRequesting = true;
    try {
      const res = await adapter.appShell.requestNotificationPermission();
      if (res.ok) {
        notifPermission = String(res.value);
        if (res.value === "prompt") {
          notifPermissionError =
          "The system didn’t show a permission prompt. Try again, or allow HQ Work in Notification Settings.";
        }
      } else {
        console.error(
          "Failed to request notification permission:",
          res.message,
        );
        notifPermissionError =
          "Couldn’t request notification permission. Try again.";
      }
    } catch (err) {
      console.error("Failed to request notification permission:", err);
      notifPermissionError =
        "Couldn’t request notification permission. Try again.";
    } finally {
      notifRequesting = false;
    }
  }

  async function refreshNotifPermission(): Promise<void> {
    if (!adapter) return;
    const res = await adapter.appShell.notificationPermissionState();
    if (res.ok) notifPermission = String(res.value);
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function probeFailure(value: unknown): string | null {
    const probe = asRecord(value);
    if (probe?.status !== "failed") return null;
    const detail = typeof probe.message === "string" ? probe.message.trim() : "";
    return detail || "The native version probe failed.";
  }

  async function refreshVersions(): Promise<void> {
    if (!adapter || !adapter.isAvailable("canSelfUpdate")) return;
    const updates = adapter.updates;
    const orchAdapter = {
      getVersions: () =>
        updates.getVersions() as Promise<AdapterResult<Record<string, unknown>>>,
      checkForUpdates: () =>
        updates.checkForUpdates() as Promise<AdapterResult<unknown>>,
      checkCoreState: () =>
        updates.checkCoreState() as Promise<AdapterResult<unknown>>,
      checkCliUpdate: () =>
        updates.checkCliUpdate() as Promise<AdapterResult<unknown>>,
    };
    // Focus / wake events must not pile up concurrent scans. A second call
    // while one is in flight shares the same promise and does not bump the
    // generation (which would strand the first caller's busy flag).
    if (updateCheckRunner.isRunning()) {
      await updateCheckRunner.run(orchAdapter);
      return;
    }
    const generation = ++versionsReadGeneration;
    versionsRefreshing = true;
    appUpdateStatus = "checking";
    coreUpdateStatus = "checking";
    cliUpdateStatus = "checking";
    coreProbeError = null;
    cliProbeError = null;
    try {
      const refreshedAppVersion = refreshAppVersion
        ? await refreshAppVersion().catch(() => null)
        : null;
      if (generation !== versionsReadGeneration) return;
      appVersion =
        typeof refreshedAppVersion === "string" && refreshedAppVersion.trim()
          ? refreshedAppVersion.trim()
          : version;
      // ONE orchestration for every trigger (mount, focus, native events,
      // the explicit button, and a channel change). Each row commits as its
      // own check settles and every call is time-bounded, so a slow or hung
      // check can no longer pin all three rows on CHECKING forever.
      const outcome = await updateCheckRunner.run(orchAdapter, {
        onRow: (row, status) => {
          if (generation !== versionsReadGeneration) return;
          // The app row has no "unlocated" arm (there is no path to
          // locate) — fold it into "unchecked".
          if (row === "app")
            appUpdateStatus = status === "unlocated" ? "unchecked" : status;
          else if (row === "core") coreUpdateStatus = status;
          else cliUpdateStatus = status;
        },
        onVersions: (versions) => {
          if (generation !== versionsReadGeneration) return;
          coreVersion = versions.coreVersion;
          cliVersion = versions.cliVersion;
          coreProbeError = versions.coreProbeError;
          cliProbeError = versions.cliProbeError;
        },
      });
      if (generation !== versionsReadGeneration) return;
      coreVersion = outcome.coreVersion;
      cliVersion = outcome.cliVersion;
      coreProbeError = outcome.coreProbeError;
      cliProbeError = outcome.cliProbeError;
      appUpdateStatus =
        outcome.appStatus === "unlocated" ? "unchecked" : outcome.appStatus;
      coreUpdateStatus = outcome.coreStatus;
      cliUpdateStatus = outcome.cliStatus;
      channelLatestVersion = outcome.appStatus === "available" ? channelLatestVersion : null;
    } finally {
      // Unconditional: a superseded generation, a thrown adapter, or a timed
      // out check all land here, so the pane always leaves the busy state.
      if (generation === versionsReadGeneration) versionsRefreshing = false;
    }
  }

  async function loadReleaseChannel(): Promise<void> {
    if (!adapter || !adapter.isAvailable("canSelfUpdate")) return;
    const [available, settings] = await Promise.all([
      adapter.updates.availableChannels().catch(() => null),
      adapter.settings.getSettings().catch(() => null),
    ]);
    availableChannels =
      available && available.ok ? (available.value as unknown) : null;
    const stored =
      settings && settings.ok
        ? (settings.value as Record<string, unknown> | null)
        : null;
    releaseChannelPref = normalizeChannel(stored?.releaseChannel);
    effectiveChannel = releaseChannelPref;
  }

  async function selectReleaseChannel(next: string): Promise<void> {
    const channel = normalizeChannel(next);
    if (!adapter || !channel || channel === selectedReleaseChannel) return;
    channelSaving = true;
    channelError = null;
    const previous = releaseChannelPref;
    releaseChannelPref = channel;
    try {
      const saved = await adapter.settings.updateSettings({
        releaseChannel: channel,
      });
      if (!saved.ok) {
        releaseChannelPref = previous;
        channelError = "Couldn’t save the release channel.";
        return;
      }
      // Re-check immediately on the new channel so the rows reflect it.
      await refreshVersions();
    } finally {
      channelSaving = false;
    }
  }

  async function chooseHqFolder(): Promise<void> {
    if (!adapter || pending("hq-folder")) return;
    beginPending("hq-folder");
    nativeError = null;
    const picked = await adapter.shell.pickFolder();
    if (!picked.ok) {
      nativeError = actionableError("HQ folder", picked.message);
      endPending("hq-folder");
      return;
    }
    if (!picked.value) {
      endPending("hq-folder");
      return;
    }
    const saved = await adapter.settings.updateSettings({ hqPath: picked.value });
    if (!saved.ok) {
      nativeError = actionableError("HQ folder", saved.message);
    } else {
      hqFolder = picked.value;
      customHqRoot = picked.value;
      await refreshVersions();
    }
    endPending("hq-folder");
  }

  function readFolderFromSettings(raw: unknown): string | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    for (const key of [
      "hqPath",
      "hqFolderPath",
      "hq_folder_path",
      "hqFolder",
      "folder",
      "hqRoot",
    ] as const) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  function readCustomHqRoot(raw: unknown): string | null {
    if (!raw || typeof raw !== "object") return null;
    const value = (raw as Record<string, unknown>).hqPath;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function readHostBooleanSetting(
    raw: unknown,
    key: "dockIcon" | "widgetEnabled",
  ): boolean | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const value = (raw as Record<string, unknown>)[key];
    return typeof value === "boolean" ? value : undefined;
  }

  function hydrateHostBackedToggles(raw: unknown): void {
    const next: Partial<
      Pick<ShellSettingsPrefs, "showInDock" | "desktopWidget">
    > = {};
    const dockIcon = readHostBooleanSetting(raw, "dockIcon");
    if (dockIcon !== undefined) {
      dockAuthoritativeValue = dockIcon;
      if (!dockVisibilityChanged) next.showInDock = dockIcon;
    }
    const widgetEnabled = readHostBooleanSetting(raw, "widgetEnabled");
    if (widgetEnabled !== undefined) {
      desktopWidgetAuthoritativeValue = widgetEnabled;
      if (!desktopWidgetChanged) next.desktopWidget = widgetEnabled;
    }
    if (Object.keys(next).length > 0) patch(next);
  }

  function ensureMeetingsApi(): boolean {
    if (!adapter) return false;
    configureMeetingsApi({
      meetings: adapter.meetings,
      feedback: adapter.feedback,
      settings: adapter.settings,
      storage,
      sessionGeneration,
    });
    return true;
  }

  async function openExternalUrl(url: string): Promise<void> {
    if (onopenconsole) {
      await onopenconsole(url);
      return;
    }
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      throw new Error(
        "Popup blocked — allow popups for this site and try again.",
      );
    }
  }

  async function openIntegrationsConsole(): Promise<void> {
    try {
      await openExternalUrl(HQ_CONSOLE_INTEGRATIONS_URL);
    } catch (error) {
      setCalendarConnectMessage(`Couldn’t open HQ Console: ${String(error)}`, true);
    }
  }

  function setCalendarConnectMessage(text: string, warn: boolean): void {
    calendarConnectMessage = text;
    calendarConnectWarn = warn;
  }

  /** Primary: in-app Google OAuth via adapter.meetings.connectCalendar(). */
  async function connectCalendars(): Promise<void> {
    if (
      !ensureMeetingsApi() ||
      calendarConnectStarting ||
      calendarConnectPending
    ) {
      return;
    }
    calendarConnectStarting = true;
    try {
      const result = await meetingsStore.beginCalendarConnect();
      if (result.toast) {
        setCalendarConnectMessage(
          result.toast.text,
          result.toast.kind === "warn",
        );
      }
      if (result.url) {
        try {
          await openExternalUrl(result.url);
        } catch (err) {
          meetingsStore.stopCalendarConnectWatch();
          setCalendarConnectMessage(
            `Couldn't open the browser: ${String(err)}`,
            true,
          );
        }
      }
    } finally {
      calendarConnectStarting = false;
    }
  }

  function accountsToRows(
    accts: Array<{ accountId?: string | null; email?: string | null }>,
  ): ConnectedCalendarAccount[] {
    return accts
      .filter(
        (a): a is { accountId: string; email?: string | null } =>
          typeof a.accountId === "string" && a.accountId.length > 0,
      )
      .map((a) => ({
        accountId: a.accountId,
        label: calendarAccountLabel(a),
      }));
  }

  function refreshCalendarLabelsFromStore(): void {
    connectedAccounts = accountsToRows(meetingsStore.accounts);
  }

  /** Per-account revoke via store; confirm first to avoid one-click revoke. */
  async function disconnectCalendar(accountId: string): Promise<void> {
    if (
      !accountId ||
      !ensureMeetingsApi() ||
      calendarDisconnectingId === accountId
    ) {
      return;
    }
    const confirmed = window.confirm(
      "Disconnect this Google calendar from HQ? You can reconnect later.",
    );
    if (!confirmed) return;

    const prior = connectedAccounts;
    connectedAccounts = connectedAccounts.filter(
      (row) => row.accountId !== accountId,
    );
    calendarDisconnectingId = accountId;
    try {
      const result = await meetingsStore.disconnectCalendar(accountId);
      if (!result || result.kind === "warn") {
        connectedAccounts = prior;
        if (result?.kind === "warn") {
          setCalendarConnectMessage(result.text, true);
        }
        return;
      }
      refreshCalendarLabelsFromStore();
      setCalendarConnectMessage(result.text, false);
    } finally {
      calendarDisconnectingId = null;
    }
  }

  // Async connect-watch completion (new account or bounded timeout).
  $effect(() => {
    const notice = meetingsStore.connectNotice;
    if (!notice) return;
    setCalendarConnectMessage(notice.text, notice.kind === "warn");
    meetingsStore.clearConnectNotice();
    refreshCalendarLabelsFromStore();
  });

  $effect(() => {
    // Native update events are delivered by the desktop shell. The initial
    // zero is handled on mount; later values refresh each status independently.
    if (updateWakeSeq > 0) void refreshVersions();
  });

  onMount(() => {
    applyUiSize(prefs.uiSize);
    applyWindowOpacity(prefs.windowOpacity);
    if (adapter?.isAvailable("canSync")) {
      void readLiveSyncStatus(adapter).then((next) => {
        liveSync = next;
        if (next.hqFolderPath && !customHqRoot) hqFolder = next.hqFolderPath;
      });
    }
    if (!adapter) return;
    void refreshNotifPermission();
    // Re-read after returning from System Settings (v1 SettingsPage pattern).
    const onFocus = () => {
      void refreshNotifPermission();
      void refreshNativeSettings();
      void refreshVersions();
    };
    window.addEventListener("focus", onFocus);
    void adapter.meetings.listAccounts().then((res) => {
      if (!res.ok || !Array.isArray(res.value)) return;
      connectedAccounts = accountsToRows(
        res.value as Array<{
          accountId?: string | null;
          email?: string | null;
        }>,
      );
    });
    void refreshVersions();
    void loadReleaseChannel();
    void refreshNativeSettings();
    if (adapter.isAvailable("canSync")) {
      void adapter.settings.getConfig().then((res) => {
        if (res.ok && !customHqRoot) {
          hqFolder = readFolderFromSettings(res.value) ?? hqFolder;
        }
      });
    }
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  });
</script>

<div class="proto" data-testid={`settings-${section}-pane`}>
  {#if nativeError}
    <p class="settings-error" role="alert" data-testid="settings-native-error">
      {nativeError}
    </p>
  {/if}
  {#if section === "general"}
    {#if canTray}
      <div class="set-row">
        <div>
          <div class="sn">Launch at login</div>
          <div class="sd">Start HQ when you sign in to your Mac</div>
        </div>
        <button type="button" class="toggle" class:on={native.startAtLogin} role="switch" aria-checked={native.startAtLogin} aria-label="Launch at login" aria-busy={pending("launch")} disabled={!nativeLoaded || pending("launch")} onclick={() => void toggleLaunch()}></button>
      </div>
      <div class="set-row">
        <div><div class="sn">Show in Dock</div><div class="sd">Keep HQ in the Dock and ⌘-Tab switcher</div></div>
        <button type="button" class="toggle" class:on={prefs.showInDock} role="switch" aria-checked={prefs.showInDock} aria-label="Show in Dock" onclick={() => void toggleDock()}></button>
      </div>
      <div class="set-row unavailable" data-testid="settings-menubar-unavailable">
        <div><div class="sn">Menubar quick access</div><div class="sd">Managed by the native HQ popover in this release; this embedded screen cannot change it.</div></div>
        <span class="mono">HOST-OWNED</span>
      </div>
      <div class="set-row">
        <div><div class="sn">Desktop widget</div><div class="sd">Float the mini notifications widget on your desktop</div></div>
        <button type="button" class="toggle" class:on={prefs.desktopWidget} role="switch" aria-checked={prefs.desktopWidget} aria-label="Desktop widget" onclick={() => void toggleDesktopWidget()}></button>
      </div>
    {/if}
    <AvatarPackSettings {storage} />
  {:else if section === "appearance"}
    <p class="settings-note">These choices apply only to this embedded HQ Work window. They do not change macOS or other HQ surfaces.</p>
    <div class="set-row">
      <div><div class="sn">Theme</div><div class="sd">Appearance for this embedded Work view</div></div>
      <div class="theme-pills" role="radiogroup" aria-label="Color theme">
        {#each APPEARANCE_THEMES as option (option.id)}
          <button type="button" class="chip" class:on={theme === option.id} role="radio" aria-checked={theme === option.id} data-testid={`settings-theme-${option.id}`} onclick={() => setTheme(option.id)}>{option.label}</button>
        {/each}
      </div>
    </div>
    {#if canTray}
      <div class="set-row">
        <div><div class="sn">Window opacity</div><div class="sd">Visual treatment for this embedded Work view</div></div>
        <div class="range-wrap"><input type="range" min="50" max="100" value={prefs.windowOpacity} aria-label="Window opacity" oninput={(event) => setOpacity(Number(event.currentTarget.value))} /><span class="mono range-val">{prefs.windowOpacity}%</span></div>
      </div>
    {/if}
    <div class="set-row">
      <div><div class="sn">Interface size</div><div class="sd">Density in this embedded Work view</div></div>
      <div class="theme-pills" role="radiogroup" aria-label="Interface size">
        {#each APPEARANCE_SIZES as option (option.id)}
          <button type="button" class="chip" class:on={prefs.uiSize === option.id} role="radio" aria-checked={prefs.uiSize === option.id} onclick={() => setUiSize(option.id)}>{option.label}</button>
        {/each}
      </div>
    </div>
  {:else if section === "notifications"}
    {#if canSync}
      <div class="set-row"><div><div class="sn">Meeting notifications</div><div class="sd">Show native alerts for detected and unattributed meetings</div></div><button type="button" class="toggle" class:on={native.notifications} role="switch" aria-checked={native.notifications} aria-label="Meeting notifications" disabled={!nativeLoaded || pending("meeting-notifications")} onclick={() => void toggleNativeBoolean("meeting-notifications", "notifications")}></button></div>
    {/if}
    <div class="set-row"><div><div class="sn">Share notifications</div><div class="sd">Show file-share activity from teammates</div></div><button type="button" class="toggle" class:on={native.shareNotifications} role="switch" aria-checked={native.shareNotifications} aria-label="Share notifications" disabled={!nativeLoaded || pending("share-notifications")} onclick={() => void toggleNativeBoolean("share-notifications", "shareNotifications")}></button></div>
    <div class="set-row"><div><div class="sn">DM notifications</div><div class="sd">Show direct-message activity in the native HQ surfaces</div></div><button type="button" class="toggle" class:on={native.dmNotifications} role="switch" aria-checked={native.dmNotifications} aria-label="DM notifications" disabled={!nativeLoaded || pending("dm-notifications")} onclick={() => void toggleNativeBoolean("dm-notifications", "dmNotifications")}></button></div>
    {#if canTray && notifPermission && notifPermission !== "unknown" && notifPermission !== "unsupported"}
      <div class="set-row">
        <div><div class="sn">System permission</div><div class="sd">{notifPermission === "granted" ? "Your system is allowing notifications from HQ" : notifPermission === "denied" ? "Blocked by system settings — open Notification Settings to allow" : "Not enabled yet — allow to see message alerts"}{#if notifPermissionError}<div class="sd" role="alert" data-testid="settings-notification-permission-error">{notifPermissionError}</div>{/if}</div></div>
        {#if notifPermission === "granted"}<span class="mono ok">Enabled</span>{:else}<button type="button" class="chip" onclick={() => void enableNotifications()} disabled={notifRequesting} aria-busy={notifRequesting}>{notifRequesting ? "Requesting…" : notifPermissionError ? "Try again" : notifPermission === "denied" ? "Open Settings" : "Enable"}</button>{/if}
      </div>
    {/if}
  {:else if section === "sync" && canSync}
    <div class="set-row">
      <div>
        <div class="sn">HQ folder</div>
        <div class="sd mono-path">{formatHqFolderMeta(hqFolder) || "Not located"}</div>
      </div>
      <button type="button" class="chip quiet" onclick={() => void chooseHqFolder()} disabled={pending("hq-folder")}>{pending("hq-folder") ? "Choosing…" : "Choose…"}</button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Sync daemon</div>
        <div class="sd">
          The same hq-sync-runner v1 HQ Sync already supervises
        </div>
      </div>
      <span class="mono" class:ok={liveSync.daemonRunning}
        >{liveSync.daemonRunning ? "RUNNING" : "STOPPED"}</span
      >
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Last sync</div>
        <div class="sd">
          {#if liveSync.conflicts > 0}
            {liveSync.conflicts} conflict{liveSync.conflicts === 1 ? "" : "s"} need
            a keep-local / keep-cloud choice
          {:else}
            From {liveSync.source === "none"
              ? "no journal yet"
              : "the v1 journal"}
          {/if}
        </div>
      </div>
      <span class="mono">{lastSyncLabelFromLive(liveSync) ?? "Never"}</span>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Sync on launch</div>
        <div class="sd">Run a sync when the app starts</div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={native.syncOnLaunch}
        role="switch"
        aria-checked={native.syncOnLaunch}
        aria-label="Sync on launch"
        disabled={!nativeLoaded || pending("sync-on-launch")}
        onclick={() => void toggleNativeBoolean("sync-on-launch", "syncOnLaunch")}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Auto-sync</div>
        <div class="sd">Sync every few minutes in the background</div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={native.realtimeSync}
        role="switch"
        aria-checked={native.realtimeSync}
        aria-label="Auto-sync"
        disabled={!nativeLoaded || pending("auto-sync")}
        onclick={() => void toggleRealtimeSync()}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Instant sync</div>
        <div class="sd">Push local edits within seconds</div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={native.instantSync}
        role="switch"
        aria-checked={native.instantSync}
        aria-label="Instant sync"
        disabled={!nativeLoaded || pending("instant-sync")}
        onclick={() => void toggleInstantSync()}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Sync personal vault</div>
        <div class="sd">Include personal HQ files in the fanout</div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={native.personalSyncEnabled}
        role="switch"
        aria-checked={native.personalSyncEnabled}
        aria-label="Sync personal vault"
        disabled={!nativeLoaded || pending("personal-sync")}
        onclick={() => void toggleNativeBoolean("personal-sync", "personalSyncEnabled")}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Companies on this machine</div>
        <div class="sd">
          {lists.active.length} membership{lists.active.length === 1 ? "" : "s"}
        </div>
      </div>
      <span class="mono">{lists.active.length} ACTIVE</span>
    </div>
  {:else if section === "meetings"}
    {#if canWatchMeetings}
      <div class="set-row">
        <div>
          <div class="sn">Detected-meeting alerts</div>
          <div class="sd">
            Show a native alert when a meeting is detected
          </div>
        </div>
        <button
          type="button"
          class="toggle"
          class:on={native.meetingDetection}
          role="switch"
          aria-checked={native.meetingDetection}
          aria-label="Detected-meeting alerts"
          disabled={!nativeLoaded || pending("meeting-detection") || pending("meeting-platforms")}
          onclick={() => void toggleMeetingDetection()}
        ></button>
      </div>
      <div class="set-row">
        <div>
          <div class="sn">Alert sources</div>
          <div class="sd">Which detected meeting apps may show native alerts</div>
        </div>
        <div class="theme-pills">
          {#each MEETING_PLATFORMS as platform (platform.id)}
            <button
              type="button"
              class="chip"
              class:on={native.meetingPlatforms.includes(platform.id)}
              aria-pressed={native.meetingPlatforms.includes(platform.id)}
              disabled={!nativeLoaded || pending("meeting-detection") || pending("meeting-platforms")}
              onclick={() => void togglePlatform(platform.id)}
            >
              {platform.label}
            </button>
          {/each}
        </div>
      </div>
    {/if}
    <div class="set-row">
      <div>
        <div class="sn">Recording company</div>
        <div class="sd">
          Attribution for new recordings — changeable per recording
        </div>
      </div>
      {#if !nativeLoaded}
        <span class="mono" data-testid="recording-company-unavailable">Settings unavailable</span>
      {:else if companies === null}
        <span class="mono" data-testid="recording-company-membership-pending">Memberships loading…</span>
      {:else if recordingCompanies.length > 0}
        <label class="sr-only" for="recording-company">Recording company</label>
        <select
          id="recording-company"
          class="mono-select"
          value={native.defaultRecordingCompanyUid ?? ""}
          disabled={!nativeLoaded || pending("recording-company")}
          onchange={(event) => void setRecordingCompany(event.currentTarget.value)}
        >
          <option value="">Personal</option>
          {#each recordingCompanies as row (row.id)}
            <option value={row.id}>{row.name}</option>
          {/each}
        </select>
      {:else}
        <span class="mono" data-testid="recording-company-personal">Personal</span>
      {/if}
    </div>
    {#if connectedAccounts.length > 0}
      {#each connectedAccounts as row (row.accountId)}
        {@const disconnecting =
          calendarDisconnectingId === row.accountId ||
          meetingsStore.disconnectPendingByAccountId.has(row.accountId)}
        <div class="set-row">
          <div>
            <div class="sn">{row.label}</div>
            <div class="sd">Connected calendar</div>
          </div>
          <div class="connect-actions">
            <span class="mono ok">On</span>
            <button
              type="button"
              class="chip quiet"
              data-testid="settings-disconnect-calendar"
              data-account-id={row.accountId}
              onclick={() => void disconnectCalendar(row.accountId)}
              disabled={disconnecting}
              aria-busy={disconnecting}
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      {/each}
    {/if}
    <div class="set-row">
      <div>
        <div class="sn">Connect calendars</div>
        <div class="sd">
          {#if calendarConnectMessage}
            <span class:connect-warn={calendarConnectWarn}
              >{calendarConnectMessage}</span
            >
          {:else}
            Google Calendar via in-app OAuth
          {/if}
        </div>
      </div>
      <div class="connect-actions">
        <button
          type="button"
          class="chip"
          data-testid="settings-connect-calendar"
          onclick={() => void connectCalendars()}
          disabled={calendarConnectStarting || calendarConnectPending}
          aria-busy={calendarConnectStarting || calendarConnectPending}
        >
          {calendarConnectPending
            ? "Waiting…"
            : calendarConnectStarting
              ? "Connecting…"
              : "Connect calendar"}
        </button>
        <button
          type="button"
          class="chip quiet"
          data-testid="settings-manage-console"
          onclick={() => void openIntegrationsConsole()}
        >
          Manage in console
        </button>
      </div>
    </div>
  {:else if section === "updates" && canSelfUpdate}
    <div class="set-row">
      <div>
        <div class="sn">Automatic updates</div>
        <div class="sd">
          Allow the native host to install eligible desktop app, HQ Core, and CLI updates in the background
        </div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={native.autoUpdate}
        role="switch"
        aria-checked={native.autoUpdate}
        aria-label="Automatic updates"
        disabled={!nativeLoaded || pending("automatic-updates")}
        onclick={() => void toggleNativeBoolean("automatic-updates", "autoUpdate")}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Desktop app</div>
        <div class="sd mono-path">v{appVersion}</div>
        {#if appUpdateStatus === "failed"}
          <div class="sd" data-testid="settings-app-check-failed">
            The update check didn’t finish. Check for updates again.
          </div>
        {/if}
      </div>
      <span class="mono" class:ok={appUpdateStatus === "up-to-date"}>{appUpdateStatus === "checking" ? "CHECKING" : appUpdateStatus === "available" ? "UPDATE AVAILABLE" : appUpdateStatus === "up-to-date" ? "UP TO DATE" : appUpdateStatus === "failed" ? "CHECK FAILED" : "NOT CHECKED"}</span>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">HQ Core</div>
        <div class="sd mono-path">
          {coreVersion
            ? `v${coreVersion}`
            : coreUpdateStatus === "checking"
              ? "Checking installed location…"
              : coreUpdateStatus === "unlocated"
                ? "HQ root is required"
                : coreUpdateStatus === "failed"
                  ? "Version probe failed"
                  : "Version unavailable"}
        </div>
        {#if coreUpdateStatus === "unlocated"}
          <div class="sd" data-testid="settings-core-remediation">Choose the HQ root above (or set hqPath/hqFolderPath), then refresh.</div>
        {:else if coreUpdateStatus === "failed"}
          <div class="sd">Core version probe failed: {coreProbeError ?? "The check did not finish. Try again."}</div>
        {:else if coreUpdateStatus === "unchecked"}
          <div class="sd">Core update status could not be checked{coreProbeError ? `: ${coreProbeError}` : ""}. Refresh and verify your connection.</div>
        {/if}
      </div>
      <span class="mono" class:ok={coreUpdateStatus === "up-to-date"}>{coreUpdateStatus === "checking" ? "CHECKING" : coreUpdateStatus === "available" ? "UPDATE AVAILABLE" : coreUpdateStatus === "up-to-date" ? "UP TO DATE" : coreUpdateStatus === "unlocated" ? "ROOT NEEDED" : coreUpdateStatus === "failed" ? "CHECK FAILED" : "NOT CHECKED"}</span>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">HQ CLI</div>
        <div class="sd mono-path">
          {cliVersion
            ? `v${cliVersion}`
            : cliUpdateStatus === "checking"
              ? "Checking installed location…"
              : cliUpdateStatus === "unlocated"
                ? "CLI path is required"
                : cliUpdateStatus === "failed"
                  ? "Version probe failed"
                  : "Version unavailable"}
        </div>
        {#if cliUpdateStatus === "unlocated"}
          <div class="sd" data-testid="settings-cli-remediation">Add the CLI directory to this HQ root’s .claude/settings.local.json (or settings.json) env.PATH, then refresh. The host uses that Claude settings PATH before broader PATH locations.</div>
        {:else if cliUpdateStatus === "failed"}
          <div class="sd">CLI version probe failed: {cliProbeError ?? "The check did not finish. Try again."}</div>
        {:else if cliUpdateStatus === "unchecked"}
          <div class="sd">CLI update status could not be checked{cliProbeError ? `: ${cliProbeError}` : ""}. Refresh and verify your connection.</div>
        {/if}
      </div>
      <span class="mono" class:ok={cliUpdateStatus === "up-to-date"}>{cliUpdateStatus === "checking" ? "CHECKING" : cliUpdateStatus === "available" ? "UPDATE AVAILABLE" : cliUpdateStatus === "up-to-date" ? "UP TO DATE" : cliUpdateStatus === "unlocated" ? "CLI NEEDED" : cliUpdateStatus === "failed" ? "CHECK FAILED" : "NOT CHECKED"}</span>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Release channel</div>
        <div class="sd">
          {releaseChannelOptions.find((o) => o.id === selectedReleaseChannel)?.hint ??
            "Released builds only."}
        </div>
        {#if channelDowngrade.isDowngrade}
          <div class="sd" data-testid="settings-channel-downgrade">
            {channelDowngrade.message}
          </div>
        {/if}
        {#if channelError}
          <div class="sd" role="alert" data-testid="settings-channel-error">{channelError}</div>
        {/if}
      </div>
      <select
        class="chip"
        data-testid="settings-release-channel"
        aria-label="Release channel"
        aria-busy={channelSaving}
        disabled={channelSaving || versionsRefreshing || releaseChannelOptions.length <= 1}
        value={selectedReleaseChannel}
        onchange={(e) =>
          void selectReleaseChannel((e.currentTarget as HTMLSelectElement).value)}
      >
        {#each releaseChannelOptions as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </select>
    </div>
    <div class="set-row">
      <div><div class="sn">Update status</div><div class="sd">Refreshes on window focus and native app, Core, or CLI update events.</div></div>
      <button
        type="button"
        class="chip"
        data-testid="settings-check-for-updates"
        onclick={() => void refreshVersions()}
        disabled={versionsRefreshing}
        aria-busy={versionsRefreshing}
      >{versionsRefreshing ? "Checking…" : "Check for updates"}</button>
    </div>
  {/if}
</div>

<style>
  .proto {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 640px;
  }

  .settings-error,
  .settings-note {
    margin: 0;
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.4;
  }

  .settings-error {
    border: 1px solid color-mix(in srgb, #ef4444 45%, var(--line));
    color: #fecaca;
    background: color-mix(in srgb, #7f1d1d 28%, var(--raised));
  }

  .settings-note,
  .set-row.unavailable {
    color: var(--t3);
    background: color-mix(in srgb, var(--raised) 72%, transparent);
  }

  .set-row {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
  }

  .sn {
    font-weight: 500;
    font-size: 13px;
    color: var(--t1);
  }

  .sd {
    margin-top: 2px;
    color: var(--t3);
    font-size: 11px;
  }

  .sd.mono-path {
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.02em;
  }

  .mono {
    margin-left: auto;
    color: var(--ice-ink, #c9d6e4);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
  }

  .mono.ok {
    color: var(--ok);
  }

  .mono-select {
    margin-left: auto;
    appearance: none;
    -webkit-appearance: none;
    padding: 4px 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--ice-ink, #c9d6e4);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .toggle {
    margin-left: auto;
    width: 34px;
    height: 20px;
    border: none;
    border-radius: 10px;
    background: var(--line2);
    position: relative;
    flex-shrink: 0;
    cursor: pointer;
    padding: 0;
  }

  .toggle::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--t2);
    transition: all 0.15s;
  }

  .toggle.on {
    background: #2a3644;
  }

  .toggle.on::after {
    left: 17px;
    background: var(--ice, #c9d6e4);
  }

  .theme-pills {
    margin-left: auto;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .chip {
    padding: 3px 10px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: none;
    color: var(--t2);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .chip.on {
    /* --ice-ink flips per theme; the flat --ice is invisible on light. */
    color: var(--ice-ink, #c9d6e4);
    border-color: var(--ice-ink, #2a3644);
  }

  .chip.quiet {
    color: var(--t3);
    border-color: transparent;
  }

  .chip:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .connect-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .connect-warn {
    color: var(--warn, #e8b84a);
  }

  .range-wrap {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .range-wrap input[type="range"] {
    width: 120px;
    accent-color: var(--ice-ink, #c9d6e4);
  }

  .range-val {
    margin-left: 0;
    min-width: 2.6em;
    text-align: right;
  }
</style>
