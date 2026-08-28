/**
 * Capability flags — explicit per-platform availability for features whose
 * support diverges between web and desktop. UI reads these to decide whether
 * to render a feature, render it degraded, or hide it.
 */

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
   * must inset its wordmark to clear them); web → false (no controls, so the
   * wordmark sits flush-left).
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
