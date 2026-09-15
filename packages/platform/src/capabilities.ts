/**
 * Capability flags — explicit per-platform availability for features whose
 * support diverges across the four host targets. UI reads these to decide
 * whether to render a feature, render it degraded, or hide it.
 *
 * Web, desktop and mobile share ONE Svelte source. A component that behaves
 * differently per platform branches on a flag from this table; it never forks
 * into a per-platform file.
 */

/** Every host target the one shared shell runs on. */
export const HOST_PLATFORMS = ["web", "desktop", "ios", "android"] as const;

export type HostPlatform = (typeof HOST_PLATFORMS)[number];

/** Phone targets. Useful for the many flags iOS and Android share. */
export function isMobile(platform: HostPlatform): boolean {
  return platform === "ios" || platform === "android";
}

export interface Capabilities {
  /** Browse/read local HQ files (listDir, revealInFinder, previews). */
  localFiles: boolean;
  /** Launch local agent sessions / Claude Code (alias of canLaunchApps intent). */
  agentLaunch: boolean;
  /** Run the local sync daemon. */
  canSync: boolean;
  /** Launch external apps: editors, terminals, Claude Code. */
  canLaunchApps: boolean;
  /** Self-update the app / core / CLI. */
  canSelfUpdate: boolean;
  /** Install/update/uninstall local HQ packages. */
  canManagePackages: boolean;
  /** Spawn and list local agent sessions. */
  canSpawnSessions: boolean;
  /** Install marketplace packs onto the local machine. */
  canInstallLocally: boolean;
  /** Native OS notifications. */
  osNotifications: boolean;
  /** Tray icon + native window management. */
  trayAndWindow: boolean;
  /**
   * Native window controls (macOS traffic lights / Windows caption buttons)
   * are drawn by the host OS over the app chrome. Desktop → true (the titlebar
   * must inset its wordmark to clear them); web and mobile → false (no such
   * controls, so the wordmark sits flush-left).
   */
  hasWindowControls: boolean;
  /**
   * Read the on-disk work-mesh cache (~/.hq/work-mesh/cache) and HQ
   * fabric-genesis sidecars. Desktop only — browsers cannot see ~/.hq.
   */
  localWorkMeshCache: boolean;
}

export type Capability = keyof Capabilities;

export const WEB_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  localFiles: false,
  agentLaunch: false,
  canSync: false,
  canLaunchApps: false,
  canSelfUpdate: false,
  canManagePackages: false,
  canSpawnSessions: false,
  canInstallLocally: false,
  // Browsers have the Notification API; the web adapter maps to it.
  osNotifications: true,
  trayAndWindow: false,
  // Web runs in a browser tab — no OS window controls over the app chrome.
  hasWindowControls: false,
  localWorkMeshCache: false,
});

export const TAURI_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  localFiles: true,
  agentLaunch: true,
  canSync: true,
  canLaunchApps: true,
  canSelfUpdate: true,
  canManagePackages: true,
  canSpawnSessions: true,
  canInstallLocally: true,
  osNotifications: true,
  trayAndWindow: true,
  // Desktop is a native window with OS-drawn traffic lights / caption buttons.
  hasWindowControls: true,
  localWorkMeshCache: true,
});

/**
 * Mobile shares the desktop's *native shell* but almost none of the desktop's
 * *machine access*. A phone has no HQ checkout to read, no daemon to run, no
 * editor or terminal to launch, and no local package store — so every
 * local-machine capability is false even though this is a Tauri host.
 *
 * `canSelfUpdate` is false for a different reason worth stating plainly: the
 * app stores own the update path on both platforms, so an in-app updater would
 * be both redundant and, on iOS, against policy.
 *
 * iOS and Android agree on every flag today, so they share one frozen table
 * rather than two copies that could drift apart silently. They stay separate
 * *exports* because the first genuine divergence should be a one-line change
 * here, not a refactor of every call site.
 */
const MOBILE_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  localFiles: false,
  agentLaunch: false,
  canSync: false,
  canLaunchApps: false,
  canSelfUpdate: false,
  canManagePackages: false,
  canSpawnSessions: false,
  canInstallLocally: false,
  // Both platforms have real OS notification centres; Tauri's notification
  // plugin maps onto them.
  osNotifications: true,
  // No tray, and no OS-drawn controls over the app chrome.
  trayAndWindow: false,
  hasWindowControls: false,
  localWorkMeshCache: false,
});

export const IOS_CAPABILITIES = MOBILE_CAPABILITIES;
export const ANDROID_CAPABILITIES = MOBILE_CAPABILITIES;

/**
 * The one place a host platform becomes a capability set.
 *
 * The switch is exhaustive over `HostPlatform`: adding a variant without a
 * table here is a compile error, not a runtime surprise in the UI.
 */
export function capabilitiesFor(
  platform: HostPlatform,
): Readonly<Capabilities> {
  switch (platform) {
    case "web":
      return WEB_CAPABILITIES;
    case "desktop":
      return TAURI_CAPABILITIES;
    case "ios":
      return IOS_CAPABILITIES;
    case "android":
      return ANDROID_CAPABILITIES;
    default: {
      const unreachable: never = platform;
      throw new Error(`unhandled host platform: ${String(unreachable)}`);
    }
  }
}
