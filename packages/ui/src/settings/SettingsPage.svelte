<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import type { AdapterResult, PlatformAdapter } from "@hq/platform";
  import type {
    SettingsPatch,
    SettingsUpdater,
  } from "../common/settings-write";
  import UnavailableNote from "../common/UnavailableNote.svelte";
  import { isMac } from "../common/platform";
  import {
    formatHqFolderMeta,
    SETTINGS_SECTIONS,
    type SettingsTab,
  } from "./settings-sections";
  import {
    resolvePendingUpdateState,
    type PendingUpdateState,
    type UpdaterBus,
    type UpdateInfo,
  } from "./pending-update";
  import {
    MAX_DESKTOP_ZOOM,
    MIN_DESKTOP_ZOOM,
    windowOpacityFromTransparency,
    windowTransparencyFromOpacity,
    type AppearancePreferences,
    type AppearanceSeam,
    type ZoomSeam,
  } from "./appearance-seam";
  import { appearanceThemeOptions } from "./shell-settings-model";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";

  /** Banner title for the pack-update notice. Singular/plural aware. */
  function packUpdateTitle(count: number): string {
    return count === 1
      ? "1 pack has an update available"
      : `${count} packs have updates available`;
  }

  // Server-authoritative telemetry consent seam (US-003). Optional — when the
  // host does not provide it, the toggle falls back to the adapter's cached
  // consent read and labels itself as offline/local truth.
  export interface TelemetryConsentStatus {
    enabled: boolean;
    source: "server" | "local-cache";
    updatedAt: string | null;
    consentVersion: number | null;
    unset: boolean;
  }
  export interface TelemetrySeam {
    getStatus(): Promise<AdapterResult<TelemetryConsentStatus>>;
    postOptIn(args: {
      enabled: boolean;
      surface: string;
      consentVersion: number;
    }): Promise<{ uploaded: boolean }>;
    emitPreferenceChanged?(enabled: boolean): Promise<void> | void;
  }

  /** Optional meeting-permissions snapshot supplied by the desktop host. */
  export interface MeetingPermissionsState {
    allRequiredGranted: boolean;
  }

  /**
   * The telemetry consent version the client displays. Mirrors the hq-pro
   * server constant; bumping it re-asks everyone.
   */
  const TELEMETRY_CONSENT_VERSION = 1;

  // US-020 single-pane Settings: no second nav column, one section at a time.
  // `activeTab === null` renders the in-place section index; a SettingsTab
  // renders only that section with a Back affordance. Navigation goes through
  // `onnavigate` so the shell route (`settings` / `settings:<tab>`) stays the
  // source of truth for deep links and ⌘K.
  let {
    activeTab = null,
    onnavigate,
    adapter,
    updateSettings,
    updaterBus = null,
    telemetry = null,
    appearanceSeam = null,
    zoomSeam = null,
    meetingPermissions = null,
    onopenmeetingpermissions,
    onsignout,
    openExternal = (url: string) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    widgetSettings,
  }: {
    activeTab?: SettingsTab | null;
    onnavigate?: (tab: SettingsTab | null) => void;
    /** Platform seam — every backend interaction goes through this. */
    adapter: PlatformAdapter;
    /** Serialized settings write queue (see common/settings-write.ts). */
    updateSettings: SettingsUpdater;
    /** Host updater event stream replacing the desktop listen() channels. */
    updaterBus?: UpdaterBus | null;
    telemetry?: TelemetrySeam | null;
    appearanceSeam?: AppearanceSeam | null;
    zoomSeam?: ZoomSeam | null;
    /** Live macOS TCC snapshot (desktop host); null renders a checking line. */
    meetingPermissions?: MeetingPermissionsState | null;
    /** Refresh hook the host may use when the window regains focus. */
    onopenmeetingpermissions?: () => void;
    /** Sign-out intent — host owns the tray sign-out flow. */
    onsignout?: () => void | Promise<void>;
    openExternal?: (url: string) => void | Promise<void>;
    /** Desktop widget settings panel (host-injected; unavailable note otherwise). */
    widgetSettings?: Snippet;
  } = $props();

  const _activeSection = $derived(
    SETTINGS_SECTIONS.find((section) => section.id === activeTab) ?? null,
  );
  void _activeSection;

  // Evaluated once: the host OS cannot change while the window is open.
  const isMacOS = isMac();

  // Capability gates — desktop-only affordances degrade, never dead-button.
  const canSync = adapter.isAvailable("canSync");
  const canSelfUpdate = adapter.isAvailable("canSelfUpdate");
  const canManagePackages = adapter.isAvailable("canManagePackages");
  const canLaunchApps = adapter.isAvailable("canLaunchApps");
  const canTray = adapter.isAvailable("trayAndWindow");

  type Channel = "stable" | "beta" | "alpha";
  type Platform = "zoom" | "meet" | "teams" | "slack" | "webex";
  type SettingsControlKey =
    | "sync-on-launch"
    | "realtime-sync"
    | "instant-sync"
    | "personal-sync"
    | "sync-notifications"
    | "share-notifications"
    | "dm-notifications"
    | "auto-update"
    | "staging-channel"
    | "release-channel"
    | "start-at-login"
    | "dock-icon"
    | "meeting-detection"
    | "meeting-platforms"
    | "default-recording-company";
  type LiveControlKey =
    "realtime-sync" | "instant-sync" | "start-at-login" | "dock-icon";

  // Exact upgrade command the v0.9.8 popover copied to the clipboard.
  const HQ_CLI_UPGRADE_CMD = "npm install -g @indigoai-us/hq-cli@latest";

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
    dockIcon?: boolean | null;
  }

  type DriftEntry = {
    path: string;
    size: number;
    gitShaLocal: string | null;
    gitShaUpstream: string | null;
  };
  type DriftReport = {
    baselineStatus: "Available" | "BaselineUnavailable";
    updateRequired: boolean;
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
    channel: "release" | "staging";
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

  const platforms: Platform[] = ["zoom", "meet", "teams", "slack", "webex"];
  // The desktop shell pins a dark window (desktop main.ts forces
  // data-force-theme="dark") and its native chrome + vibrancy are tuned for
  // dark. Light/System would flip the shared tokens light while the window
  // stays dark, leaving the dark ground behind the translucent panels as an
  // unreadable grey veil. So desktop is dark-only — offer just Dark. Web keeps
  // the full System/Light/Dark choice (its ground follows the forced theme).
  const isDesktopShell = adapter.isAvailable("hasWindowControls");
  const appearanceThemes = appearanceThemeOptions(isDesktopShell);

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
  // Controls render immediately for stable layout, but must stay inert until
  // persisted preferences load successfully. Otherwise a fast click can save
  // the component defaults over the user's real settings-store values.
  let settingsReady = $state(false);
  // The host has no local settings store at all (web) — render the standard
  // unavailable state instead of forever-disabled controls.
  let settingsUnavailable = $state(false);
  let saved = $state(false);
  let error = $state<string | null>(null);
  let savedTimeout: ReturnType<typeof setTimeout> | null = null;
  let settingsSaveGeneration = 0;
  // Settings hydration can be started by mount, Retry, or window focus. Keep
  // responses monotonic so an older request can never replace newer state.
  let settingsLoadGeneration = 0;
  let settingsLoadsInFlight = 0;
  // Local saves are serialized by updateSettings, but focus hydration is a
  // separate read. Defer that read until every optimistic save has settled so
  // a pre-save snapshot cannot flip a newly changed control back.
  let settingsSavesInFlight = 0;
  let refreshAfterSettingsSaves = false;
  // Keep feedback local to the preference being persisted. Different settings
  // remain usable while a save is in flight, while repeated changes to the
  // same setting are held until its optimistic patch has settled.
  let pendingSettingsControls = $state<SettingsControlKey[]>([]);
  // GA gate (any signed-in user) — from the meetings feature flag. Gates the
  // Meeting-detection row, which graduated out of the Indigo dogfood.
  let meetingsEnabled = $state(false);
  // True @getindigo.ai gate — gates the builder-only staging-channel row.
  // Kept separate from `meetingsEnabled` above because the meetings flag is
  // now GA: keying the staging row off it would hand the @getindigo.ai-only
  // control to every signed-in user.
  let isIndigoBuilder = $state(false);
  let availableChannels = $state<Channel[]>(["stable"]);

  let hqPath = $state<string | null>(null);
  let hqFolderChanging = $state(false);
  // Default ON — mirrors the backend settings default; a fresh install
  // syncs on launch out of the box.
  let syncOnLaunch = $state(true);
  let realtimeSync = $state(true);
  let personalSyncEnabled = $state(true);
  let instantSync = $state(true);
  let notifications = $state(true);
  let shareNotifications = $state(true);
  let dmNotifications = $state(true);
  let cliAutoUpdate = $state(true);
  void cliAutoUpdate;
  // Master automatic-updates switch — one toggle governs silent install of the
  // app, CLI, and hq-core. Default ON. Read fresh by the native auto-installers
  // and re-read on popover focus, so it takes effect without a restart.
  let autoUpdate = $state(true);
  let stagingChannel = $state(true);
  let releaseChannel = $state<Channel | null>(null);
  let startAtLogin = $state(true);
  // Dock icon default-ON, mirroring the native effective_dock_icon posture, so
  // the toggle shows the true posture before the first read resolves.
  let dockIcon = $state(true);
  let meetingDetectEnabled = $state(true);
  let meetingDetectPlatforms = $state<string[]>([...platforms]);
  let defaultRecordingCompanyUid = $state<string | null>(null);
  // The telemetry toggle is rendered from the SERVER-AUTHORITATIVE consent
  // state, never from the local settings file. The local file is a cache
  // for offline display only (see US-003).
  //
  // `telemetryEnabled` is null until the server answers, so the toggle renders
  // in a "checking…" state rather than flashing the ON default before the
  // server responds (that flash is a small version of the same lie).
  let telemetryEnabled = $state<boolean | null>(null);
  // Where the currently-displayed value came from. `'server'` = authoritative;
  // `'local-cache'` = the server was unreachable and this is the offline value,
  // which the UI labels honestly rather than presenting as current truth.
  let telemetrySource = $state<"server" | "local-cache" | null>(null);
  // Provenance (AC5) — when the answer was recorded and which consent wording
  // it was recorded against. Absent on records that predate these fields.
  let telemetryUpdatedAt = $state<string | null>(null);
  let telemetryConsentVersion = $state<number | null>(null);
  // In-flight guard so a toggle click cannot race the initial server read or a
  // previous write.
  let telemetryBusy = $state(false);

  // macOS notification authorization — distinct from the in-app `notifications`
  // preference. `'unknown'` = not yet read (row hidden until first resolve).
  let notifPermission = $state<"granted" | "denied" | "prompt" | "unknown">(
    "unknown",
  );
  let notifRequesting = $state(false);
  let notifPermissionError = $state<string | null>(null);
  let meetingPermissionsOpening = $state(false);

  // App version via the updates seam (adapter.updates.getVersions().app).
  let appVersion = $state("");
  let appVersionLoadFailed = $state(false);

  // Manual "Check for Updates" transient result (app auto-updater).
  let updateChecking = $state(false);
  let updateResult = $state<string | null>(null);
  let updateResultTimeout: ReturnType<typeof setTimeout> | null = null;
  let appUpdate = $state<UpdateInfo | null>(null);
  let appUpdateInstalling = $state(false);
  let appUpdateLoadGeneration = 0;

  // hq CLI update notice — loaded via updates.checkCliUpdate; null = hide card.
  let hqCliUpdate = $state<{ local: string | null; latest: string } | null>(
    null,
  );
  let hqCliVersion = $state<string | null>(null);
  let hqCliVersionLoading = $state(true);
  let hqCliVersionError = $state(false);
  let hqCliChecking = $state(false);
  let hqCliInstalling = $state(false);
  let hqCliDismissing = $state(false);
  let hqCliLoadGeneration = 0;
  let hqCliUpdateError = $state<string | null>(null);
  let hqCliUpdateErrorContext = $state<"check" | "install" | "dismiss" | null>(
    null,
  );
  let hqCliCmdCopied = $state(false);
  let hqCliCmdCopying = $state(false);
  let hqCliCmdCopyError = $state<string | null>(null);

  // Marker the native updater puts on a "npm exited 0 but the CLI the app runs
  // never changed" failure. It needs opposite handling from an ordinary npm
  // failure: the install command is exactly what was just proven unable to
  // replace the selected CLI, so re-offering it would send the user around the
  // same loop. Show the backend's remedy instead.
  const HQ_CLI_NON_CONVERGENT_PREFIX = "hq-cli-update/non-convergent: ";
  const hqCliNonConvergent = $derived(
    hqCliUpdateErrorContext === "install" &&
      !!hqCliUpdateError?.includes(HQ_CLI_NON_CONVERGENT_PREFIX),
  );
  const hqCliNonConvergentMessage = $derived(
    hqCliUpdateError?.slice(
      (hqCliUpdateError?.indexOf(HQ_CLI_NON_CONVERGENT_PREFIX) ?? 0) +
        HQ_CLI_NON_CONVERGENT_PREFIX.length,
    ) ?? "",
  );

  // Pack update notice — loaded via packages.checkUpdates; hide when count 0/null.
  let packUpdate = $state<{ count: number; names: string[] } | null>(null);
  let packsUpdating = $state(false);
  let packUpdateError = $state<string | null>(null);

  // HQ Core identity comes from the canonical local core/core.yaml read. Keep
  // it independent from the slower channel/drift scan so a healthy install is
  // never mislabeled "unknown" while checkCoreState is still pending.
  let hqVersion = $state<string | null>(null);
  let coreVersionLoading = $state(true);
  let coreVersionError = $state(false);
  let coreVersionLoadGeneration = 0;
  let coreState = $state<CoreState | null>(null);
  let coreStateLoading = $state(true);
  let coreStateError = $state(false);
  let coreStateLoadGeneration = 0;
  let coreRefreshing = $state(false);
  let coreInstalling = $state(false);
  let coreInstallGeneration = 0;
  let driftDetailOpening = $state(false);
  let driftDetailError = $state<string | null>(null);
  // Transient install result for the HQ core row (v0.9.8 parity): 'ok' auto-
  // clears after ~6s; 'err' stays until the next run. log_path surfaces on err
  // so the user can open the rescue log for details.
  let coreInstallResult = $state<"ok" | "err" | null>(null);
  let coreInstallLogPath = $state<string | null>(null);
  let coreInstallResultTimeout: ReturnType<typeof setTimeout> | null = null;
  let coreLogCopyState = $state<"idle" | "copying" | "copied" | "failed">(
    "idle",
  );
  let coreLogOpenState = $state<"idle" | "opening" | "opened" | "failed">(
    "idle",
  );
  let coreLogCopyTimeout: ReturnType<typeof setTimeout> | null = null;
  let coreLogOpenTimeout: ReturnType<typeof setTimeout> | null = null;
  let signingOut = $state(false);
  let quitting = $state(false);
  let accountActionError = $state<string | null>(null);
  let accountRetryAction = $state<"sign-out" | "quit" | null>(null);
  let liveControlErrors = $state<Record<LiveControlKey, string | null>>({
    "realtime-sync": null,
    "instant-sync": null,
    "start-at-login": null,
    "dock-icon": null,
  });
  let appearance = $state<AppearancePreferences>(
    appearanceSeam?.read() ?? { colorTheme: "system", windowTransparency: 65 },
  );
  let interfaceZoom = $state(zoomSeam?.read() ?? 1);
  const windowOpacity = $derived(
    windowOpacityFromTransparency(appearance.windowTransparency),
  );

  const displayedChannel = $derived<Channel>(
    releaseChannel ?? (availableChannels.includes("beta") ? "beta" : "stable"),
  );
  const hqPathLabel = $derived(
    hqPath ? formatHqFolderMeta(hqPath) : "HQ folder not set",
  );
  const coreHasDrift = $derived((coreState?.driftReport.count ?? 0) > 0);
  const coreChannelPending = $derived(
    pendingSettingsControls.includes("staging-channel") ||
      pendingSettingsControls.includes("release-channel"),
  );
  const coreNeedsUpdate = $derived(
    !!coreState && (coreState.versionBehind || coreHasDrift),
  );
  const coreBusy = $derived(
    coreVersionLoading ||
      coreStateLoading ||
      coreRefreshing ||
      coreInstalling ||
      coreChannelPending,
  );
  const coreVersionLabel = $derived.by(() => {
    if (coreVersionLoading) return "Reading…";
    if (hqVersion) return `v${hqVersion}`;
    return coreVersionError ? "Unavailable" : "Not detected";
  });
  const coreStatusLabel = $derived.by(() => {
    if (coreInstallResult === "ok") return "Update complete";
    if (coreInstallResult === "err") {
      return coreInstallLogPath
        ? "Update failed. Review the install log or try again."
        : "Update failed. Try again.";
    }
    if (coreChannelPending) return "Updating channel…";
    if (coreStateLoading) return "Checking channel status…";
    if (coreStateError) return "Channel status unavailable";
    if (!coreState) {
      if (coreVersionLoading) return "Reading installed metadata…";
      return hqVersion
        ? "Installed locally"
        : "HQ folder metadata needs attention";
    }
    const channel = coreState.channel === "staging" ? "Staging" : "Release";
    if (coreState.versionBehind) {
      return `${channel} channel · Update available to v${coreState.targetVersion}`;
    }
    if (coreHasDrift) {
      const count = coreState.driftReport.count;
      return `${channel} channel · ${count} drifted ${count === 1 ? "file" : "files"}`;
    }
    return `${channel} channel · Up to date`;
  });
  const hqCliVersionLabel = $derived.by(() => {
    if (hqCliVersionLoading) return "Reading…";
    if (hqCliVersion) return `v${hqCliVersion}`;
    return hqCliVersionError ? "Unavailable" : "Not installed";
  });
  const hqCliStatusLabel = $derived.by(() => {
    if (hqCliInstalling) return "Installing update…";
    if (hqCliDismissing) return "Dismissing update…";
    if (hqCliUpdateError) {
      if (hqCliUpdateErrorContext === "install") {
        // A non-convergent install carries its own remedy (which `hq` the app
        // resolves, and that it must be updated with the tool that installed
        // it). That text is the only place the user can learn why the update
        // "succeeded" and changed nothing, so it must not be replaced by the
        // generic copy-the-command line.
        if (hqCliNonConvergent) return hqCliNonConvergentMessage;
        return "Update failed. Try again or copy the install command.";
      }
      if (hqCliUpdateErrorContext === "dismiss") {
        return "Couldn’t dismiss update. Try again.";
      }
      return "Update status unavailable";
    }
    if (hqCliUpdate) return `Update available to v${hqCliUpdate.latest}`;
    if (hqCliVersionLoading || hqCliChecking)
      return "Checking version and registry…";
    if (!hqCliVersion) return "Install the HQ CLI to use terminal workflows";
    return "Up to date";
  });
  const coreUpdateLabel = $derived.by(() => {
    if (!coreState) return "Update";
    if (coreState.channel === "staging") {
      return coreState.versionBehind ? "Update to Staging" : "Restore Staging";
    }
    return coreState.versionBehind
      ? `Update to v${coreState.targetVersion}`
      : `Restore v${coreState.targetVersion}`;
  });

  function failureText(
    res: { reason: string; message?: string },
    fallback: string,
  ): string {
    return res.message ?? fallback;
  }

  function updateAppearance(patch: Partial<AppearancePreferences>): void {
    if (!appearanceSeam) return;
    appearance = appearanceSeam.request(patch);
  }

  function updateInterfaceZoom(value: number): void {
    if (!zoomSeam) return;
    interfaceZoom = zoomSeam.request(value);
  }

  onMount(() => {
    const unsubAppearance = appearanceSeam?.subscribe?.((prefs) => {
      appearance = prefs;
    });
    const unsubZoom = zoomSeam?.subscribe?.((zoom) => {
      interfaceZoom = zoom;
    });
    return () => {
      unsubAppearance?.();
      unsubZoom?.();
    };
  });

  onMount(() => {
    let cancelled = false;

    // Register before hydration so a background checker event cannot race
    // getPendingUpdate while Settings is mounting.
    const unsubscribeUpdater = updaterBus?.subscribe({
      onAvailable: (info) => {
        if (cancelled || !info?.version) return;
        appUpdateLoadGeneration += 1;
        updateChecking = false;
        appUpdateInstalling = false;
        appUpdate = info;
        updateResult = null;
        if (updateResultTimeout) {
          clearTimeout(updateResultTimeout);
          updateResultTimeout = null;
        }
      },
      onCleared: () => {
        if (cancelled) return;
        appUpdateLoadGeneration += 1;
        updateChecking = false;
        appUpdate = null;
        appUpdateInstalling = false;
        updateResult = null;
        if (updateResultTimeout) {
          clearTimeout(updateResultTimeout);
          updateResultTimeout = null;
        }
      },
    });

    void loadSettings();
    void loadTelemetryConsent();
    void loadNotifPermission();
    void loadUpdateSurfaces();
    void adapter.updates.getVersions().then((res) => {
      if (res.ok && res.value.app) {
        appVersion = res.value.app;
        appVersionLoadFailed = false;
      } else if (!res.ok && res.reason === "error") {
        appVersionLoadFailed = true;
        console.error("Failed to read app version:", res.message);
      }
    });
    const onFocus = () => {
      onopenmeetingpermissions?.();
      void loadNotifPermission();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      appUpdateLoadGeneration += 1;
      hqCliLoadGeneration += 1;
      coreVersionLoadGeneration += 1;
      coreStateLoadGeneration += 1;
      coreInstallGeneration += 1;
      unsubscribeUpdater?.();
      window.removeEventListener("focus", onFocus);
      if (updateResultTimeout) clearTimeout(updateResultTimeout);
      if (coreInstallResultTimeout) clearTimeout(coreInstallResultTimeout);
      if (coreLogCopyTimeout) clearTimeout(coreLogCopyTimeout);
      if (coreLogOpenTimeout) clearTimeout(coreLogOpenTimeout);
      if (savedTimeout) clearTimeout(savedTimeout);
    };
  });

  function applyPersistedSettings(
    settings: SettingsWire,
    membershipsWire: CompanyMembership[] | null | undefined,
  ): void {
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
    dockIcon = settings.dockIcon ?? true;
    meetingDetectEnabled = settings.meetingDetectNotify?.enabled ?? true;
    meetingDetectPlatforms = settings.meetingDetectNotify?.platforms ?? [
      ...platforms,
    ];
    // Keep only active memberships; validate the stored default against the
    // live list so a revoked-access default falls back to Personal (null).
    const membershipRows = Array.isArray(membershipsWire)
      ? membershipsWire
      : [];
    memberships = membershipRows.filter(
      (membership) => membership.status === "active",
    );
    const storedUid = settings.defaultRecordingCompanyUid ?? null;
    defaultRecordingCompanyUid =
      storedUid &&
      memberships.some((membership) => membership.companyUid === storedUid)
        ? storedUid
        : null;
    // Deliberately NOT read from the local file here. The telemetry toggle is
    // server-authoritative and is loaded separately by loadTelemetryConsent();
    // the local `settings.telemetryEnabled` is only the offline cache and must
    // never be shown as the current answer while the server is reachable.
    releaseChannel = isChannel(settings.releaseChannel)
      ? settings.releaseChannel
      : null;
  }

  async function fetchMemberships(
    fallback: CompanyMembership[],
  ): Promise<CompanyMembership[]> {
    // Drives the default-recording-company dropdown. A vault hiccup must not
    // block the rest of Settings from rendering → degrade to the fallback.
    const res = await adapter.meetings.listMemberships();
    return res.ok ? (res.value as unknown as CompanyMembership[]) : fallback;
  }

  async function loadSettings() {
    const generation = ++settingsLoadGeneration;
    settingsLoadsInFlight += 1;
    loading = true;
    settingsReady = false;
    error = null;
    try {
      const [
        settingsRes,
        meetingsFeatureRes,
        indigoRes,
        channelsRes,
        memberships_,
      ] = await Promise.all([
        adapter.settings.getSettings(),
        adapter.identity.hasFeature("meetings"),
        // True @getindigo.ai gate for the staging-channel row (NOT the GA
        // meetings flag above, which admits any signed-in user).
        adapter.identity.hasFeature("is_indigo_user"),
        adapter.updates.availableChannels(),
        fetchMemberships([]),
      ]);
      if (generation !== settingsLoadGeneration) return;
      if (!settingsRes.ok) {
        if (settingsRes.reason === "unavailable") {
          // No local preference store on this host — the membership-backed
          // rows stay live; everything settings-backed degrades.
          settingsUnavailable = true;
          memberships = memberships_.filter((m) => m.status === "active");
        } else {
          error = failureText(settingsRes, "Couldn’t load settings.");
        }
      } else {
        settingsUnavailable = false;
        applyPersistedSettings(
          settingsRes.value as unknown as SettingsWire,
          memberships_,
        );
        settingsReady = true;
      }
      meetingsEnabled = meetingsFeatureRes.ok
        ? meetingsFeatureRes.value
        : false;
      isIndigoBuilder = indigoRes.ok ? indigoRes.value : false;
      const channels = channelsRes.ok ? channelsRes.value : ["stable"];
      availableChannels = (Array.isArray(channels) ? channels : []).filter(
        isChannel,
      );
    } finally {
      settingsLoadsInFlight -= 1;
      if (generation === settingsLoadGeneration) loading = false;
    }
  }

  function isChannel(value: unknown): value is Channel {
    return value === "stable" || value === "beta" || value === "alpha";
  }

  function isSettingsControlPending(control: SettingsControlKey): boolean {
    return pendingSettingsControls.includes(control);
  }

  function beginSettingsControl(control: SettingsControlKey): boolean {
    if (isSettingsControlPending(control)) return false;
    pendingSettingsControls = [...pendingSettingsControls, control];
    return true;
  }

  function endSettingsControl(control: SettingsControlKey): void {
    pendingSettingsControls = pendingSettingsControls.filter(
      (item) => item !== control,
    );
  }

  function setLiveControlError(
    control: LiveControlKey,
    message: string | null,
  ): void {
    liveControlErrors = { ...liveControlErrors, [control]: message };
  }

  async function restoreDaemonState(enabled: boolean): Promise<void> {
    const res = enabled
      ? await adapter.sync.startDaemon()
      : await adapter.sync.stopDaemon();
    if (!res.ok) {
      throw new Error(failureText(res, "sync daemon command failed"));
    }
  }

  async function persistSettingsControl(
    control: SettingsControlKey,
    patch: SettingsPatch,
  ): Promise<boolean> {
    if (!beginSettingsControl(control)) return false;
    try {
      return await saveSettings(patch);
    } finally {
      endSettingsControl(control);
    }
  }

  async function togglePlatform(platform: Platform) {
    // Detection enabled/platforms share one persisted object, so do not let
    // either control overwrite the other's still-pending snapshot.
    if (
      isSettingsControlPending("meeting-detection") ||
      isSettingsControlPending("meeting-platforms")
    ) {
      return;
    }
    meetingDetectPlatforms = meetingDetectPlatforms.includes(platform)
      ? meetingDetectPlatforms.filter((item) => item !== platform)
      : [...meetingDetectPlatforms, platform];
    await persistSettingsControl("meeting-platforms", {
      meetingDetectNotify: {
        enabled: meetingDetectEnabled,
        platforms: [...meetingDetectPlatforms],
      },
    });
  }

  // Re-tether the HQ folder — mirrors the classic Settings "Change…" button so a
  // user who moved their HQ folder can fix it without opening the menubar popover
  // or hand-editing the settings file.
  async function handlePickFolder() {
    if (hqFolderChanging) return;
    hqFolderChanging = true;
    try {
      const res = await adapter.shell.pickFolder();
      if (!res.ok) {
        if (res.reason === "error")
          error = failureText(res, "Couldn’t open the folder picker.");
        return;
      }
      if (res.value !== null) {
        hqPath = res.value;
        await saveSettings({ hqPath });
      }
    } finally {
      hqFolderChanging = false;
    }
  }

  // Open the macOS TCC permissions wizard. Without this row the desktop window
  // had no way to grant the Accessibility/Screen-Recording/Microphone access the
  // meeting SDK needs — users had to open the classic popover to reach it.
  async function handleOpenMeetingPermissionsWizard() {
    if (meetingPermissionsOpening) return;
    meetingPermissionsOpening = true;
    try {
      const res = await adapter.appShell.openMeetingPermissionsWindow();
      if (!res.ok && res.reason === "error") {
        error = failureText(
          res,
          "Couldn’t open the meeting permissions window.",
        );
      }
    } finally {
      meetingPermissionsOpening = false;
    }
  }

  /**
   * Persist only the field changed by the initiating control. updateSettings
   * serializes this patch with the other settings surfaces, then merges it
   * over the latest on-disk preferences immediately before saving.
   */
  async function saveSettings(patch: SettingsPatch): Promise<boolean> {
    const generation = ++settingsSaveGeneration;
    settingsSavesInFlight += 1;
    // Invalidate any pre-save focus read. Once the save queue drains we re-read
    // if that hydration was superseded, preserving both the optimistic value
    // and any external changes included in the newer persisted snapshot.
    if (settingsLoadsInFlight > 0) refreshAfterSettingsSaves = true;
    settingsLoadGeneration += 1;
    error = null;
    try {
      await updateSettings(patch);
      if ("personalSyncEnabled" in patch) {
        window.dispatchEvent(
          new CustomEvent("hq:workspace-sync-enabled-changed", {
            detail: {
              slug: "personal",
              enabled: Boolean(patch.personalSyncEnabled),
            },
          }),
        );
      }
      if (generation === settingsSaveGeneration) {
        saved = true;
        if (savedTimeout) clearTimeout(savedTimeout);
        savedTimeout = setTimeout(() => {
          saved = false;
          savedTimeout = null;
        }, 1000);
      }
      return true;
    } catch (err) {
      // Only the newest failed action may reconcile the optimistic controls.
      // An older queued failure must not overwrite a newer patch that is still
      // waiting to persist.
      // Every failure still requires one reconciliation after the queue drains:
      // otherwise an older failed toggle can stay optimistic after a newer
      // patch succeeds without it.
      refreshAfterSettingsSaves = true;
      if (generation === settingsSaveGeneration) {
        error = String(err);
      }
      return false;
    } finally {
      settingsSavesInFlight -= 1;
      if (settingsSavesInFlight === 0 && refreshAfterSettingsSaves) {
        refreshAfterSettingsSaves = false;
        await refreshSettingsSilently({ preserveError: error !== null });
      }
    }
  }

  function saveMeetingDetection(): Promise<boolean> {
    if (isSettingsControlPending("meeting-platforms"))
      return Promise.resolve(false);
    return persistSettingsControl("meeting-detection", {
      meetingDetectNotify: {
        enabled: meetingDetectEnabled,
        platforms: [...meetingDetectPlatforms],
      },
    });
  }

  async function auditTelemetryPreferenceChanged(enabled: boolean) {
    await telemetry?.emitPreferenceChanged?.(enabled);
  }

  // Monotonic generation so a slow initial read can never overwrite a newer
  // value the user has since toggled.
  let telemetryLoadGeneration = 0;

  /**
   * Load the SERVER-AUTHORITATIVE telemetry consent and render the toggle from
   * it. The local settings file is consulted only when the server is
   * unreachable, and when it is, the value is labelled as an offline cache
   * rather than presented as the current answer.
   *
   * `telemetryEnabled` stays `null` until this resolves, so the toggle shows a
   * "checking…" state instead of flashing the ON default before the server
   * answers.
   */
  async function loadTelemetryConsent(): Promise<void> {
    const generation = ++telemetryLoadGeneration;
    if (telemetry) {
      const res = await telemetry.getStatus();
      if (generation !== telemetryLoadGeneration) return;
      if (res.ok) {
        // A server that has a row but no recorded answer (`unset`) resolves to
        // the interim opt-out-is-collection default; render the toggle from the
        // effective `enabled` the server reports either way.
        telemetryEnabled = res.value.enabled;
        telemetrySource = res.value.source;
        telemetryUpdatedAt = res.value.updatedAt;
        telemetryConsentVersion = res.value.consentVersion;
      } else {
        // Even the status read failed (no token, resolve failure). Do not
        // fabricate an answer: leave the toggle in its checking state and note
        // it offline.
        console.error(
          "settings: failed to read telemetry consent",
          res.message,
        );
        telemetrySource = "local-cache";
      }
      return;
    }
    // No host consent seam — the adapter's cached read is the best available
    // truth; label it as the local cache rather than a server answer.
    const res = await adapter.settings.getTelemetryConsent();
    if (generation !== telemetryLoadGeneration) return;
    if (res.ok && res.value !== null) {
      telemetryEnabled = res.value;
      telemetrySource = "local-cache";
    } else if (!res.ok && res.reason === "error") {
      console.error("settings: failed to read telemetry consent", res.message);
      telemetrySource = "local-cache";
    }
  }

  /**
   * Persist a telemetry answer. The server write is the source of truth; the
   * local cache write is only for offline display. A withdrawal
   * (enabled=false) is carried to the server unconditionally with its surface
   * and consent version, so it cannot later be resurrected by any replay path.
   */
  async function applyTelemetryPreference() {
    // `bind:checked` has already flipped `telemetryEnabled` by the time onchange
    // fires; a null here would mean a toggle before the initial read resolved,
    // which the disabled binding prevents.
    const next = telemetryEnabled === true;
    if (telemetryBusy) return;
    telemetryBusy = true;
    try {
      // Finding #6: a withdrawal must HALT emission immediately — so we must not
      // emit ANY telemetry event for a withdrawal; only an opt-IN records the
      // change (after the server confirms it).
      // Persist the offline cache too, so an immediately-following offline read
      // shows the just-chosen value.
      if (
        !settingsUnavailable &&
        !(await saveSettings({ telemetryEnabled: next }))
      )
        return;
      if (!telemetry) {
        telemetrySource = "local-cache";
        return;
      }
      const result = await telemetry.postOptIn({
        enabled: next,
        surface: "settings",
        consentVersion: TELEMETRY_CONSENT_VERSION,
      });
      if (next && result.uploaded) {
        await auditTelemetryPreferenceChanged(next);
      }
      // Re-read the server so provenance (updatedAt/version) reflects the write
      // just made, and so the displayed value is the server's, not the optimistic
      // toggle. On a failed upload the re-read falls back to the cache and the
      // source label flips to offline, which is the honest state.
      if (result.uploaded) {
        await loadTelemetryConsent();
      } else {
        telemetrySource = "local-cache";
      }
    } finally {
      telemetryBusy = false;
    }
  }

  /**
   * Plain-language "answered on {date}" for the provenance line. Returns null
   * when there is no usable date, so the caller omits the line rather than
   * rendering "null".
   */
  function formatConsentAnsweredAt(iso: string | null): string | null {
    if (!iso) return null;
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return null;
    return when.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  // Three toggles carry live backend side-effects beyond persistence — without
  // them, flipping the switch in this window only writes the settings file and
  // the running process keeps its old behavior until the next launch. These
  // mirror the classic popover Settings so both surfaces apply identically.
  // `bind:checked` has already flipped the bound value by the time onchange
  // fires, so each reads the NEW state directly.

  // Auto-sync drives whether the background daemon runs at all. Start or stop
  // it immediately so the change takes effect without an app restart.
  async function applyRealtimeSync() {
    if (!beginSettingsControl("realtime-sync")) return;
    const next = realtimeSync;
    const previous = !next;
    setLiveControlError("realtime-sync", null);
    try {
      // Apply the live process state first so a failed daemon command never
      // leaves a persisted preference claiming that Auto-sync is active.
      await restoreDaemonState(next);
      if (!(await saveSettings({ realtimeSync: next }))) {
        realtimeSync = previous;
        try {
          await restoreDaemonState(previous);
        } catch (rollbackError) {
          console.error("Auto-sync daemon rollback failed:", rollbackError);
        }
      }
    } catch (err) {
      console.error("Auto-sync daemon command failed:", err);
      realtimeSync = previous;
      setLiveControlError(
        "realtime-sync",
        "Couldn’t change Auto-sync. The saved setting was left unchanged. Toggle again to retry.",
      );
      try {
        await restoreDaemonState(previous);
      } catch (rollbackError) {
        console.error("Auto-sync daemon recovery failed:", rollbackError);
      }
    } finally {
      endSettingsControl("realtime-sync");
    }
  }

  // Instant-sync is read at daemon spawn time. If the daemon is already
  // running, bounce it so the new flag takes effect now; if Auto-sync is off
  // there's no process to bounce — the next start picks it up.
  async function applyInstantSync() {
    if (!beginSettingsControl("instant-sync")) return;
    const next = instantSync;
    const previous = !next;
    let preferencePersisted = false;
    setLiveControlError("instant-sync", null);
    try {
      // The daemon reads Instant-sync from persisted settings at spawn time, so
      // save before bouncing it. If activation fails below, immediately write
      // the previous preference back.
      if (!(await saveSettings({ instantSync: next }))) return;
      preferencePersisted = true;
      if (!realtimeSync) return;
      await restoreDaemonState(false);
      await restoreDaemonState(true);
    } catch (err) {
      console.error("Instant-sync daemon restart failed:", err);
      instantSync = previous;
      if (preferencePersisted) {
        const restored = await saveSettings({ instantSync: previous });
        if (restored) instantSync = previous;
      }
      setLiveControlError(
        "instant-sync",
        "Couldn’t activate Instant sync, so the previous setting was restored. Toggle again to retry.",
      );
      if (realtimeSync) {
        try {
          await restoreDaemonState(true);
        } catch (rollbackError) {
          console.error("Instant-sync daemon recovery failed:", rollbackError);
        }
      }
    } finally {
      endSettingsControl("instant-sync");
    }
  }

  async function setAutostart(enabled: boolean): Promise<void> {
    const res = await adapter.appShell.setAutostart(enabled);
    if (!res.ok) throw new Error(failureText(res, "autostart command failed"));
  }

  // Start-at-login must reconcile the macOS LaunchAgent plist, not just persist
  // the flag — otherwise the login item never actually changes.
  async function applyStartAtLogin() {
    if (!beginSettingsControl("start-at-login")) return;
    const next = startAtLogin;
    const previous = !next;
    setLiveControlError("start-at-login", null);
    try {
      await setAutostart(next);
      if (!(await saveSettings({ startAtLogin: next }))) {
        startAtLogin = previous;
        try {
          await setAutostart(previous);
        } catch (rollbackError) {
          console.error("Autostart rollback failed:", rollbackError);
        }
      }
    } catch (err) {
      console.error("Failed to set autostart:", err);
      startAtLogin = previous;
      setLiveControlError(
        "start-at-login",
        "Couldn’t change Start at login. The saved setting was left unchanged. Toggle again to retry.",
      );
      try {
        await setAutostart(previous);
      } catch (rollbackError) {
        console.error("Autostart recovery failed:", rollbackError);
      }
    } finally {
      endSettingsControl("start-at-login");
    }
  }

  async function applyStagingChannel() {
    if (coreInstalling) return;
    if (!beginSettingsControl("staging-channel")) return;
    try {
      if (!(await saveSettings({ stagingChannel }))) return;
      await refreshCoreState();
    } finally {
      endSettingsControl("staging-channel");
    }
  }

  // The Dock icon must change NOW, not at next launch — so persist first, then
  // re-apply the activation policy from the freshly written preference. Same
  // save-then-apply contract as the widget toggle.
  //
  // A failed save reverts the optimistic checkbox (nothing was written). A
  // failed apply keeps the new value — disk is already authoritative — but
  // still surfaces the error, because until the next launch the visible Dock
  // state and the toggle disagree.
  async function applyDockIcon() {
    // `bind:checked` has already flipped `dockIcon`, so the pre-toggle value
    // is its negation — this is a two-state control.
    if (!beginSettingsControl("dock-icon")) return;
    const previous = !dockIcon;
    setLiveControlError("dock-icon", null);
    try {
      if (!(await saveSettings({ dockIcon }))) {
        dockIcon = previous;
        setLiveControlError(
          "dock-icon",
          "Couldn’t save Dock visibility. The previous setting was restored.",
        );
        return;
      }
      const res = await adapter.appShell.setDockVisible(dockIcon);
      if (!res.ok) {
        console.error("Failed to apply dock icon:", res.message);
        setLiveControlError(
          "dock-icon",
          "Saved. Restart HQ to finish changing Dock visibility.",
        );
      }
    } finally {
      endSettingsControl("dock-icon");
    }
  }

  // OS-level notification authorization (non-prompting). Hidden until
  // the first read resolves, like the classic Settings surface.
  async function loadNotifPermission() {
    const res = await adapter.appShell.notificationPermissionState();
    if (
      res.ok &&
      (res.value === "granted" ||
        res.value === "denied" ||
        res.value === "prompt")
    ) {
      notifPermission = res.value;
    } else {
      if (!res.ok && res.reason === "error") {
        console.error("Failed to read notification permission:", res.message);
      }
      notifPermission = "unknown";
    }
  }

  async function handleEnableNotifications() {
    if (notifRequesting) return;
    notifPermissionError = null;
    // Once the OS has recorded a denial it will NOT re-show the system dialog,
    // so requestNotificationPermission would be a silent no-op. Deep-link to
    // System Settings > Notifications instead (v1 hq-desktop Settings UX).
    if (notifPermission === "denied") {
      try {
        await openExternal(
          "x-apple.systempreferences:com.apple.preference.notifications",
        );
      } catch (err) {
        console.error("Failed to open System Settings:", err);
        notifPermissionError =
          "Couldn’t open Notification Settings. Try again.";
      }
      return;
    }
    notifRequesting = true;
    try {
      const res = await adapter.appShell.requestNotificationPermission();
      if (
        res.ok &&
        (res.value === "granted" ||
          res.value === "denied" ||
          res.value === "prompt")
      ) {
        notifPermission = res.value;
      } else if (!res.ok) {
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

  // Fire-and-forget update surface hydration. Each check is independent so a
  // failed check never blocks the rest of Settings.
  async function loadUpdateSurfaces() {
    await Promise.all([
      refreshPendingAppUpdate(),
      refreshHqCliSurface(),
      refreshPackUpdate(),
      refreshCoreVersion(),
      refreshCoreState(),
    ]);
  }

  async function refreshPendingAppUpdate() {
    if (appUpdateInstalling) return;
    const generation = ++appUpdateLoadGeneration;
    const res = await adapter.updates.getPendingUpdate();
    if (generation !== appUpdateLoadGeneration) return;
    if (!res.ok) {
      if (res.reason === "error")
        console.error("get pending update failed:", res.message);
      return;
    }
    const resolved = resolvePendingUpdateState(
      res.value as PendingUpdateState | UpdateInfo | null,
    );
    if (resolved.state === "resolved") {
      appUpdate = resolved.value;
    }
  }

  async function refreshHqCliUpdate(generation: number) {
    const res = await adapter.updates.checkCliUpdate();
    if (generation !== hqCliLoadGeneration) return;
    if (res.ok) {
      hqCliUpdate = res.value as unknown as {
        local: string | null;
        latest: string;
      } | null;
      hqCliUpdateError = null;
      hqCliUpdateErrorContext = null;
    } else if (res.reason === "unavailable") {
      hqCliUpdate = null;
      hqCliUpdateError = null;
      hqCliUpdateErrorContext = null;
    } else {
      console.error("check hq CLI update failed:", res.message);
      hqCliUpdate = null;
      hqCliUpdateError = failureText(res, "update check failed");
      hqCliUpdateErrorContext = "check";
    }
  }

  async function refreshHqCliVersion(generation: number) {
    hqCliVersionLoading = true;
    hqCliVersionError = false;
    const res = await adapter.updates.getVersions();
    if (generation !== hqCliLoadGeneration) return;
    if (res.ok) {
      hqCliVersion = res.value.cli ?? null;
    } else {
      if (res.reason === "error")
        console.error("get hq CLI version failed:", res.message);
      hqCliVersion = null;
      hqCliVersionError = res.reason === "error";
    }
    hqCliVersionLoading = false;
  }

  async function refreshHqCliSurface() {
    if (hqCliChecking || hqCliInstalling || hqCliDismissing) return;
    const generation = ++hqCliLoadGeneration;
    hqCliChecking = true;
    try {
      await Promise.all([
        refreshHqCliVersion(generation),
        refreshHqCliUpdate(generation),
      ]);
    } finally {
      if (generation === hqCliLoadGeneration) hqCliChecking = false;
    }
  }

  async function refreshPackUpdate() {
    const res = await adapter.packages.checkUpdates();
    if (res.ok) {
      const info = res.value as unknown as {
        count: number;
        names: string[];
      } | null;
      packUpdate = info && info.count > 0 ? info : null;
    } else {
      if (res.reason === "error")
        console.error("check pack update failed:", res.message);
      packUpdate = null;
    }
  }

  async function refreshCoreVersion() {
    const generation = ++coreVersionLoadGeneration;
    coreVersionLoading = true;
    coreVersionError = false;
    const res = await adapter.updates.getVersions();
    if (generation !== coreVersionLoadGeneration) return;
    if (res.ok) {
      hqVersion = res.value.core ?? null;
    } else {
      if (res.reason === "error")
        console.error("HQ Core version refresh failed:", res.message);
      hqVersion = null;
      coreVersionError = res.reason === "error";
    }
    coreVersionLoading = false;
  }

  async function refreshCoreState() {
    const generation = ++coreStateLoadGeneration;
    coreStateLoading = true;
    coreStateError = false;
    const res = await adapter.updates.checkCoreState();
    if (generation !== coreStateLoadGeneration) return;
    if (res.ok) {
      coreState = res.value as unknown as CoreState | null;
    } else {
      if (res.reason === "error")
        console.error("HQ Core state refresh failed:", res.message);
      coreState = null;
      coreStateError = res.reason === "error";
    }
    coreStateLoading = false;
  }

  async function handleRefreshCore() {
    if (coreRefreshing || coreInstalling || coreChannelPending) return;
    coreRefreshing = true;
    try {
      await Promise.all([refreshCoreVersion(), refreshCoreState()]);
    } finally {
      coreRefreshing = false;
    }
  }

  async function handleCheckForUpdates() {
    if (updateChecking) return;
    const generation = ++appUpdateLoadGeneration;
    updateChecking = true;
    updateResult = null;
    if (updateResultTimeout) clearTimeout(updateResultTimeout);
    const res = await adapter.updates.checkForUpdates();
    if (generation !== appUpdateLoadGeneration) return;
    if (res.ok) {
      const info = res.value as unknown as UpdateInfo | null;
      appUpdate = info?.version ? info : null;
      updateResult = info?.version ? null : "Up to date";
    } else if (res.reason === "unavailable") {
      updateResult = "Updates are managed by this host";
    } else {
      console.error("check for updates failed:", res.message);
      updateResult = "Check failed";
    }
    updateChecking = false;
    updateResultTimeout = setTimeout(() => {
      updateResult = null;
    }, 4000);
  }

  async function handleInstallAppUpdate() {
    if (!appUpdate || appUpdateInstalling) return;
    const generation = ++appUpdateLoadGeneration;
    appUpdateInstalling = true;
    updateResult = null;
    if (updateResultTimeout) clearTimeout(updateResultTimeout);
    // The backend downloads, installs, and restarts the app. On macOS this
    // call normally never returns because the process is replaced.
    const res = await adapter.updates.installUpdate();
    if (generation !== appUpdateLoadGeneration) return;
    if (res.ok) {
      updateResult = "Restarting…";
    } else {
      console.error("install update failed:", res.message);
      updateResult = "Install failed";
      appUpdateInstalling = false;
    }
  }

  async function handleInstallHqCliUpdate() {
    if (hqCliInstalling) return;
    const generation = ++hqCliLoadGeneration;
    hqCliChecking = false;
    hqCliInstalling = true;
    hqCliUpdateError = null;
    hqCliUpdateErrorContext = null;
    try {
      const res = await adapter.updates.installCliUpdate();
      if (generation !== hqCliLoadGeneration) return;
      if (!res.ok) {
        console.error("install hq CLI update failed:", res.message);
        hqCliUpdateError = failureText(res, "install failed");
        hqCliUpdateErrorContext = "install";
        return;
      }
      const info = res.value as unknown as {
        local: string | null;
        latest: string;
      } | null;
      if (info?.local && info.local === info.latest) {
        hqCliUpdate = null;
      } else if (info) {
        hqCliUpdate = info;
      }
      // Re-check after a successful install so a race with the registry is
      // reflected; leave the error path alone so "Update failed." sticks.
      await Promise.all([
        refreshHqCliVersion(generation),
        refreshHqCliUpdate(generation),
      ]);
    } finally {
      if (generation === hqCliLoadGeneration) hqCliInstalling = false;
    }
  }

  async function handleDismissHqCliUpdate() {
    if (hqCliDismissing || hqCliInstalling) return;
    const dismissedUpdate = hqCliUpdate;
    const latest = dismissedUpdate?.latest;
    if (!latest) return;
    const generation = ++hqCliLoadGeneration;
    hqCliChecking = false;
    hqCliUpdate = null;
    hqCliUpdateError = null;
    hqCliUpdateErrorContext = null;
    hqCliDismissing = true;
    try {
      const res = await adapter.updates.dismissCliUpdate();
      if (generation !== hqCliLoadGeneration) return;
      if (!res.ok) {
        console.error("dismiss hq CLI update failed:", res.message);
        hqCliUpdate = dismissedUpdate;
        hqCliUpdateError = failureText(res, "dismiss failed");
        hqCliUpdateErrorContext = "dismiss";
      }
    } finally {
      if (generation === hqCliLoadGeneration) hqCliDismissing = false;
    }
  }

  async function copyHqCliCommand() {
    if (hqCliCmdCopying) return;
    hqCliCmdCopying = true;
    hqCliCmdCopied = false;
    hqCliCmdCopyError = null;
    try {
      await navigator.clipboard.writeText(HQ_CLI_UPGRADE_CMD);
      hqCliCmdCopied = true;
      setTimeout(() => {
        hqCliCmdCopied = false;
      }, 1500);
    } catch (err) {
      console.error("copy hq CLI command failed:", err);
      hqCliCmdCopyError = "Couldn’t copy the install command. Try again.";
    } finally {
      hqCliCmdCopying = false;
    }
  }

  async function handleUpdatePacks() {
    if (packsUpdating || !packUpdate) return;
    packsUpdating = true;
    packUpdateError = null;
    const res = await adapter.packages.updatePacks(packUpdate.names);
    if (res.ok) {
      packUpdate = null;
      await refreshPackUpdate();
    } else {
      packUpdateError = failureText(res, "pack update failed");
    }
    packsUpdating = false;
  }

  async function handleOpenDriftDetail() {
    const report = coreState?.driftReport;
    if (
      !report ||
      driftDetailOpening ||
      coreStateLoading ||
      coreRefreshing ||
      coreChannelPending
    )
      return;
    driftDetailOpening = true;
    driftDetailError = null;
    const res = await adapter.appShell.openDriftDetail(
      report as unknown as Record<string, unknown>,
    );
    if (!res.ok) {
      console.error("open drift detail failed:", res.message);
      driftDetailError = "Couldn’t open drift details. Try again.";
    }
    driftDetailOpening = false;
  }

  function resetCoreLogActions(): void {
    coreLogCopyState = "idle";
    coreLogOpenState = "idle";
    if (coreLogCopyTimeout) {
      clearTimeout(coreLogCopyTimeout);
      coreLogCopyTimeout = null;
    }
    if (coreLogOpenTimeout) {
      clearTimeout(coreLogOpenTimeout);
      coreLogOpenTimeout = null;
    }
  }

  async function handleCopyCoreInstallLogPath(): Promise<void> {
    const logPath = coreInstallLogPath;
    if (!logPath || coreLogCopyState === "copying") return;
    if (coreLogCopyTimeout) clearTimeout(coreLogCopyTimeout);
    coreLogCopyState = "copying";
    try {
      await navigator.clipboard.writeText(logPath);
      if (coreInstallLogPath !== logPath) return;
      coreLogCopyState = "copied";
      coreLogCopyTimeout = setTimeout(() => {
        if (coreInstallLogPath === logPath) coreLogCopyState = "idle";
        coreLogCopyTimeout = null;
      }, 1800);
    } catch (err) {
      console.error("copy HQ Core install log path failed:", err);
      if (coreInstallLogPath !== logPath) return;
      coreLogCopyState = "failed";
      coreLogCopyTimeout = setTimeout(() => {
        if (coreInstallLogPath === logPath) coreLogCopyState = "idle";
        coreLogCopyTimeout = null;
      }, 4000);
    }
  }

  async function handleOpenCoreInstallLog(): Promise<void> {
    const logPath = coreInstallLogPath;
    if (!logPath || coreLogOpenState === "opening") return;
    if (coreLogOpenTimeout) clearTimeout(coreLogOpenTimeout);
    coreLogOpenState = "opening";
    try {
      await openExternal(logPath);
      if (coreInstallLogPath !== logPath) return;
      coreLogOpenState = "opened";
      coreLogOpenTimeout = setTimeout(() => {
        if (coreInstallLogPath === logPath) coreLogOpenState = "idle";
        coreLogOpenTimeout = null;
      }, 1800);
    } catch (err) {
      console.error("open HQ Core install log failed:", err);
      if (coreInstallLogPath !== logPath) return;
      coreLogOpenState = "failed";
      coreLogOpenTimeout = setTimeout(() => {
        if (coreInstallLogPath === logPath) coreLogOpenState = "idle";
        coreLogOpenTimeout = null;
      }, 4000);
    }
  }

  async function handleInstallCore() {
    if (
      coreInstalling ||
      coreStateLoading ||
      coreRefreshing ||
      coreChannelPending ||
      !coreState
    )
      return;
    const generation = ++coreInstallGeneration;
    coreInstalling = true;
    coreInstallResult = null;
    coreInstallLogPath = null;
    resetCoreLogActions();
    if (coreInstallResultTimeout) {
      clearTimeout(coreInstallResultTimeout);
      coreInstallResultTimeout = null;
    }
    // Rescue commands resolve ok with { exit_code, log_tail, log_path } —
    // a NONZERO exit_code is a failed rescue that still returns successfully
    // (same shape as the classic popover path).
    const res =
      coreState.channel === "staging"
        ? await adapter.updates.replaceFromStaging()
        : await adapter.updates.installCoreUpdate();
    if (generation !== coreInstallGeneration) return;
    if (res.ok) {
      const result = res.value as unknown as {
        exit_code?: number;
        log_tail?: string;
        log_path?: string;
      } | void;
      const exitCode =
        result && typeof result === "object" ? (result.exit_code ?? 0) : 0;
      if (exitCode === 0) {
        coreInstallResult = "ok";
        // Auto-clear "update done" after a few seconds (momentary confirm).
        coreInstallResultTimeout = setTimeout(() => {
          if (coreInstallResult === "ok") coreInstallResult = null;
          coreInstallResultTimeout = null;
        }, 6000);
      } else {
        coreInstallResult = "err";
        coreInstallLogPath =
          (result && typeof result === "object" ? result.log_path : null) ||
          null;
      }
      await Promise.all([refreshCoreVersion(), refreshCoreState()]);
    } else {
      console.error("core install failed:", res.message);
      coreInstallResult = "err";
      coreInstallLogPath = null;
    }
    if (generation === coreInstallGeneration) coreInstalling = false;
  }

  // Sign out is a host-owned flow (the tray sign-out event + state reset),
  // then surface the main window's sign-in prompt.
  let signOutConfirmOpen = $state(false);

  function requestSignOut(): void {
    if (signingOut || quitting) return;
    signOutConfirmOpen = true;
  }

  async function handleSignOut() {
    if (signingOut || quitting) return;
    signingOut = true;
    accountActionError = null;
    accountRetryAction = null;
    try {
      await onsignout?.();
      const res = await adapter.appShell.showMainWindow();
      if (!res.ok && res.reason === "error") {
        throw new Error(failureText(res, "show main window failed"));
      }
    } catch (err) {
      console.error("sign out failed:", err);
      accountActionError = "Couldn’t finish signing out. Try again.";
      accountRetryAction = "sign-out";
    } finally {
      signingOut = false;
    }
  }

  async function handleQuit() {
    if (quitting || signingOut) return;
    quitting = true;
    accountActionError = null;
    accountRetryAction = null;
    const res = await adapter.appShell.quitApp();
    if (!res.ok) {
      console.error("quit app failed:", res.message);
      accountActionError = "Couldn’t quit HQ. Try again.";
      accountRetryAction = "quit";
    }
    quitting = false;
  }

  // Re-read persisted prefs without a loading flash so a change made in the
  // menubar popover reflects here on focus. Memberships are refreshed too:
  // access can be revoked while the window is open, and a stored recording
  // default must never revive after its membership disappears.
  async function refreshSettingsSilently({
    preserveError = false,
  }: { preserveError?: boolean } = {}) {
    if (settingsSavesInFlight > 0) {
      refreshAfterSettingsSaves = true;
      return;
    }
    const generation = ++settingsLoadGeneration;
    settingsLoadsInFlight += 1;
    try {
      const [settingsRes, memberships_] = await Promise.all([
        adapter.settings.getSettings(),
        fetchMemberships(memberships),
      ]);
      if (generation !== settingsLoadGeneration) return;
      if (!settingsRes.ok) return; // Non-fatal — keep showing last-known values.
      applyPersistedSettings(
        settingsRes.value as unknown as SettingsWire,
        memberships_,
      );
      if (!preserveError) error = null;
      settingsReady = true;
    } finally {
      settingsLoadsInFlight -= 1;
    }
  }

  onMount(() => {
    const onFocus = () => {
      if (settingsUnavailable) return;
      if (settingsReady) void refreshSettingsSilently();
      else void loadSettings();
      // Re-read server consent on focus so a withdrawal made elsewhere (or the
      // provenance of a just-recorded answer) is reflected without a restart.
      void loadTelemetryConsent();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });
</script>

<section
  class="settings-page chat-shell"
  aria-labelledby="settings-title"
  aria-busy={loading}
  data-testid="settings-single-pane"
>
  <main class="settings-main">
    <header class="page-header settings-head">
      <button
        type="button"
        class="settings-back"
        data-testid="settings-back"
        onclick={() => onnavigate?.(null)}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M10 3.5 5.5 8 10 12.5"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        Back
      </button>
      <h1 id="settings-title">Settings</h1>
      <span class="settings-sub">{saved ? "Saved" : "yours — desktop"}</span>
    </header>

    {#if error}
      <div class="error" role="alert">
        <span>{error}</span>
        <button
          type="button"
          data-testid="settings-retry-load"
          disabled={loading}
          onclick={() => void loadSettings()}
        >
          {loading ? "Retrying…" : "Retry"}
        </button>
      </div>
    {/if}

    <div class="settings-split">
      <!-- In-page section index (US-020: not a shell secondary sidebar). -->
      <nav
        class="settings-index"
        aria-label="Settings sections"
        data-testid="settings-index"
      >
        {#each SETTINGS_SECTIONS as section (section.id)}
          <button
            type="button"
            class="settings-index-row"
            class:on={activeTab === section.id ||
              (activeTab == null && section.id === "sync")}
            data-testid="settings-index-row"
            data-section={section.id}
            onclick={() => onnavigate?.(section.id)}
          >
            <span class="settings-index-label">{section.label}</span>
            <span class="settings-index-chevron" aria-hidden="true"
              >&rsaquo;</span
            >
          </button>
        {/each}
      </nav>
      <div class="settings-pane">
        <fieldset
          class="settings-controls"
          disabled={!settingsReady && !settingsUnavailable}
        >
          <section
            id="sync"
            class="settings-section"
            hidden={activeTab !== "sync"}
          >
            <h2>Sync</h2>
            {#if !canSync || settingsUnavailable}
              <div class="settings-card">
                <UnavailableNote
                  label="Sync"
                  message="Local folder sync runs in the HQ desktop app."
                  testid="settings-sync-unavailable"
                />
              </div>
            {:else}
              <div class="settings-card">
                <div class="setting-row">
                  <div>
                    <strong>HQ folder</strong><span>{hqPathLabel}</span>
                  </div>
                  <button
                    type="button"
                    class="row-button"
                    onclick={handlePickFolder}
                    disabled={hqFolderChanging || !canLaunchApps}
                    aria-busy={hqFolderChanging}
                  >
                    {hqFolderChanging ? "Choosing…" : "Change…"}
                  </button>
                </div>
                <label class="setting-row">
                  <span
                    ><strong>Sync on launch</strong><small
                      >Run a sync when the app starts.</small
                    ></span
                  >
                  <input
                    type="checkbox"
                    bind:checked={syncOnLaunch}
                    onchange={() =>
                      void persistSettingsControl("sync-on-launch", {
                        syncOnLaunch,
                      })}
                    disabled={isSettingsControlPending("sync-on-launch")}
                    aria-busy={isSettingsControlPending("sync-on-launch")}
                  />
                </label>
                <label class="setting-row">
                  <span>
                    <strong>Auto-sync</strong>
                    <small>Sync every few minutes in the background.</small>
                    {#if liveControlErrors["realtime-sync"]}
                      <small
                        class="row-action-error"
                        role="alert"
                        data-testid="settings-realtime-sync-error"
                        >{liveControlErrors["realtime-sync"]}</small
                      >
                    {/if}
                  </span>
                  <input
                    type="checkbox"
                    bind:checked={realtimeSync}
                    onchange={applyRealtimeSync}
                    disabled={isSettingsControlPending("realtime-sync")}
                    aria-busy={isSettingsControlPending("realtime-sync")}
                  />
                </label>
                <label class="setting-row">
                  <span>
                    <strong>Instant sync</strong>
                    <small>Push local edits within seconds when eligible.</small
                    >
                    {#if liveControlErrors["instant-sync"]}
                      <small
                        class="row-action-error"
                        role="alert"
                        data-testid="settings-instant-sync-error"
                        >{liveControlErrors["instant-sync"]}</small
                      >
                    {/if}
                  </span>
                  <input
                    type="checkbox"
                    bind:checked={instantSync}
                    onchange={applyInstantSync}
                    disabled={isSettingsControlPending("instant-sync")}
                    aria-busy={isSettingsControlPending("instant-sync")}
                  />
                </label>
                <label class="setting-row">
                  <span
                    ><strong>Sync personal vault</strong><small
                      >Include personal HQ files in the fanout.</small
                    ></span
                  >
                  <input
                    type="checkbox"
                    bind:checked={personalSyncEnabled}
                    onchange={() =>
                      void persistSettingsControl("personal-sync", {
                        personalSyncEnabled,
                      })}
                    disabled={isSettingsControlPending("personal-sync")}
                    aria-busy={isSettingsControlPending("personal-sync")}
                  />
                </label>
              </div>
            {/if}
          </section>

          <section
            id="notifications"
            class="settings-section"
            hidden={activeTab !== "notifications"}
          >
            <h2>Notifications</h2>
            <div class="settings-card">
              {#if settingsUnavailable}
                <UnavailableNote
                  label="Notification preferences"
                  message="These preferences live on the HQ desktop app."
                  testid="settings-notifications-unavailable"
                />
              {:else}
                <label class="setting-row">
                  <span
                    ><strong>Sync notifications</strong><small
                      >Notify when sync needs attention.</small
                    ></span
                  >
                  <input
                    type="checkbox"
                    bind:checked={notifications}
                    onchange={() =>
                      void persistSettingsControl("sync-notifications", {
                        notifications,
                      })}
                    disabled={isSettingsControlPending("sync-notifications")}
                    aria-busy={isSettingsControlPending("sync-notifications")}
                  />
                </label>
                <label class="setting-row">
                  <span
                    ><strong>Share notifications</strong><small
                      >Show file-share activity from teammates.</small
                    ></span
                  >
                  <input
                    type="checkbox"
                    bind:checked={shareNotifications}
                    onchange={() =>
                      void persistSettingsControl("share-notifications", {
                        shareNotifications,
                      })}
                    disabled={isSettingsControlPending("share-notifications")}
                    aria-busy={isSettingsControlPending("share-notifications")}
                  />
                </label>
                <label class="setting-row">
                  <span
                    ><strong>DM notifications</strong><small
                      >Show direct messages in the menu bar.</small
                    ></span
                  >
                  <input
                    type="checkbox"
                    bind:checked={dmNotifications}
                    onchange={() =>
                      void persistSettingsControl("dm-notifications", {
                        dmNotifications,
                      })}
                    disabled={isSettingsControlPending("dm-notifications")}
                    aria-busy={isSettingsControlPending("dm-notifications")}
                  />
                </label>
              {/if}
              <!-- macOS permission monitor — OS authorization, separate from the
             in-app toggles above. Hidden until the first state read resolves. -->
              {#if notifPermission !== "unknown"}
                <div class="setting-row">
                  <span>
                    <strong>System permission</strong>
                    <small>
                      {#if notifPermission === "granted"}
                        macOS is allowing notifications from HQ
                      {:else if notifPermission === "denied"}
                        Blocked in macOS — open System Settings to allow
                      {:else}
                        Not enabled yet — allow to see message alerts
                      {/if}
                    </small>
                    {#if notifPermissionError}
                      <small
                        class="row-action-error"
                        role="alert"
                        data-testid="settings-notification-permission-error"
                        >{notifPermissionError}</small
                      >
                    {/if}
                  </span>
                  {#if notifPermission === "granted"}
                    <span class="perm-pill">Enabled</span>
                  {:else}
                    <button
                      type="button"
                      class="row-button"
                      onclick={handleEnableNotifications}
                      disabled={notifRequesting}
                      aria-busy={notifRequesting}
                    >
                      {#if notifRequesting}
                        {notifPermission === "denied"
                          ? "Opening…"
                          : "Requesting…"}
                      {:else if notifPermissionError}
                        Try again
                      {:else if notifPermission === "denied"}
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

          <section
            id="widget"
            class="settings-section"
            hidden={activeTab !== "widget"}
          >
            <h2>Notifications widget</h2>
            <div class="settings-card">
              {#if widgetSettings}
                {@render widgetSettings()}
              {:else}
                <UnavailableNote
                  label="Notifications widget"
                  message="The desktop widget is configured from the HQ desktop app."
                  testid="settings-widget-unavailable"
                />
              {/if}
            </div>
          </section>

          <section
            id="updates"
            class="settings-section"
            hidden={activeTab !== "updates"}
          >
            <h2>Updates</h2>
            {#if !canSelfUpdate}
              <div class="settings-card">
                <UnavailableNote
                  label="Updates"
                  message="App, HQ Core, and CLI updates are managed from the HQ desktop app."
                  testid="settings-updates-unavailable"
                />
              </div>
            {:else}
              <div class="settings-card">
                <!-- Master automatic-updates switch (default ON). One toggle governs
             silent, no-prompt install of the app itself (self-update +
             restart), the hq CLI, and hq-core (drift-safe rescue). Supersedes
             the old per-CLI "Auto-update HQ CLI" toggle. -->
                <label class="setting-row">
                  <span
                    ><strong>Automatic updates</strong><small
                      >Install HQ Core, desktop app, and CLI updates
                      automatically in the background — no prompts.</small
                    ></span
                  >
                  <input
                    id="toggle-auto-update"
                    type="checkbox"
                    bind:checked={autoUpdate}
                    onchange={() =>
                      void persistSettingsControl("auto-update", {
                        autoUpdate,
                      })}
                    disabled={isSettingsControlPending("auto-update")}
                    aria-busy={isSettingsControlPending("auto-update")}
                    aria-label="Automatic updates"
                  />
                </label>
                <label class="setting-row gated-row">
                  <span
                    ><strong>HQ Core staging channel</strong><small
                      >@getindigo.ai only. Changes rescue and drift targets.</small
                    ></span
                  >
                  <input
                    type="checkbox"
                    disabled={isSettingsControlPending("staging-channel") ||
                      !isIndigoBuilder ||
                      coreInstalling}
                    aria-busy={isSettingsControlPending("staging-channel") ||
                      coreInstalling}
                    bind:checked={stagingChannel}
                    onchange={applyStagingChannel}
                  />
                  <em>Gated</em>
                </label>
                <label class="setting-row gated-row">
                  <span
                    ><strong>Release channel</strong><small
                      >@getindigo.ai only. Stable is enforced for everyone else.</small
                    ></span
                  >
                  <select
                    disabled={isSettingsControlPending("release-channel") ||
                      availableChannels.length <= 1 ||
                      coreInstalling}
                    aria-busy={isSettingsControlPending("release-channel") ||
                      coreInstalling}
                    bind:value={releaseChannel}
                    onchange={() =>
                      void persistSettingsControl("release-channel", {
                        releaseChannel,
                      })}
                  >
                    <option value={null}>Default ({displayedChannel})</option>
                    {#each availableChannels as channel (channel)}
                      <option value={channel}>{channel}</option>
                    {/each}
                  </select>
                  <em>Gated</em>
                </label>
                <div class="setting-row">
                  <span>
                    <strong>HQ desktop app</strong>
                    <small data-testid="settings-app-status">
                      {updateResult ??
                        (appUpdate
                          ? `v${appUpdate.version} ready`
                          : "Background checks run every 6 hours")}
                    </small>
                  </span>
                  <div class="row-actions">
                    <span
                      class="version-chip"
                      data-testid="settings-app-version"
                    >
                      {appVersion
                        ? `v${appVersion}`
                        : appVersionLoadFailed
                          ? "Unavailable"
                          : "Reading…"}
                    </span>
                    {#if appUpdate}
                      <button
                        type="button"
                        class="row-button primary"
                        data-testid="settings-install-app-update"
                        onclick={handleInstallAppUpdate}
                        disabled={appUpdateInstalling}
                        aria-busy={appUpdateInstalling}
                      >
                        {appUpdateInstalling
                          ? "Installing…"
                          : "Restart to Update"}
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="row-button"
                      data-testid="settings-check-app-updates"
                      onclick={handleCheckForUpdates}
                      disabled={updateChecking || appUpdateInstalling}
                      aria-busy={updateChecking}
                    >
                      {updateChecking ? "Checking…" : "Check Now"}
                    </button>
                  </div>
                </div>
                <div
                  class="setting-row core-update-row"
                  class:has-core-log={coreInstallResult === "err" &&
                    coreInstallLogPath !== null}
                >
                  <span>
                    <strong>HQ Core</strong>
                    <small data-testid="settings-core-status"
                      >{coreStatusLabel}</small
                    >
                    {#if driftDetailError}
                      <small
                        class="row-action-error"
                        role="alert"
                        data-testid="settings-drift-error"
                        >{driftDetailError}</small
                      >
                    {/if}
                    {#if coreInstallResult === "err" && coreInstallLogPath}
                      <small
                        class="core-log-path"
                        data-testid="settings-core-install-log-path"
                        title={coreInstallLogPath}
                      >
                        Install log: <code>{coreInstallLogPath}</code>
                      </small>
                    {/if}
                  </span>
                  <div class="row-actions">
                    <span
                      class="version-chip core"
                      data-testid="settings-core-version"
                    >
                      {coreVersionLabel}
                    </span>
                    {#if coreInstallResult === "err" && coreInstallLogPath}
                      <button
                        type="button"
                        class="row-button"
                        data-testid="settings-copy-core-install-log-path"
                        onclick={handleCopyCoreInstallLogPath}
                        disabled={coreLogCopyState === "copying"}
                        aria-busy={coreLogCopyState === "copying"}
                        title={`Copy install log path: ${coreInstallLogPath}`}
                      >
                        {coreLogCopyState === "copying"
                          ? "Copying…"
                          : coreLogCopyState === "copied"
                            ? "Path copied"
                            : coreLogCopyState === "failed"
                              ? "Copy failed"
                              : "Copy log path"}
                      </button>
                      <button
                        type="button"
                        class="row-button"
                        data-testid="settings-open-core-install-log"
                        onclick={handleOpenCoreInstallLog}
                        disabled={coreLogOpenState === "opening"}
                        aria-busy={coreLogOpenState === "opening"}
                        title={`Open install log: ${coreInstallLogPath}`}
                      >
                        {coreLogOpenState === "opening"
                          ? "Opening…"
                          : coreLogOpenState === "opened"
                            ? "Opened"
                            : coreLogOpenState === "failed"
                              ? "Open failed"
                              : "Open log"}
                      </button>
                    {/if}
                    {#if coreHasDrift}
                      <button
                        type="button"
                        class="row-button"
                        onclick={handleOpenDriftDetail}
                        disabled={driftDetailOpening ||
                          coreStateLoading ||
                          coreRefreshing ||
                          coreChannelPending}
                        aria-busy={driftDetailOpening ||
                          coreStateLoading ||
                          coreRefreshing ||
                          coreChannelPending}
                      >
                        {coreChannelPending
                          ? "Saving channel…"
                          : coreStateLoading || coreRefreshing
                            ? "Checking…"
                            : driftDetailOpening
                              ? "Opening…"
                              : driftDetailError
                                ? "Retry details"
                                : `${coreState?.driftReport.count} drifted`}
                      </button>
                    {/if}
                    {#if coreNeedsUpdate}
                      <button
                        type="button"
                        class="row-button primary"
                        onclick={handleInstallCore}
                        disabled={coreInstalling ||
                          coreStateLoading ||
                          coreRefreshing ||
                          coreChannelPending}
                        aria-busy={coreInstalling ||
                          coreStateLoading ||
                          coreRefreshing ||
                          coreChannelPending}
                      >
                        {coreChannelPending
                          ? "Saving channel…"
                          : coreStateLoading || coreRefreshing
                            ? "Checking…"
                            : coreInstalling
                              ? "Updating…"
                              : coreUpdateLabel}
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="row-button"
                      data-testid="settings-refresh-core"
                      onclick={handleRefreshCore}
                      disabled={coreBusy}
                      aria-busy={coreRefreshing ||
                        coreVersionLoading ||
                        coreStateLoading}
                    >
                      {coreRefreshing || coreVersionLoading || coreStateLoading
                        ? "Checking…"
                        : "Refresh"}
                    </button>
                  </div>
                </div>
                <div class="setting-row" data-testid="settings-cli-row">
                  <span>
                    <strong>HQ CLI</strong>
                    <small
                      data-testid="settings-cli-status"
                      role={hqCliUpdateError ? "alert" : undefined}
                      aria-live="polite">{hqCliStatusLabel}</small
                    >
                    {#if hqCliCmdCopyError}
                      <small
                        class="row-action-error"
                        role="alert"
                        data-testid="settings-cli-copy-error"
                        >{hqCliCmdCopyError}</small
                      >
                    {/if}
                  </span>
                  <div class="row-actions">
                    <span
                      class="version-chip"
                      data-testid="settings-cli-version"
                    >
                      {hqCliVersionLabel}
                    </span>
                    {#if hqCliUpdate}
                      <button
                        type="button"
                        class="row-button primary"
                        onclick={handleInstallHqCliUpdate}
                        disabled={hqCliInstalling || hqCliChecking}
                        aria-busy={hqCliInstalling}
                      >
                        {hqCliInstalling
                          ? "Installing…"
                          : `Update to v${hqCliUpdate.latest}`}
                      </button>
                    {/if}
                    {#if (!hqCliVersion || hqCliUpdateError) && !hqCliNonConvergent}
                      <button
                        type="button"
                        class="row-button"
                        onclick={copyHqCliCommand}
                        disabled={hqCliCmdCopying}
                        aria-busy={hqCliCmdCopying}
                        title={HQ_CLI_UPGRADE_CMD}
                      >
                        {hqCliCmdCopying
                          ? "Copying…"
                          : hqCliCmdCopied
                            ? "Command copied"
                            : hqCliCmdCopyError
                              ? "Copy failed — retry"
                              : "Copy install command"}
                      </button>
                    {/if}
                    {#if hqCliUpdate}
                      <button
                        type="button"
                        class="row-button"
                        onclick={handleDismissHqCliUpdate}
                        disabled={hqCliDismissing || hqCliInstalling}
                        aria-busy={hqCliDismissing || hqCliInstalling}
                      >
                        {hqCliDismissing
                          ? "Dismissing…"
                          : hqCliUpdateErrorContext === "dismiss"
                            ? "Retry dismiss"
                            : "Dismiss"}
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="row-button"
                      data-testid="settings-check-cli-updates"
                      onclick={refreshHqCliSurface}
                      disabled={hqCliChecking ||
                        hqCliInstalling ||
                        hqCliDismissing}
                      aria-busy={hqCliChecking}
                    >
                      {hqCliChecking ? "Checking…" : "Check Now"}
                    </button>
                  </div>
                </div>
              </div>

              {#if canManagePackages && packUpdate && packUpdate.count > 0}
                <div class="settings-card notice-card">
                  <div class="setting-row notice-row">
                    <span>
                      <strong>{packUpdateTitle(packUpdate.count)}</strong>
                      <small>
                        {#if packUpdateError}
                          Update failed. Run <code>hq packs update</code>.
                        {:else}
                          {packUpdate.names.join(", ")}
                        {/if}
                      </small>
                    </span>
                    <button
                      type="button"
                      class="row-button primary"
                      data-testid="settings-update-packs"
                      onclick={handleUpdatePacks}
                      disabled={packsUpdating}
                      aria-busy={packsUpdating}
                      aria-label={packsUpdating
                        ? "Updating installed packs"
                        : "Update installed packs"}
                    >
                      {packsUpdating ? "Updating…" : "Update"}
                    </button>
                  </div>
                </div>
              {/if}
            {/if}
          </section>

          <section
            id="general"
            class="settings-section"
            hidden={activeTab !== "general"}
          >
            <h2>General</h2>
            <div class="settings-card">
              {#if !canTray || settingsUnavailable}
                <UnavailableNote
                  label="Startup &amp; Dock"
                  message="Start-at-login and Dock options live on the HQ desktop app."
                  testid="settings-general-unavailable"
                />
              {:else}
                <label class="setting-row">
                  <span>
                    <strong>Start at login</strong>
                    <small>Open HQ when your computer starts.</small>
                    {#if liveControlErrors["start-at-login"]}
                      <small
                        class="row-action-error"
                        role="alert"
                        data-testid="settings-start-at-login-error"
                        >{liveControlErrors["start-at-login"]}</small
                      >
                    {/if}
                  </span>
                  <input
                    type="checkbox"
                    bind:checked={startAtLogin}
                    onchange={applyStartAtLogin}
                    disabled={isSettingsControlPending("start-at-login")}
                    aria-busy={isSettingsControlPending("start-at-login")}
                  />
                </label>
                {#if isMacOS}
                  <!-- macOS-only: Windows and Linux have no activation policy, and HQ
               already owns a taskbar entry there, so the row would be a no-op. -->
                  <label class="setting-row">
                    <span>
                      <strong>Show in Dock</strong>
                      <small
                        >Keep an HQ icon in the Dock. Turn this off to run HQ
                        from the menu bar only.</small
                      >
                      {#if liveControlErrors["dock-icon"]}
                        <small
                          class="row-action-error"
                          role="alert"
                          data-testid="settings-dock-icon-error"
                          >{liveControlErrors["dock-icon"]}</small
                        >
                      {/if}
                    </span>
                    <input
                      id="toggle-dock-icon"
                      data-testid="dock-icon-toggle"
                      type="checkbox"
                      bind:checked={dockIcon}
                      onchange={applyDockIcon}
                      aria-label="Show in Dock"
                      disabled={isSettingsControlPending("dock-icon")}
                      aria-busy={isSettingsControlPending("dock-icon")}
                    />
                  </label>
                {/if}
              {/if}
              <label class="setting-row" data-testid="telemetry-row">
                <span>
                  <strong>Usage telemetry</strong>
                  <small
                    >Share anonymized usage counts to improve HQ. You can turn
                    this off any time.</small
                  >
                  {#if telemetryEnabled === null}
                    <small
                      class="telemetry-note"
                      data-testid="telemetry-checking"
                      >Checking your current choice…</small
                    >
                  {:else}
                    {#if telemetrySource === "local-cache"}
                      <small
                        class="telemetry-note"
                        data-testid="telemetry-offline"
                        >Showing your last known choice from this device — we
                        couldn't reach the server to confirm it just now.</small
                      >
                    {/if}
                    {#if telemetrySource === "server"}
                      {@const answeredOn =
                        formatConsentAnsweredAt(telemetryUpdatedAt)}
                      {#if answeredOn}
                        <small
                          class="telemetry-note"
                          data-testid="telemetry-answered-at"
                          >You answered this on {answeredOn}.</small
                        >
                      {/if}
                      {#if telemetryConsentVersion !== null}
                        <small
                          class="telemetry-note"
                          data-testid="telemetry-consent-version"
                          >Recorded against telemetry notice version {telemetryConsentVersion}.</small
                        >
                      {/if}
                    {/if}
                  {/if}
                </span>
                <input
                  type="checkbox"
                  data-testid="telemetry-toggle"
                  checked={telemetryEnabled === true}
                  disabled={telemetryEnabled === null || telemetryBusy}
                  aria-busy={telemetryEnabled === null || telemetryBusy}
                  onchange={(event) => {
                    telemetryEnabled = event.currentTarget.checked;
                    void applyTelemetryPreference();
                  }}
                />
              </label>
              <div class="setting-row">
                <span
                  ><strong>Version</strong><small>HQ desktop app build</small
                  ></span
                >
                <span class="version-value">
                  {appVersion
                    ? `v${appVersion}`
                    : appVersionLoadFailed
                      ? "Unavailable"
                      : "Reading…"}
                </span>
              </div>
              <div class="setting-row">
                <span>
                  <strong>Account</strong>
                  <small
                    >Sign out returns you to the menu bar sign-in screen.</small
                  >
                  {#if accountActionError}
                    <small
                      class="row-action-error"
                      role="alert"
                      data-testid="settings-account-error"
                      >{accountActionError}</small
                    >
                  {/if}
                </span>
                <div class="row-actions">
                  <button
                    type="button"
                    class="row-button"
                    data-testid="settings-sign-out"
                    onclick={requestSignOut}
                    disabled={signingOut || quitting}
                    aria-busy={signingOut}
                  >
                    {signingOut
                      ? "Signing out…"
                      : accountRetryAction === "sign-out"
                        ? "Retry sign out"
                        : "Sign out"}
                  </button>
                  {#if canTray}
                    <button
                      type="button"
                      class="row-button danger"
                      data-testid="settings-quit"
                      onclick={handleQuit}
                      disabled={quitting || signingOut}
                      aria-busy={quitting}
                    >
                      {quitting
                        ? "Quitting…"
                        : accountRetryAction === "quit"
                          ? "Retry quit"
                          : "Quit HQ"}
                    </button>
                  {/if}
                </div>
              </div>
            </div>
          </section>
        </fieldset>

        <section
          id="appearance"
          class="settings-section"
          hidden={activeTab !== "appearance"}
          data-testid="settings-appearance"
        >
          <h2>Appearance</h2>
          {#if !appearanceSeam && !zoomSeam}
            <div class="settings-card">
              <UnavailableNote
                label="Appearance"
                message="Window theme, opacity, and zoom are controlled by the HQ desktop app."
                testid="settings-appearance-unavailable"
              />
            </div>
          {:else}
            <div class="settings-card">
              {#if appearanceSeam}
                <div class="setting-row appearance-row">
                  <span>
                    <strong>Theme</strong>
                    <small>Follow your system or keep HQ light or dark.</small>
                  </span>
                  <div
                    class="theme-options"
                    role="radiogroup"
                    aria-label="Theme"
                  >
                    {#each appearanceThemes as theme (theme.id)}
                      <label class="theme-option">
                        <input
                          type="radio"
                          name="appearance-theme"
                          value={theme.id}
                          checked={isDesktopShell
                            ? theme.id === "dark"
                            : appearance.colorTheme === theme.id}
                          onchange={() =>
                            updateAppearance({ colorTheme: theme.id })}
                        />
                        <span>{theme.label}</span>
                      </label>
                    {/each}
                  </div>
                </div>

                <label class="setting-row appearance-row">
                  <span>
                    <strong>Window opacity</strong>
                    <small
                      >100% is fully solid. Lower values reveal more native
                      vibrancy.</small
                    >
                  </span>
                  <span class="range-control">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={windowOpacity}
                      aria-label="Window opacity"
                      aria-valuetext={`${windowOpacity}%`}
                      oninput={(event) =>
                        updateAppearance({
                          windowTransparency: windowTransparencyFromOpacity(
                            event.currentTarget.valueAsNumber,
                          ),
                        })}
                    />
                    <output aria-live="polite">{windowOpacity}%</output>
                  </span>
                </label>
              {/if}

              {#if zoomSeam}
                <label class="setting-row appearance-row">
                  <span>
                    <strong>Interface size</strong>
                    <small
                      >Changes every HQ window. Use ⌘/Ctrl +, −, or 0 anytime.</small
                    >
                  </span>
                  <span class="range-control">
                    <input
                      type="range"
                      min={MIN_DESKTOP_ZOOM}
                      max={MAX_DESKTOP_ZOOM}
                      step="0.1"
                      value={interfaceZoom}
                      aria-label="Interface size"
                      aria-valuetext={`${Math.round(interfaceZoom * 100)}%`}
                      oninput={(event) =>
                        updateInterfaceZoom(event.currentTarget.valueAsNumber)}
                    />
                    <output aria-live="polite"
                      >{Math.round(interfaceZoom * 100)}%</output
                    >
                  </span>
                </label>
              {/if}
            </div>
          {/if}
        </section>

        <!--
          DEAD / UNMOUNTED meetings settings section.
          The live V2 shell mounts PrototypeSettingsPanes.svelte via
          ShellSettings.svelte as the single source of truth for meeting
          prefs (detection, platforms, recordingCompanyId). This block is
          retained so SettingsPage's other tabs/tests keep compiling; do
          not wire new meeting behavior here — edit PrototypeSettingsPanes.
        -->
        <fieldset
          class="settings-controls"
          disabled={!settingsReady && !settingsUnavailable}
        >
          <section
            id="meetings"
            class="settings-section"
            hidden={activeTab !== "meetings"}
          >
            <h2>Meetings</h2>
            <div class="settings-card">
              {#if settingsUnavailable}
                <UnavailableNote
                  label="Meeting detection"
                  message="Meeting detection and recording defaults are configured on the HQ desktop app."
                  testid="settings-meetings-unavailable"
                />
              {:else}
                <label class="setting-row" class:gated-row={!meetingsEnabled}>
                  <span
                    ><strong>Meeting detection</strong><small
                      >Detect active meeting apps and surface recording actions.</small
                    ></span
                  >
                  <input
                    type="checkbox"
                    disabled={isSettingsControlPending("meeting-detection") ||
                      isSettingsControlPending("meeting-platforms") ||
                      !meetingsEnabled}
                    aria-busy={isSettingsControlPending("meeting-detection")}
                    bind:checked={meetingDetectEnabled}
                    onchange={() => void saveMeetingDetection()}
                  />
                  {#if !meetingsEnabled}<em>Unavailable</em>{/if}
                </label>
                {#if meetingDetectEnabled}
                  <!-- Only shown when detection is on — otherwise the platform toggles
               looked actionable but changed nothing (detection was off). -->
                  <div class="setting-row platform-row">
                    <span
                      ><strong>Platforms</strong><small
                        >Choose which meeting apps are watched.</small
                      ></span
                    >
                    <div
                      class="platforms"
                      aria-busy={isSettingsControlPending("meeting-platforms")}
                    >
                      {#each platforms as platform (platform)}
                        <button
                          type="button"
                          class:active={meetingDetectPlatforms.includes(
                            platform,
                          )}
                          onclick={() => togglePlatform(platform)}
                          disabled={isSettingsControlPending(
                            "meeting-platforms",
                          ) || isSettingsControlPending("meeting-detection")}
                        >
                          {platform}
                        </button>
                      {/each}
                    </div>
                  </div>
                  <div class="setting-row">
                    <span>
                      <strong>Ledger</strong>
                      <small class="ledger-path"
                        >~/.hq/meeting-notify-ledger.json</small
                      >
                    </span>
                  </div>
                {/if}
                <!-- A validated dropdown of the caller's active memberships, not a
             free-text UID field. The old text input saved an arbitrary,
             unvalidated string (and only on blur, so it often never saved) — a
             bad UID then silently fell back to Personal at recording time. -->
                <label class="setting-row">
                  <span
                    ><strong>Default recording company</strong><small
                      >Attribution for new recordings. Changeable per-recording.</small
                    ></span
                  >
                  <select
                    value={defaultRecordingCompanyUid ?? ""}
                    aria-label="Default recording company"
                    disabled={isSettingsControlPending(
                      "default-recording-company",
                    )}
                    aria-busy={isSettingsControlPending(
                      "default-recording-company",
                    )}
                    onchange={(event) => {
                      const v = event.currentTarget.value;
                      defaultRecordingCompanyUid = v === "" ? null : v;
                      void persistSettingsControl("default-recording-company", {
                        defaultRecordingCompanyUid,
                      });
                    }}
                  >
                    <option value="">Personal</option>
                    {#each memberships as m (m.companyUid)}
                      <option value={m.companyUid}
                        >{m.companyName?.trim() || "Company"}</option
                      >
                    {/each}
                  </select>
                </label>
              {/if}
              <!-- Meeting permissions monitor — the only place to grant the macOS TCC
             permissions the SDK needs. Without it the desktop window couldn't
             grant them at all. -->
              {#if canTray}
                <div class="setting-row">
                  <span>
                    <strong>Meeting permissions</strong>
                    <small>
                      {#if !meetingPermissions}
                        Checking system privacy permissions…
                      {:else if meetingPermissions.allRequiredGranted}
                        Accessibility, screen recording &amp; microphone all
                        granted
                      {:else}
                        One or more system permissions need attention
                      {/if}
                    </small>
                  </span>
                  <button
                    type="button"
                    class="row-button"
                    onclick={handleOpenMeetingPermissionsWizard}
                    disabled={meetingPermissionsOpening}
                    aria-busy={meetingPermissionsOpening}
                  >
                    {meetingPermissionsOpening ? "Opening…" : "Manage"}
                  </button>
                </div>
              {/if}
            </div>
          </section>
        </fieldset>
      </div>
    </div>
  </main>
</section>

<ConfirmDialog
  open={signOutConfirmOpen}
  title="Sign out"
  message="Sign out of HQ Work on this machine?"
  confirmLabel="Sign out"
  danger
  oncancel={() => (signOutConfirmOpen = false)}
  onconfirm={() => {
    signOutConfirmOpen = false;
    void handleSignOut();
  }}
/>

<style>
  .settings-page {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    color: var(--v4-text-1);
    font-family: var(--font-sans);
  }

  .settings-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 52px;
    height: 52px;
    padding: 0;
    border-bottom: 1px solid var(--line);
  }

  .settings-sub {
    min-width: 0;
    overflow: hidden;
    color: var(--t3);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .settings-split {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }

  .settings-pane {
    flex: 1 1 auto;
    min-width: 0;
    overflow: auto;
  }

  /* ── US-020 single-pane section index — parity-token styling ─────────── */
  .settings-index {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 0 0 210px;
    width: 210px;
    min-width: 0;
    padding: 16px 20px;
    border-right: 1px solid var(--line);
    overflow: auto;
  }

  .settings-index-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 10px;
    border: 0;
    border-radius: 8px;
    background: var(--raised);
    color: var(--t1);
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .settings-index-row:hover {
    background: var(--hover);
  }
  .settings-index .settings-index-row:not(.on) {
    background: transparent;
    color: var(--t2);
  }
  .settings-index-row.on {
    background: var(--sel);
    color: var(--t1);
    font-weight: 500;
  }

  .settings-index-row + .settings-index-row {
    margin-top: 0;
  }

  .settings-index-label {
    font-weight: 500;
  }

  .settings-index-chevron {
    color: var(--t3);
    font-size: var(--text-base);
    line-height: 1;
    opacity: 0;
    width: 0;
    overflow: hidden;
  }

  .settings-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 5px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: none;
    color: var(--t2);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }

  .settings-back:hover {
    color: var(--t1);
  }

  .settings-controls {
    display: grid;
    gap: var(--v4-space-5);
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
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
    gap: 0;
    min-width: 0;
    flex: 1 1 auto;
    min-height: 0;
    container-name: settings-main;
    container-type: inline-size;
    overflow: visible;
  }

  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
  }

  .settings-section {
    display: grid;
    gap: 8px;
    scroll-margin-top: 12px;
  }

  /* US-020 single pane: `display: grid` above would defeat the `hidden`
     attribute (author styles beat the UA [hidden] rule), so re-assert it —
     exactly one section may be visible at a time. */
  .settings-section[hidden] {
    display: none;
  }

  /* The page h1 already names the open section — the in-section h2 would
     read twice in the single pane. Kept in the DOM for structure/AT. */
  .settings-section > h2 {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .settings-card {
    display: grid;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .setting-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    margin-bottom: 10px;
    padding: 14px 16px;
    border: 1px solid var(--line, var(--v4-rowline));
    border-top: 1px solid var(--v4-rowline);
    border-radius: 10px;
    background: var(--raised, var(--v4-raised));
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

  /* Provenance + offline notes wrap over multiple lines instead of being
     truncated like the single-line description above them. */
  .telemetry-note {
    display: block;
    margin-top: 4px;
    overflow: visible;
    white-space: normal;
    color: var(--v4-text-3, var(--v4-text-2));
  }

  strong {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    font-weight: 500;
  }

  small,
  .setting-row div span {
    color: var(--v4-text-3);
    font-size: var(--text-base);
    line-height: 1.35;
  }

  .error {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-3);
    margin: 0;
    padding: 9px 0;
    border-bottom: 1px solid var(--v4-rowline);
    background: color-mix(in srgb, var(--v4-ground) 68%, transparent);
    backdrop-filter: var(--v4-glass-filter-soft);
    -webkit-backdrop-filter: var(--v4-glass-filter-soft);
    color: var(--v4-error);
    font-size: var(--text-base);
    line-height: 1.35;
  }

  .error span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .error button {
    flex: 0 0 auto;
    min-height: 28px;
    padding: 0 var(--v4-space-3);
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    cursor: pointer;
  }

  .error button:disabled {
    opacity: 0.55;
    cursor: progress;
  }

  .row-action-error {
    color: var(--v4-error);
  }

  input,
  select {
    min-width: 0;
  }

  /* macOS-style toggle pill — the one place green is allowed as a control fill
     (SPEC §5/§6: "26×16 pills, on = green fill — the one non-dot color
     exception, matching macOS"). The track and knob route through shared tokens. */
  input[type="checkbox"] {
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

  input[type="checkbox"]::after {
    content: "";
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

  input[type="checkbox"]:checked {
    background: var(--v4-ok);
  }

  input[type="checkbox"]:checked::after {
    transform: translateX(10px);
  }

  input[type="checkbox"]:disabled {
    opacity: 0.5;
    cursor: default;
  }

  input[aria-busy="true"],
  select[aria-busy="true"],
  .platforms[aria-busy="true"] {
    cursor: progress;
  }

  input[type="checkbox"]:focus-visible {
    outline: 1.5px solid var(--v4-text-2);
    outline-offset: 2px;
  }

  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
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
    /* Follow OS appearance — never lock the native control to dark (US-003). */
    color-scheme: light dark;
  }

  select option {
    background: var(--v4-raised);
    color: var(--v4-text-1);
  }

  :global(html[data-force-theme="light"]) select {
    color-scheme: light;
  }

  .theme-options {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 16px;
  }

  .theme-option {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    color: var(--v4-text-2);
    font-size: var(--text-base);
    cursor: pointer;
  }

  input[type="radio"] {
    appearance: none;
    -webkit-appearance: none;
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    margin: 0;
    border: 1px solid var(--v4-text-3);
    border-radius: 50%;
    background: transparent;
  }

  input[type="radio"]::after {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-text-1);
    transform: scale(0);
    transition: transform 120ms var(--ease-out);
  }

  input[type="radio"]:checked {
    border-color: var(--v4-text-1);
  }

  input[type="radio"]:checked::after {
    transform: scale(1);
  }

  input[type="radio"]:checked + span {
    color: var(--v4-text-1);
    font-weight: 500;
  }

  input[type="radio"]:focus-visible {
    outline: 1.5px solid var(--v4-focus-ring);
    outline-offset: 3px;
  }

  .range-control {
    display: grid;
    grid-template-columns: minmax(116px, 176px) 44px;
    align-items: center;
    justify-content: end;
    gap: 10px;
    min-width: 190px;
  }

  .range-control input[type="range"] {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    height: 20px;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }

  .range-control input[type="range"]::-webkit-slider-runnable-track {
    height: 2px;
    border-radius: 1px;
    background: var(--v4-hairline);
  }

  .range-control input[type="range"]::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -6px;
    border: 1px solid var(--v4-control-border);
    border-radius: 50%;
    background: var(--v4-text-1);
    box-shadow: var(--v4-shadow-card);
  }

  .range-control input[type="range"]:focus-visible {
    outline: none;
  }

  .range-control input[type="range"]:focus-visible::-webkit-slider-thumb {
    outline: 1.5px solid var(--v4-focus-ring);
    outline-offset: 3px;
  }

  .range-control output {
    color: var(--v4-text-2);
    font-size: var(--text-base);
    font-variant-numeric: tabular-nums;
    text-align: right;
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
    border-radius: var(--v4-radius-button);
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

  .platforms button:disabled {
    opacity: 0.5;
    cursor: progress;
  }

  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
    min-width: 0;
    max-width: 100%;
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

  .row-button[aria-busy="true"] {
    cursor: progress;
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

  .version-chip {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 9px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, var(--text-xs));
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }

  .version-chip.core {
    border-color: color-mix(in srgb, var(--v4-ok) 32%, var(--v4-hairline));
    background: color-mix(in srgb, var(--v4-ok) 8%, var(--v4-control-faint));
    color: var(--v4-text-1);
  }

  .notice-card {
    margin-top: 8px;
    border-top: 1px solid var(--v4-rowline);
    background: transparent;
  }

  .notice-row {
    align-items: start;
  }

  .ledger-path {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .core-log-path {
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .core-log-path code {
    color: var(--v4-text-2);
    overflow-wrap: anywhere;
  }

  /* A failed rescue adds recovery controls to an already action-rich row.
     Give that exceptional state its own open two-line layout so status and
     paths remain readable instead of donating nearly all width to buttons. */
  .core-update-row.has-core-log {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 8px;
  }

  .core-update-row.has-core-log small {
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
  }

  .core-update-row.has-core-log .row-actions {
    width: 100%;
    justify-content: flex-start;
  }

  code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.92em;
  }

  @media (prefers-reduced-motion: reduce) {
    input[type="checkbox"],
    input[type="checkbox"]::after,
    input[type="radio"]::after {
      transition: none;
    }
  }

  @container settings-main (max-width: 760px) {
    #updates .setting-row {
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
      gap: 8px;
    }

    #updates .setting-row small {
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
    }

    #updates .row-actions {
      width: 100%;
      justify-content: flex-start;
    }

    #updates .setting-row > input,
    #updates .setting-row > select,
    #updates .setting-row > em {
      justify-self: start;
    }

    .appearance-row {
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
      gap: 8px;
    }

    .theme-options {
      justify-content: flex-start;
    }

    .range-control {
      width: min(100%, 280px);
      justify-self: start;
    }
  }
</style>
