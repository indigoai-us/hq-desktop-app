<script lang="ts">
  /**
   * Host settings sections — Daybook / preview-v2 set-row + toggle language.
   * Prefs persist locally; host seams (autostart, folder, versions, calendars)
   * are used when they exist.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import {
    APPEARANCE_SIZES,
    APPEARANCE_THEMES,
    MEETING_PLATFORM_ORDER,
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
  import { HQ_CONSOLE_INTEGRATIONS_URL } from "../common/hq-console";
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
  }

  let {
    section,
    version = "0.0.0",
    adapter = null,
    storage = typeof window !== "undefined" ? window.localStorage : null,
    sessionGeneration = 0,
    companies = [],
    personalLabel = null,
    onopenconsole,
    consoleBase: _consoleBase = HQ_CONSOLE_BASE,
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
  let liveSync = $state<LiveSyncStatus>({ ...EMPTY_LIVE_SYNC });
  let dockVisibilityChanged = false;
  let desktopWidgetChanged = false;
  let dockWriteSeq = 0;
  let desktopWidgetWriteSeq = 0;
  let dockAuthoritativeValue: boolean | undefined;
  let desktopWidgetAuthoritativeValue: boolean | undefined;

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
  const companyOptions = $derived([
    ...lists.active,
    ...(lists.personal ? [lists.personal] : []),
  ]);
  const defaultCompany = $derived(
    companyOptions.find((row) => row.id === prefs.defaultCompanyId) ??
      companyOptions[0] ??
      null,
  );
  const recordingCompany = $derived(
    companyOptions.find((row) => row.id === prefs.recordingCompanyId) ??
      defaultCompany,
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

  function setDefaultCompany(id: string): void {
    patch({ defaultCompanyId: id });
    const row = companyOptions.find((item) => item.id === id);
    if (row && adapter) {
      void adapter.appShell.setActiveCompany(row.slug);
    }
  }

  function setRecordingCompany(id: string): void {
    patch({ recordingCompanyId: id });
  }

  async function toggleLaunch(): Promise<void> {
    const next = !prefs.launchAtLogin;
    patch({ launchAtLogin: next });
    if (adapter) void adapter.appShell.setAutostart(next);
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

  function togglePlatform(name: string): void {
    patch({
      meetingPlatforms: {
        ...prefs.meetingPlatforms,
        [name]: !prefs.meetingPlatforms[name],
      },
    });
  }

  /**
   * Match hq-desktop-app Settings UX:
   * - denied → deep-link System Settings (OS will not re-show the dialog)
   * - prompt/unknown → requestAuthorization (system dialog when notDetermined)
   * Never auto-prompt on launch — only from this control.
   */
  async function enableNotifications(): Promise<void> {
    if (!adapter || notifRequesting) return;
    notifPermissionError = null;
    // Denied: do not flip notifRequesting into "Requesting…" — open Settings.
    if (notifPermission === "denied") {
      try {
        await openExternalUrl(
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
      if (res.ok) {
        notifPermission = String(res.value);
        if (res.value === "prompt") {
          notifPermissionError =
            "macOS didn’t show a permission prompt. Try again, or allow HQ Work in System Settings → Notifications.";
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

  function readFolderFromSettings(raw: unknown): string | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    for (const key of [
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

  onMount(() => {
    applyUiSize(prefs.uiSize);
    applyWindowOpacity(prefs.windowOpacity);
    if (adapter?.isAvailable("canSync")) {
      void readLiveSyncStatus(adapter).then((next) => {
        liveSync = next;
        if (next.hqFolderPath) hqFolder = next.hqFolderPath;
      });
    }
    if (!adapter) return;
    void refreshNotifPermission();
    // Re-read after returning from System Settings (v1 SettingsPage pattern).
    const onFocus = () => {
      void refreshNotifPermission();
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
    if (adapter.isAvailable("canSelfUpdate")) {
      void adapter.updates.getVersions().then((res) => {
        if (!res.ok || !res.value) return;
        if (typeof res.value.app === "string" && res.value.app) {
          appVersion = res.value.app;
        }
        if (typeof res.value.core === "string" && res.value.core) {
          coreVersion = res.value.core;
        }
        if (typeof res.value.cli === "string" && res.value.cli) {
          cliVersion = res.value.cli;
        }
      });
    }
    const canReadSettings =
      adapter.isAvailable("canSync") || adapter.isAvailable("trayAndWindow");
    if (canReadSettings) {
      void adapter.settings.getSettings().then((res) => {
        if (!res.ok) return;
        if (adapter.isAvailable("canSync")) {
          hqFolder = readFolderFromSettings(res.value) ?? hqFolder;
        }
        if (adapter.isAvailable("trayAndWindow")) {
          hydrateHostBackedToggles(res.value);
        }
      });
    }
    if (adapter.isAvailable("canSync")) {
      void adapter.settings.getConfig().then((res) => {
        if (res.ok) hqFolder = readFolderFromSettings(res.value) ?? hqFolder;
      });
    }
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  });
</script>

<div class="proto" data-testid={`settings-${section}-pane`}>
  {#if section === "general"}
    {#if canTray}
      <div class="set-row">
        <div>
          <div class="sn">Launch at login</div>
          <div class="sd">Start HQ when you sign in to your Mac</div>
        </div>
        <button
          type="button"
          class="toggle"
          class:on={prefs.launchAtLogin}
          role="switch"
          aria-checked={prefs.launchAtLogin}
          aria-label="Launch at login"
          onclick={() => void toggleLaunch()}
        ></button>
      </div>
      <div class="set-row">
        <div>
          <div class="sn">Show in Dock</div>
          <div class="sd">Keep HQ in the Dock and ⌘-Tab switcher</div>
        </div>
        <button
          type="button"
          class="toggle"
          class:on={prefs.showInDock}
          role="switch"
          aria-checked={prefs.showInDock}
          aria-label="Show in Dock"
          onclick={() => void toggleDock()}
        ></button>
      </div>
      <div class="set-row">
        <div>
          <div class="sn">Menubar quick access</div>
          <div class="sd">Keep the compact popover in the menu bar</div>
        </div>
        <button
          type="button"
          class="toggle"
          class:on={prefs.menubarAccess}
          role="switch"
          aria-checked={prefs.menubarAccess}
          aria-label="Menubar quick access"
          onclick={() => patch({ menubarAccess: !prefs.menubarAccess })}
        ></button>
      </div>
      <div class="set-row">
        <div>
          <div class="sn">Desktop widget</div>
          <div class="sd">
            Float the mini notifications widget on your desktop
          </div>
        </div>
        <button
          type="button"
          class="toggle"
          class:on={prefs.desktopWidget}
          role="switch"
          aria-checked={prefs.desktopWidget}
          aria-label="Desktop widget"
          onclick={() => void toggleDesktopWidget()}
        ></button>
      </div>
    {/if}
    <div class="set-row">
      <div>
        <div class="sn">Default company</div>
        <div class="sd">Which company loads on launch</div>
      </div>
      {#if companyOptions.length > 0}
        <label class="sr-only" for="default-company">Default company</label>
        <select
          id="default-company"
          class="mono-select"
          value={defaultCompany?.id ?? ""}
          onchange={(event) => setDefaultCompany(event.currentTarget.value)}
        >
          {#each companyOptions as row (row.id)}
            <option value={row.id}>{row.name}</option>
          {/each}
        </select>
      {:else}
        <span class="mono">Personal</span>
      {/if}
    </div>
    {#if !canSelfUpdate}
      <div class="set-row">
        <div>
          <div class="sn">Web app</div>
          <div class="sd mono-path">v{appVersion}</div>
        </div>
        <span class="mono">This site</span>
      </div>
    {/if}
  {:else if section === "appearance"}
    <div class="set-row">
      <div>
        <div class="sn">Theme</div>
        <div class="sd">Follow the system or pick one</div>
      </div>
      <div class="theme-pills" role="radiogroup" aria-label="Color theme">
        {#each APPEARANCE_THEMES as option (option.id)}
          <button
            type="button"
            class="chip"
            class:on={theme === option.id}
            role="radio"
            aria-checked={theme === option.id}
            data-testid={`settings-theme-${option.id}`}
            onclick={() => setTheme(option.id)}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
    {#if canTray}
      <div class="set-row">
        <div>
          <div class="sn">Window opacity</div>
          <div class="sd">How much desktop shows through the glass</div>
        </div>
        <div class="range-wrap">
          <input
            type="range"
            min="50"
            max="100"
            value={prefs.windowOpacity}
            aria-label="Window opacity"
            oninput={(event) => setOpacity(Number(event.currentTarget.value))}
          />
          <span class="mono range-val">{prefs.windowOpacity}%</span>
        </div>
      </div>
    {/if}
    <div class="set-row">
      <div>
        <div class="sn">Interface size</div>
        <div class="sd">Density of text and controls</div>
      </div>
      <div class="theme-pills" role="radiogroup" aria-label="Interface size">
        {#each APPEARANCE_SIZES as option (option.id)}
          <button
            type="button"
            class="chip"
            class:on={prefs.uiSize === option.id}
            role="radio"
            aria-checked={prefs.uiSize === option.id}
            onclick={() => setUiSize(option.id)}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
  {:else if section === "notifications"}
    <div class="set-row">
      <div>
        <div class="sn">Agent completion</div>
        <div class="sd">Ping when a run finishes or needs review</div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={prefs.notifyComplete}
        role="switch"
        aria-checked={prefs.notifyComplete}
        aria-label="Agent completion"
        onclick={() => patch({ notifyComplete: !prefs.notifyComplete })}
      ></button>
    </div>
    {#if canSync}
      <div class="set-row">
        <div>
          <div class="sn">Sync notifications</div>
          <div class="sd">Notify when sync needs attention</div>
        </div>
        <button
          type="button"
          class="toggle"
          class:on={prefs.notifySync}
          role="switch"
          aria-checked={prefs.notifySync}
          aria-label="Sync notifications"
          onclick={() => patch({ notifySync: !prefs.notifySync })}
        ></button>
      </div>
    {/if}
    <div class="set-row">
      <div>
        <div class="sn">Share notifications</div>
        <div class="sd">Show file-share activity from teammates</div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={prefs.notifyShare}
        role="switch"
        aria-checked={prefs.notifyShare}
        aria-label="Share notifications"
        onclick={() => patch({ notifyShare: !prefs.notifyShare })}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">DM notifications</div>
        <div class="sd">
          Native macOS banners for DMs and channel messages when HQ Work is in
          the background
        </div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={prefs.notifyDm}
        role="switch"
        aria-checked={prefs.notifyDm}
        aria-label="DM notifications"
        onclick={() => patch({ notifyDm: !prefs.notifyDm })}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Quiet hours</div>
        <div class="sd">Mute non-urgent notifications 6 PM – 8 AM</div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={prefs.quietHours}
        role="switch"
        aria-checked={prefs.quietHours}
        aria-label="Quiet hours"
        onclick={() => patch({ quietHours: !prefs.quietHours })}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Sound effects</div>
        <div class="sd">Subtle sends & completion sounds</div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={prefs.sounds}
        role="switch"
        aria-checked={prefs.sounds}
        aria-label="Sound effects"
        onclick={() => patch({ sounds: !prefs.sounds })}
      ></button>
    </div>
    <!-- OS authorization is separate from the in-app toggles above (v1 UX).
         Hidden until the first non-unknown read resolves. Desktop-only. -->
    {#if canTray && notifPermission && notifPermission !== "unknown" && notifPermission !== "unsupported"}
      <div class="set-row">
        <div>
          <div class="sn">System permission</div>
          <div class="sd">
            {#if notifPermission === "granted"}
              macOS is allowing notifications from HQ
            {:else if notifPermission === "denied"}
              Blocked in macOS — open System Settings to allow
            {:else}
              Not enabled yet — allow to see message alerts
            {/if}
            {#if notifPermissionError}
              <div
                class="sd"
                role="alert"
                data-testid="settings-notification-permission-error"
              >
                {notifPermissionError}
              </div>
            {/if}
          </div>
        </div>
        {#if notifPermission === "granted"}
          <span class="mono ok">Enabled</span>
        {:else}
          <button
            type="button"
            class="chip"
            onclick={() => void enableNotifications()}
            disabled={notifRequesting}
            aria-busy={notifRequesting}
          >
            {#if notifRequesting}
              Requesting…
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
  {:else if section === "sync" && canSync}
    <div class="set-row">
      <div>
        <div class="sn">HQ folder</div>
        <div class="sd mono-path">{formatHqFolderMeta(hqFolder) || "~/hq"}</div>
      </div>
      <span class="mono">{hqFolder ? "LOCAL" : "DEFAULT"}</span>
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
        class:on={prefs.syncOnLaunch}
        role="switch"
        aria-checked={prefs.syncOnLaunch}
        aria-label="Sync on launch"
        onclick={() => patch({ syncOnLaunch: !prefs.syncOnLaunch })}
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
        class:on={prefs.autoSync}
        role="switch"
        aria-checked={prefs.autoSync}
        aria-label="Auto-sync"
        onclick={() => patch({ autoSync: !prefs.autoSync })}
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
        class:on={prefs.instantSync}
        role="switch"
        aria-checked={prefs.instantSync}
        aria-label="Instant sync"
        onclick={() => patch({ instantSync: !prefs.instantSync })}
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
        class:on={prefs.syncPersonalVault}
        role="switch"
        aria-checked={prefs.syncPersonalVault}
        aria-label="Sync personal vault"
        onclick={() => patch({ syncPersonalVault: !prefs.syncPersonalVault })}
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
          <div class="sn">Meeting detection</div>
          <div class="sd">
            Detect active meeting apps and surface recording actions
          </div>
        </div>
        <button
          type="button"
          class="toggle"
          class:on={prefs.meetingDetection}
          role="switch"
          aria-checked={prefs.meetingDetection}
          aria-label="Meeting detection"
          onclick={() => patch({ meetingDetection: !prefs.meetingDetection })}
        ></button>
      </div>
      <div class="set-row">
        <div>
          <div class="sn">Platforms</div>
          <div class="sd">Which meeting apps are watched</div>
        </div>
        <div class="theme-pills">
          {#each MEETING_PLATFORM_ORDER as name (name)}
            <button
              type="button"
              class="chip"
              class:on={prefs.meetingPlatforms[name]}
              aria-pressed={prefs.meetingPlatforms[name]}
              onclick={() => togglePlatform(name)}
            >
              {name}
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
      {#if companyOptions.length > 0}
        <label class="sr-only" for="recording-company">Recording company</label>
        <select
          id="recording-company"
          class="mono-select"
          value={recordingCompany?.id ?? ""}
          onchange={(event) => setRecordingCompany(event.currentTarget.value)}
        >
          {#each companyOptions as row (row.id)}
            <option value={row.id}>{row.name}</option>
          {/each}
        </select>
      {:else}
        <span class="mono">Personal</span>
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
          Install app, HQ Core, and CLI updates in the background
        </div>
      </div>
      <button
        type="button"
        class="toggle"
        class:on={prefs.autoUpdates}
        role="switch"
        aria-checked={prefs.autoUpdates}
        aria-label="Automatic updates"
        onclick={() => patch({ autoUpdates: !prefs.autoUpdates })}
      ></button>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">Desktop app</div>
        <div class="sd mono-path">v{appVersion}</div>
      </div>
      <span class="mono ok">This window</span>
    </div>
    <div class="set-row">
      <div>
        <div class="sn">HQ Core</div>
        <div class="sd mono-path">
          {coreVersion ? `v${coreVersion}` : "Not detected"}
        </div>
      </div>
      <span class="mono" class:ok={Boolean(coreVersion)}
        >{coreVersion ? "Up to date" : "LOCAL"}</span
      >
    </div>
    <div class="set-row">
      <div>
        <div class="sn">HQ CLI</div>
        <div class="sd mono-path">
          {cliVersion ? `v${cliVersion}` : "Not checked"}
        </div>
      </div>
      <span class="mono" class:ok={Boolean(cliVersion)}
        >{cliVersion ? "Up to date" : "—"}</span
      >
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
