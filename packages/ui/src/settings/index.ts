/**
 * Settings area — SettingsPage plus its popout/setup satellites, ported from
 * desktop-alt pages/ + components/ onto the @hq/platform adapter seam.
 */

export * from "./settings-sections";
export * from "./setup-launch";
export * from "./launch-actions";
export * from "./claude-code-link";
export * from "./pending-update";
export * from "./update-presentation";
export {
  updateStore,
  checkDesktopUpdates,
  downloadDesktopUpdate,
  restartToUpdate,
  hydrateDownloadedUpdate,
  resetUpdateStore,
  reportDownloadProgress,
  markDownloaded,
  markInstallStarted,
  reportInstallFailed,
  reportIdleWait,
  setAutoUpdateEnabled,
  applyAvailableUpdate,
  applyRecommendBanner,
  dismissRecommendBanner,
  clearRecommendBanner,
  installRecommendedUpdate,
  orchestrationAdapterFrom,
} from "./update-store.svelte.js";
export * from "./appearance-seam";

export { default as SettingsPage } from "./SettingsPage.svelte";
export { default as ShellSettings } from "./ShellSettings.svelte";
export type { ShellSettingsProfile } from "./ShellSettings.svelte";
export { default as CompaniesSettingsPane } from "./CompaniesSettingsPane.svelte";
export {
  settingsCompanyLists,
  applyColorTheme,
  applyWindowOpacity,
  readStoredTheme,
} from "./shell-settings-model.js";
export { readSettingsPrefs } from "./settings-prefs.js";
export { createShellAppearanceSeam } from "./settings-theme-seam.js";
export {
  readLiveSyncStatus,
  parseLiveSyncStatus,
  lastSyncLabelFromLive,
  syncStateFromLive,
  EMPTY_LIVE_SYNC,
} from "./live-sync-status.js";
export type { LiveSyncStatus } from "./live-sync-status.js";
export type {
  TelemetryConsentStatus,
  TelemetrySeam,
  MeetingPermissionsState,
} from "./SettingsPage.svelte";
export { default as SetupIncompleteCard } from "./SetupIncompleteCard.svelte";
export { default as VersionPopout } from "./VersionPopout.svelte";
